#!/usr/bin/env node
/**
 * extract-docs.js
 *
 * Extracts H2 sections from README.md (or another markdown source) into
 * separate documentation pages, based on the mapping in docs/publish-config.json.
 * This is used to generate the docs/cli pages in the jentic-docs repository.
 *
 * Usage:
 *   node scripts/extract-docs.js [--output-dir <dir>] [--dry-run]
 *
 * Options:
 *   --output-dir <dir>   Where to write output files (default: .staging)
 *   --dry-run            Print a preview of each output file; don't write anything
 *
 * Output paths mirror the jentic-docs repository layout, e.g.
 *   .staging/docs/cli/api-scorecard.md
 *   .staging/docs/cli/api-scorecard-skill.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outputDirIdx = args.indexOf('--output-dir');
const outputDir = path.resolve(ROOT, outputDirIdx >= 0 ? args[outputDirIdx + 1] : '.staging');
const dryRun = args.includes('--dry-run');

// ── Load config ──────────────────────────────────────────────────────────────
const configPath = path.join(ROOT, 'docs', 'publish-config.json');
if (!fs.existsSync(configPath)) {
  console.error(`❌  Config not found: ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ── Load source ──────────────────────────────────────────────────────────────
const sourcePath = path.join(ROOT, config.source ?? 'README.md');
if (!fs.existsSync(sourcePath)) {
  console.error(`❌  Source not found: ${sourcePath}`);
  process.exit(1);
}
const sourceLines = fs.readFileSync(sourcePath, 'utf8').split('\n');

// ── GitHub callout → MkDocs admonition ──────────────────────────────────────
// GitHub renders `> [!TYPE]\n> content` as styled callouts; MkDocs does not.
// This function converts them to MkDocs `!!! type\n    content` admonitions.
// Supported: NOTE, TIP, IMPORTANT, WARNING, CAUTION → note, tip, important, warning, danger

const CALLOUT_MAP = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'important', WARNING: 'warning', CAUTION: 'danger' };

function convertCallouts(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const typeMatch = lines[i].match(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);
    if (typeMatch) {
      const admonitionType = CALLOUT_MAP[typeMatch[1].toUpperCase()];
      out.push(`!!! ${admonitionType}`);
      i++;
      // Collect all following `> ` lines as the admonition body
      while (i < lines.length && lines[i].startsWith('> ')) {
        out.push(`    ${lines[i].slice(2)}`);
        i++;
      }
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

// ── Parse source into H2 sections ───────────────────────────────────────────
// Each section spans from `## Heading` up to (but not including) the next `## Heading`.
// Sub-headings (H3, H4, …) are captured as part of their parent H2 section.

function normalise(heading) {
  return heading.toLowerCase().replace(/`/g, '').trim();
}

/** @type {Map<string, { original: string; lines: string[] }>} */
const sections = new Map();
let current = null;

for (const line of sourceLines) {
  const h2 = line.match(/^## (.+)$/);
  if (h2) {
    current = { original: h2[1].trim(), lines: [] };
    sections.set(normalise(current.original), current);
  } else if (current !== null) {
    current.lines.push(line);
  }
}

// Trim trailing blank lines from each section
for (const section of sections.values()) {
  while (section.lines.length > 0 && section.lines.at(-1).trim() === '') {
    section.lines.pop();
  }
}

// ── Generate pages ───────────────────────────────────────────────────────────
let hasErrors = false;

for (const page of config.pages) {
  /** @type {string[]} */
  const out = [];

  // HTML comment — not rendered by MkDocs, signals that the file is auto-generated
  out.push(
    `<!-- Auto-generated from ${config.source ?? 'README.md'} via scripts/extract-docs.js. Do not edit manually. -->`,
  );
  out.push('');

  // Page title (H1)
  out.push(`# ${page.title}`);
  out.push('');

  // Optional intro block — rendered verbatim, supports full markdown
  if (page.intro) {
    out.push(page.intro);
    out.push('');
  }

  // Extracted sections
  for (const entry of page.sections) {
    const heading = typeof entry === 'string' ? entry : entry.heading;
    const rename = typeof entry === 'object' && entry.rename ? entry.rename : null;

    const section = sections.get(normalise(heading));
    if (!section) {
      console.error(
        `❌  [${page.id}] Section not found in ${config.source ?? 'README.md'}: "${heading}"`,
      );
      hasErrors = true;
      continue;
    }

    out.push(`## ${rename ?? section.original}`);
    if (entry.prefix) {
      out.push('');
      out.push(entry.prefix);
    }
    out.push(...convertCallouts(section.lines));
    if (entry.suffix) {
      out.push('');
      out.push(entry.suffix);
    }
    out.push('');
  }

  // Related links footer
  if (page.relatedLinks?.length) {
    out.push('---');
    out.push('');
    out.push('## Related links');
    out.push('');
    for (const link of page.relatedLinks) {
      out.push(`* [${link.text}](${link.href})`);
    }
    out.push('');
  }

  const content = out.join('\n');
  const outPath = path.join(outputDir, page.output);

  if (dryRun) {
    const divider = '─'.repeat(60);
    console.log(`\n${divider}`);
    console.log(`DRY RUN ▸ ${page.output}`);
    console.log(divider);
    console.log(content.slice(0, 800) + (content.length > 800 ? '\n… (truncated)' : ''));
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`✅  ${page.output}  (${out.length} lines)`);
  }
}

if (hasErrors) {
  process.exit(1);
}
