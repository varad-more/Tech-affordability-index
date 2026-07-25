#!/usr/bin/env node
/**
 * Build the rent-history and seasonality dataset the timing page draws.
 *
 * The county ZORI file carries 138 monthly columns going back to 2015, and the
 * affordability model reads exactly two of them: the latest month and the one a
 * year before. Everything else in that file is history nobody was using — which
 * is a shame, because it answers a question the rest of the site cannot: not
 * *where* to move, but *when*.
 *
 * Two things come out of it, per county:
 *
 *   history      the last N months of actual rent, for the trend chart
 *   seasonality  a twelve-value index of how rent moves through the calendar
 *                year once the trend is removed
 *
 * Fails loudly, like every ingest here.
 *
 *   node scripts/build-rent-history.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsvLine } from '../src/csv.js';
import { seasonalIndex, MEANINGFUL_AMPLITUDE } from '../src/seasonality.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'rent-history.json');
const BASEMAP = join(ROOT, 'data', 'us-basemap.json');

const SOURCE = {
  name: 'Zillow Observed Rent Index (ZORI), county level, full monthly history',
  url: 'https://files.zillowstatic.com/research/public_csvs/zori/County_zori_uc_sfrcondomfr_sm_month.csv',
  homepage: 'https://www.zillow.com/research/data/',
  metric: 'Smoothed asking rent, all home types, monthly',
  caveat:
    'ZORI is a smoothed index, and smoothing damps exactly the within-year movement ' +
    'measured here. These amplitudes are therefore conservative.',
};

/** Months of actual rent kept per county for the trend chart. */
const HISTORY_MONTHS = 72;

/** A calendar month needs at least this many observations to enter the index. */
const MIN_YEARS = 3;

const METADATA_COLUMNS = 9;
const COL = { regionName: 2, regionType: 3, state: 5, metro: 6, stateFips: 7, countyFips: 8 };

function fail(message) {
  console.error(`\n  build failed: ${message}\n`);
  process.exit(1);
}

async function main() {
  const basemap = JSON.parse(await readFile(BASEMAP, 'utf8'));
  const geoByFips = new Map(basemap.counties.map((c) => [c.id, c]));

  console.log(`Fetching ${SOURCE.url}`);
  const response = await fetch(SOURCE.url);
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText} from Zillow`);

  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) fail(`expected a CSV body, got ${text.length} bytes`);

  const header = parseCsvLine(lines[0]);
  const months = header.slice(METADATA_COLUMNS);
  if (months.length < 48) fail(`only ${months.length} monthly columns — expected years of history`);

  // Calendar month of the first column, so the index can be keyed to real months
  // rather than to positions in this particular file.
  const startMonth = new Date(`${months[0]}T00:00:00Z`).getUTCMonth();
  if (Number.isNaN(startMonth)) fail(`unparseable first month column "${months[0]}"`);

  console.log(`  ${lines.length - 1} rows, ${months.length} months (${months[0]} to ${months.at(-1)})`);

  const counties = [];
  let noSeasonality = 0;

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[COL.regionType] !== 'county') continue;

    const fips =
      cells[COL.stateFips].padStart(2, '0') + cells[COL.countyFips].padStart(3, '0');
    const geo = geoByFips.get(fips);
    if (!geo) continue;

    const series = cells.slice(METADATA_COLUMNS).map((v) => (v === '' ? null : Number(v)));
    if (series.some((v) => v !== null && !Number.isFinite(v))) {
      fail(`${geo.name} has a non-numeric rent value`);
    }

    const season = seasonalIndex(series, startMonth, MIN_YEARS);
    if (!season) noSeasonality++;

    // Round first, then classify. Deriving `meaningful` from the full-precision
    // amplitude while publishing a rounded one lets a county sitting exactly on
    // the threshold contradict itself in the committed file.
    const amplitude = season ? Math.round(season.amplitude * 10000) / 10000 : null;

    const recent = series.slice(-HISTORY_MONTHS);
    // A county with no recent observation cannot be charted at all.
    if (recent.every((v) => v === null)) continue;

    counties.push({
      fips,
      name: geo.name,
      st: geo.st,
      metro: cells[COL.metro] || null,
      history: recent.map((v) => (v === null ? null : Math.round(v))),
      ...(season
        ? {
            // Three decimals is a tenth of a percent — finer than the data
            // supports, and far finer than anyone acts on.
            season: season.index.map((v) => Math.round(v * 1000) / 1000),
            amplitude,
            cheapest: season.cheapest,
            dearest: season.dearest,
            meaningful: amplitude >= MEANINGFUL_AMPLITUDE,
          }
        : {}),
    });
  }

  if (counties.length < 900) fail(`only ${counties.length} counties built — expected roughly 1,300`);

  const withSeason = counties.filter((c) => c.season);
  const meaningful = withSeason.filter((c) => c.meaningful);

  // If the decomposition produced nothing usable, something is wrong with the
  // maths rather than with the world.
  if (withSeason.length < counties.length * 0.5) {
    fail(`only ${withSeason.length} of ${counties.length} counties yielded a seasonal index`);
  }

  counties.sort((a, b) => a.fips.localeCompare(b.fips));

  const payload = {
    source: SOURCE,
    method:
      'Classical multiplicative decomposition: value divided by a 12-month centred ' +
      'moving average, averaged by calendar month, normalised to mean 1.0.',
    fetchedAt: new Date().toISOString(),
    firstMonth: months.at(-HISTORY_MONTHS) ?? months[0],
    lastMonth: months.at(-1),
    historyMonths: HISTORY_MONTHS,
    countyCount: counties.length,
    seasonalCount: withSeason.length,
    meaningfulCount: meaningful.length,
    counties,
  };

  const json = `${JSON.stringify(payload, null, 0)}\n`;
  await writeFile(OUT, json);

  const amps = meaningful.map((c) => c.amplitude).sort((a, b) => a - b);
  const median = amps.length ? amps[Math.floor(amps.length / 2)] : 0;

  console.log(`\n  wrote ${counties.length} counties -> data/rent-history.json (${(json.length / 1024).toFixed(0)} KB)`);
  console.log(`  with a seasonal index : ${withSeason.length}`);
  console.log(`  swing >= ${(MEANINGFUL_AMPLITUDE * 100).toFixed(1)}%        : ${meaningful.length}`);
  console.log(`  too short to decompose: ${noSeasonality}`);
  console.log(`  median swing (of those that clear the bar): ${(median * 100).toFixed(1)}%`);
}

main().catch((err) => fail(err.stack ?? String(err)));
