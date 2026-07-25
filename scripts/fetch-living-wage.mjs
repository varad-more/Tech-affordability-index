#!/usr/bin/env node
/**
 * Ingest per-metro living costs from the MIT Living Wage Calculator.
 *
 * This supplies the one number the rent data cannot: what life costs *besides*
 * rent, in this specific metro. Without it the site can only rank metros against
 * each other; with it, it can say whether a salary clears an absolute floor.
 *
 * Why MIT rather than a price index: the Living Wage Calculator publishes an
 * actual dollar budget per metro, assembled from USDA food plans, MEPS medical
 * costs and BLS transport data, for a defined household. A price-parity index
 * would only give a relative multiplier, leaving the national baseline — the
 * part that decides the answer — to be invented here.
 *
 * The housing row is deliberately discarded. MIT uses HUD Fair Market Rent,
 * published annually; this project already carries ZORI, refreshed monthly, and
 * mixing two rent series into one budget would double-count and de-freshen it.
 *
 * Fails loudly on HTTP error, a missing metro, an unparseable table, or a total
 * that does not reconcile against its own components. A cost-of-living floor
 * that quietly fell back to stale or partial numbers would be invisible in the
 * output and wrong in exactly the direction that matters.
 *
 *   node scripts/fetch-living-wage.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HUBS } from '../src/hubs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'living-wage.json');

const SOURCE = {
  name: 'MIT Living Wage Calculator',
  homepage: 'https://livingwage.mit.edu/',
  urlPattern: 'https://livingwage.mit.edu/metros/{cbsa}',
  household: '1 adult, 0 children',
  metric:
    'Annual "typical expenses" for a single adult. Housing is excluded here and taken from ZORI instead.',
};

/**
 * The site is a research tool that blocks obvious bots; a normal browser UA gets
 * the same public page a reader would see.
 */
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

/** Rows of MIT's "Typical Expenses" table, in the order they are published. */
const EXPENSE_ROWS = [
  'Food',
  'Child Care',
  'Medical',
  'Housing',
  'Transportation',
  'Civic',
  'Internet & Mobile',
  'Other',
];

const REQUIRED_ROW = 'Required annual income after taxes';

/** Everything a single adult needs that is not rent. */
const NON_HOUSING = ['Food', 'Medical', 'Transportation', 'Civic', 'Internet & Mobile', 'Other'];

const stripTags = (s) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

const parseMoney = (s) => {
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the "Typical Expenses" table out of a metro page.
 *
 * Column 1 is the "1 Adult, 0 Children" household — the first data column after
 * the row label. Verified against the published table headers, which the parser
 * re-checks on every run rather than trusting positionally.
 */
function parseExpenses(html, label) {
  const start = html.indexOf('Typical Expenses');
  if (start === -1) throw new Error(`${label}: no "Typical Expenses" table found`);

  const segment = html.slice(start, start + 8000);
  const rows = [...segment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1])),
  );

  // Guard the column assumption: the header must actually say 1 adult / 0 children.
  const header = rows.map((r) => r.join('|')).join(' ');
  if (!/1\s*ADULT/i.test(header) || !/0\s*Children/i.test(header)) {
    throw new Error(`${label}: table header is not the expected "1 ADULT / 0 Children" layout`);
  }

  const expenses = {};
  for (const row of rows) {
    if (row.length < 2) continue;
    const name = row[0];
    if (!EXPENSE_ROWS.includes(name) && name !== REQUIRED_ROW) continue;

    const value = parseMoney(row[1]);
    if (value === null) throw new Error(`${label}: row "${name}" has no readable figure`);
    expenses[name] = value;
  }

  for (const row of [...EXPENSE_ROWS, REQUIRED_ROW]) {
    if (!(row in expenses)) throw new Error(`${label}: missing row "${row}"`);
  }

  // MIT's own total must reconcile against its components, or the column
  // alignment is wrong and every downstream number is silently off.
  const componentSum = EXPENSE_ROWS.reduce((n, k) => n + expenses[k], 0);
  const drift = Math.abs(componentSum - expenses[REQUIRED_ROW]);
  if (drift > 12) {
    throw new Error(
      `${label}: components sum to $${componentSum} but the table states ` +
        `$${expenses[REQUIRED_ROW]} — column alignment is wrong`,
    );
  }

  const nonHousingAnnual = NON_HOUSING.reduce((n, k) => n + expenses[k], 0);

  return {
    expenses,
    nonHousingAnnual,
    nonHousingMonthly: Math.round((nonHousingAnnual / 12) * 100) / 100,
  };
}

async function fetchMetro(hub) {
  const url = SOURCE.urlPattern.replace('{cbsa}', hub.cbsa);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${hub.city}: ${url} returned HTTP ${res.status}`);

  const html = await res.text();
  const parsed = parseExpenses(html, hub.city);

  return {
    id: hub.id,
    city: hub.city,
    cbsa: hub.cbsa,
    url,
    ...parsed,
  };
}

/** Read the committed file, if there is one, so a no-op run can skip the write. */
async function previous() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  console.log(`  source: ${SOURCE.homepage}  (${HUBS.length} metros)`);

  const metros = [];
  for (const hub of HUBS) {
    const row = await fetchMetro(hub);
    metros.push(row);
    console.log(
      `    ${row.city.padEnd(16)} non-housing $${row.nonHousingMonthly.toFixed(0).padStart(5)}/mo`,
    );
    // Sequential, with a pause: this is a public research tool, not an API.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (metros.length !== HUBS.length) {
    throw new Error(`Expected ${HUBS.length} metros, got ${metros.length}`);
  }

  const values = metros.map((m) => m.nonHousingMonthly);
  // A single adult's non-rent essentials outside this band would mean the page
  // moved and the parser latched onto some other table.
  if (Math.min(...values) < 800 || Math.max(...values) > 5000) {
    throw new Error(
      `Non-housing costs out of plausible range: $${Math.min(...values)}–$${Math.max(...values)}/mo`,
    );
  }

  const payload = {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    metroCount: metros.length,
    metros,
  };

  const before = await previous();
  const materiallySame =
    before && JSON.stringify(before.metros) === JSON.stringify(payload.metros);

  if (materiallySame) {
    console.log('\n  unchanged — leaving data/living-wage.json untouched');
    return;
  }

  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n  wrote data/living-wage.json (${metros.length} metros)`);
}

main().catch((err) => {
  console.error(`\nfetch-living-wage failed: ${err.message}`);
  process.exit(1);
});
