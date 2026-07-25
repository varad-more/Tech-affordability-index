#!/usr/bin/env node
/**
 * Regenerate the README preview images in docs/.
 *
 * Extracts the SVG straight out of the rendered page rather than re-deriving it,
 * so a preview can never drift from what the site actually draws. CSS custom
 * properties are resolved from the live page and inlined, since a standalone
 * SVG has no stylesheet to inherit from.
 *
 * Dev-only: needs the Playwright dev dependency. Run `npm run previews`.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4179; // deliberately not the dev port, so this never fights a running server
const ORIGIN = `http://localhost:${PORT}`;

/** Token names the exported SVG needs resolved into literal colours. */
const TOKENS = [
  'surface-1', 'ink-1', 'ink-2', 'ink-muted', 'grid', 'axis', 'accent',
  'seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5', 'seq-6', 'seq-7',
];

const TARGETS = [
  { selector: '#bars svg', file: 'preview-bars.svg', title: 'Rent burden by metro' },
  { selector: '#heatmap svg', file: 'preview-heatmap.svg', title: 'Every metro against every offer' },
];

function styleBlock(t) {
  return `
    text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .tick-line{stroke:${t.grid};stroke-width:1}
    .baseline{stroke:${t.axis};stroke-width:1}
    .axis-label{fill:${t['ink-muted']};font-size:11px}
    .cat-label{fill:${t['ink-2']};font-size:12px}
    .value-label{fill:${t['ink-2']};font-size:11px}
    .bar{fill:${t.accent}}
    .threshold-line{stroke:${t['ink-muted']};stroke-width:1.5;stroke-dasharray:4 3}
    .threshold-label{fill:${t['ink-muted']};font-size:10.5px;font-weight:600}
    .cell-value{font-size:10.5px}
  `.replace(/\s+/g, ' ').trim();
}

const server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

const shutdown = () => server.kill();
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(1); });

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  // The server needs a moment; retry rather than guess at a sleep duration.
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('.stat').first().waitFor({ timeout: 15000 });

  const tokens = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()]));
  }, TOKENS);

  for (const { selector, file, title } of TARGETS) {
    const markup = await page.locator(selector).evaluate((svg) => svg.outerHTML);
    const [, w, h] = markup.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);

    const resolved = markup
      .replace(/var\(--([a-z0-9-]+)\)/g, (_, name) => tokens[name] ?? 'transparent')
      .replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"')
      .replace(
        '>',
        `><title>${title}</title><style>${styleBlock(tokens)}</style>` +
          `<rect width="${w}" height="${h}" fill="${tokens['surface-1']}"/>`,
      );

    await writeFile(join(ROOT, 'docs', file), `${resolved}\n`);
    console.log(`  wrote docs/${file}  (${w}x${h})`);
  }

  await browser.close();
} finally {
  shutdown();
}
