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
if (outputDirIdx >= 0 && !args[outputDirIdx + 1]) {
  console.error('❌  Missing value for --output-dir');
  process.exit(1);
}
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

// ── Heading level shift ──────────────────────────────────────────────────────
// Shifts all ATX headings in an array of lines by `shift` levels.
// Positive shift makes headings deeper (## → ####); negative makes them shallower.
// Levels are clamped to [1, 6].

function shiftHeadings(lines, shift) {
  if (!shift) return lines;
  return lines.map(line => {
    const match = line.match(/^(#{1,6}) (.+)$/);
    if (!match) return line;
    const newLevel = Math.min(6, Math.max(1, match[1].length + shift));
    return '#'.repeat(newLevel) + ' ' + match[2];
  });
}

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

// ── Parse source into H2 and H3 sections ────────────────────────────────────
// H2 sections span from `## Heading` to the next `## Heading` (H3+ are included).
// H3 sections span from `### Heading` to the next `## Heading` or `### Heading`.

function normalise(heading) {
  return heading.toLowerCase().replace(/`/g, '').trim();
}

/** @type {Map<string, { original: string; lines: string[] }>} */
const sections = new Map();
/** @type {Map<string, { original: string; lines: string[] }>} */
const h3Sections = new Map();
let current = null;
let currentH3 = null;

for (const line of sourceLines) {
  const h2 = line.match(/^## (.+)$/);
  const h3 = line.match(/^### (.+)$/);
  if (h2) {
    current = { original: h2[1].trim(), lines: [] };
    sections.set(normalise(current.original), current);
    currentH3 = null;
  } else if (h3) {
    // H3 heading line is added to the parent H2 section (for full-section extraction)
    if (current !== null) {
      current.lines.push(line);
    }
    currentH3 = { original: h3[1].trim(), lines: [] };
    h3Sections.set(normalise(currentH3.original), currentH3);
  } else if (current !== null) {
    current.lines.push(line);
    if (currentH3 !== null) {
      currentH3.lines.push(line);
    }
  }
}

// Trim trailing blank lines from each section
for (const section of [...sections.values(), ...h3Sections.values()]) {
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
    const level = typeof entry === 'object' && entry.level === 3 ? 3 : 2;
    const headingShift = typeof entry === 'object' && entry.headingShift != null ? entry.headingShift : 0;

    const sectionMap = level === 3 ? h3Sections : sections;
    const section = sectionMap.get(normalise(heading));
    if (!section) {
      console.error(
        `❌  [${page.id}] H${level} section not found in ${config.source ?? 'README.md'}: "${heading}"`,
      );
      hasErrors = true;
      continue;
    }

    out.push(`## ${rename ?? section.original}`);
    if (entry.prefix) {
      out.push('');
      out.push(entry.prefix);
    }
    out.push(...convertCallouts(shiftHeadings(section.lines, headingShift)));
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
