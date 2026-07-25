#!/usr/bin/env node
/**
 * Ingest the Zillow Observed Rent Index into `data/rents.json`.
 *
 * ZORI is a smoothed, repeat-listing index of asking rents, published monthly
 * with no API key. Metro-level, all home types.
 *
 * This script FAILS LOUDLY. It never substitutes placeholder numbers when the
 * source is unreachable or malformed — the predecessor pipeline wrapped its
 * fetch in a try/except that fell back to four hardcoded rows, which meant a
 * permanently broken feed looked exactly like a working one for as long as the
 * project existed. A non-zero exit leaves the last good committed file in place,
 * which is honest: stale data still labelled with its real date.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HUBS } from '../src/hubs.js';
import { parseCsvLine } from '../src/csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'rents.json');

const SOURCE = {
  name: 'Zillow Observed Rent Index (ZORI)',
  url: 'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv',
  homepage: 'https://www.zillow.com/research/data/',
  // Named for what it actually measures. Zillow publishes no bedroom-level metro
  // series, so calling this a "1-bedroom median" — as the previous schema did —
  // would be a fabrication.
  metric: 'Smoothed asking rent, all home types (SFR + condo + multifamily), metro level',
};

const METADATA_COLUMNS = 5; // RegionID, SizeRank, RegionName, RegionType, StateName

function fail(message) {
  console.error(`\n  ingest failed: ${message}\n`);
  process.exit(1);
}

async function main() {
  console.log(`Fetching ${SOURCE.url}`);

  const response = await fetch(SOURCE.url);
  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText} from Zillow`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) fail(`expected a CSV body, got ${text.length} bytes`);

  const header = parseCsvLine(lines[0]);
  const dateColumns = header.slice(METADATA_COLUMNS);
  if (dateColumns.length === 0) fail('no month columns found in header');

  console.log(`  ${lines.length - 1} rows, ${dateColumns.length} monthly columns`);
  console.log(`  file covers ${dateColumns[0]} through ${dateColumns.at(-1)}`);

  // Index the metro rows we care about.
  const rowsByRegion = new Map();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[3] !== 'msa') continue;
    rowsByRegion.set(cells[2], cells);
  }

  const missing = HUBS.filter((h) => !rowsByRegion.has(h.zoriRegion));
  if (missing.length) {
    fail(
      `these hubs are absent from the ZORI feed: ${missing
        .map((h) => `"${h.zoriRegion}"`)
        .join(', ')}. Zillow may have renamed the metro — update src/hubs.js.`,
    );
  }

  const valueAt = (hub, colIndex) => {
    const raw = rowsByRegion.get(hub.zoriRegion)[METADATA_COLUMNS + colIndex];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  // Use the most recent month for which EVERY hub reports a value. Ranking
  // cities against each other is only meaningful if they share an observation
  // date; taking each city's own latest would silently compare across months.
  let asOfIndex = -1;
  for (let i = dateColumns.length - 1; i >= 0; i--) {
    if (HUBS.every((hub) => valueAt(hub, i) !== null)) {
      asOfIndex = i;
      break;
    }
  }
  if (asOfIndex === -1) fail('no month has data for every tracked hub');

  const asOf = dateColumns[asOfIndex];
  const lag = dateColumns.length - 1 - asOfIndex;
  if (lag > 0) {
    console.log(`  note: latest complete month is ${asOf} (${lag} behind the file's last column)`);
  }

  const yearAgoIndex = asOfIndex - 12;

  const hubs = HUBS.map((hub) => {
    const rent = valueAt(hub, asOfIndex);
    const rentYearAgo = yearAgoIndex >= 0 ? valueAt(hub, yearAgoIndex) : null;

    return {
      id: hub.id,
      city: hub.city,
      metro: hub.zoriRegion,
      state: hub.state,
      local: hub.local,
      ...(hub.note ? { note: hub.note } : {}),
      rent: Math.round(rent),
      rentYearAgo: rentYearAgo === null ? null : Math.round(rentYearAgo),
      yoy: rentYearAgo ? (rent - rentYearAgo) / rentYearAgo : null,
    };
  });

  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (previous) {
    // Never let a refresh move the dataset backwards in time.
    if (previous.asOf && previous.asOf > asOf) {
      fail(`refusing to overwrite ${previous.asOf} data with older ${asOf} data`);
    }

    // Nothing material changed, so leave the file untouched. `fetchedAt` alone
    // would otherwise rewrite the file on every poll, and each scheduled run
    // would land a commit whose only content is a new timestamp — which buries
    // the real rent movements this file exists to record.
    if (previous.asOf === asOf && JSON.stringify(previous.hubs) === JSON.stringify(hubs)) {
      console.log(`\n  already current at ${asOf} — leaving data/rents.json untouched`);
      return;
    }
  }

  const payload = {
    source: SOURCE,
    asOf,
    fetchedAt: new Date().toISOString(),
    hubCount: hubs.length,
    hubs,
  };

  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`\n  wrote ${hubs.length} hubs as of ${asOf} -> data/rents.json`);
  for (const h of [...hubs].sort((a, b) => b.rent - a.rent)) {
    const yoy = h.yoy === null ? '   n/a' : `${(h.yoy * 100).toFixed(1).padStart(5)}%`;
    console.log(`    ${h.city.padEnd(16)} $${String(h.rent).padStart(5)}   YoY ${yoy}`);
  }
}

main().catch((err) => fail(err.stack ?? String(err)));
