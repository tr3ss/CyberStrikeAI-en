#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const zhPath = path.join(root, 'web/static/i18n/zh-CN.json');
const enPath = path.join(root, 'web/static/i18n/en-US.json');
const i18nJsPath = path.join(root, 'web/static/js/i18n.js');
const agentsDir = path.join(root, 'agents');

const TRANSLATION_API_KEY =
  process.env.TRANSLATION_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
const TRANSLATION_BASE_URL =
  process.env.TRANSLATION_BASE_URL || process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || process.env.OPENAI_MODEL || 'openrouter/free';
const APP_URL = process.env.OPENROUTER_SITE_URL || process.env.GITHUB_SERVER_URL || 'https://github.com';
const APP_TITLE = process.env.OPENROUTER_APP_NAME || 'CyberStrikeAI English overlay sync';
const DRY_RUN = process.env.DRY_RUN === '1';
const SKIP_I18N_KEYS = new Set(['lang.zhCN', 'lang.enUS']);

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function getAtPath(obj, parts) {
  return parts.reduce((cursor, part) => (cursor == null ? undefined : cursor[part]), obj);
}

function setAtPath(obj, parts, value) {
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function collectMissingStrings(source, target, prefix = [], out = []) {
  if (typeof source === 'string') {
    const id = prefix.join('.');
    if (SKIP_I18N_KEYS.has(id)) return out;

    const current = getAtPath(target, prefix);
    const needsValue = typeof current !== 'string' || current === '';
    const looksUntranslated = current === source && hasChinese(source);
    if (needsValue || looksUntranslated) {
      out.push({
        id,
        path: prefix,
        text: source,
      });
    }
    return out;
  }

  if (!isObject(source)) return out;

  for (const [key, value] of Object.entries(source)) {
    collectMissingStrings(value, target, [...prefix, key], out);
  }
  return out;
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

async function translateEntries(entries, context) {
  if (entries.length === 0) return {};
  if (!TRANSLATION_API_KEY) {
    throw new Error(
      `Need TRANSLATION_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY to translate ${entries.length} ${context} string(s): ${entries
        .map((entry) => entry.id)
        .join(', ')}`
    );
  }

  const messages = [
    {
      role: 'system',
      content:
        'Translate Chinese UI and agent metadata into natural, concise English. Preserve placeholders such as {{n}}, %s, HTML tags, Markdown, product names, and security terms. Return only a JSON object whose keys are the provided ids and whose values are translated strings.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          context,
          items: entries.map((entry) => ({ id: entry.id, text: entry.text })),
        },
        null,
        2
      ),
    },
  ];

  const response = await fetch(`${TRANSLATION_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TRANSLATION_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL,
      'X-Title': APP_TITLE,
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI translation failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const outputText = (data.choices?.[0]?.message?.content || extractOutputText(data)).trim();
  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error(`Translator did not return valid JSON: ${outputText}`);
  }
}

async function updateDefaultLanguage() {
  const source = await fs.readFile(i18nJsPath, 'utf8');
  const next = source.replace(/const DEFAULT_LANG = ['"]zh-CN['"];/, "const DEFAULT_LANG = 'en-US';");
  if (next !== source) {
    if (!DRY_RUN) await fs.writeFile(i18nJsPath, next);
    console.log('Set default UI language to en-US');
  }
}

async function updateI18nJson() {
  const zh = JSON.parse(await fs.readFile(zhPath, 'utf8'));
  const en = JSON.parse(await fs.readFile(enPath, 'utf8'));
  const missing = collectMissingStrings(zh, en);
  const translatable = missing.filter((entry) => hasChinese(entry.text));
  const passthrough = missing.filter((entry) => !hasChinese(entry.text));

  for (const entry of passthrough) {
    setAtPath(en, entry.path, entry.text);
  }

  const translations = await translateEntries(translatable, 'web/static/i18n/en-US.json');
  for (const entry of translatable) {
    const translated = translations[entry.id];
    if (typeof translated !== 'string' || translated.trim() === '') {
      throw new Error(`Missing translation for ${entry.id}`);
    }
    setAtPath(en, entry.path, translated);
  }

  if (!DRY_RUN && missing.length > 0) {
    await fs.writeFile(enPath, `${JSON.stringify(en, null, 2)}\n`);
  }

  console.log(`i18n keys checked: ${missing.length} missing, ${translatable.length} translated`);
}

function parseFrontmatter(source) {
  if (!source.startsWith('---\n')) return null;
  const end = source.indexOf('\n---', 4);
  if (end === -1) return null;
  return {
    frontmatter: source.slice(4, end),
    body: source.slice(end),
  };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

async function updateAgentFrontmatter() {
  let translatedCount = 0;
  const files = (await fs.readdir(agentsDir)).filter((file) => file.endsWith('.md')).sort();

  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontmatter(source);
    if (!parsed) continue;

    const entries = [];
    for (const key of ['name', 'description']) {
      const value = frontmatterValue(parsed.frontmatter, key);
      if (value && hasChinese(value)) {
        entries.push({ id: `${file}:${key}`, key, text: value });
      }
    }

    if (entries.length === 0) continue;

    const translations = await translateEntries(entries, `agent frontmatter in ${file}`);
    let nextFrontmatter = parsed.frontmatter;
    for (const entry of entries) {
      const translated = translations[entry.id];
      if (typeof translated !== 'string' || translated.trim() === '') {
        throw new Error(`Missing translation for ${entry.id}`);
      }
      nextFrontmatter = nextFrontmatter.replace(
        new RegExp(`^${entry.key}:\\s*.*$`, 'm'),
        `${entry.key}: ${JSON.stringify(translated)}`
      );
      translatedCount += 1;
    }

    if (!DRY_RUN) {
      await fs.writeFile(filePath, `---\n${nextFrontmatter}${parsed.body}`);
    }
  }

  console.log(`Agent frontmatter checked: ${translatedCount} field(s) translated`);
}

async function reportChineseHotspots() {
  const dirs = ['web/static/js', 'web/templates'];
  const hits = [];

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(relative);
      } else if (/\.(js|html|tmpl)$/.test(entry.name)) {
        const text = await fs.readFile(path.join(root, relative), 'utf8');
        const lines = text.split('\n');
        lines.forEach((line, index) => {
          if (hasChinese(line) && hits.length < 30) {
            hits.push(`${relative}:${index + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
      }
    }
  }

  for (const dir of dirs) await walk(dir);

  if (hits.length > 0) {
    console.log('\nChinese text still present in source files, review if these are user-facing:');
    for (const hit of hits) console.log(`- ${hit}`);
  }
}

await updateDefaultLanguage();
await updateI18nJson();
await updateAgentFrontmatter();
await reportChineseHotspots();
