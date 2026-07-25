#!/usr/bin/env node
/**
 * Ingest median gross rent for EVERY US county from the Census Bureau's American
 * Community Survey (table B25064, 5-year estimates).
 *
 * Why this exists alongside the Zillow ingest: ZORI is current and monthly, but
 * Zillow only publishes it for counties with enough listing volume — about 1,360
 * of ~3,140. ACS covers essentially all of them. The two are kept as separate,
 * separately-labelled layers rather than merged, because they do not measure the
 * same thing:
 *
 *   ZORI  asking rent, all home types, EXCLUDING utilities, current month
 *   ACS   rent actually paid by sitting tenants, INCLUDING utilities,
 *         a five-year average centred about two years back
 *
 * A single national multiplier converting one to the other was tested and
 * rejected: correlation is only 0.675, median error 11% and 90th-percentile
 * error 27%, with Pitkin County (Aspen) off by a factor of nine. An 11% error in
 * rent moves the salary thresholds by roughly the same proportion, which is tens
 * of thousands of dollars — so no calibration is applied and no county's rent is
 * ever estimated from another source.
 *
 * Note that ACS gross rent INCLUDES utilities and ZORI does not, and MIT's
 * non-housing budget excludes them too (they sit inside MIT's housing row, which
 * this project discards). So the ACS basis is the more complete measure of what
 * a month actually costs; the ZORI basis omits utilities.
 *
 * Keyless: the Census data API now requires a key, but the table-based summary
 * files are served over plain HTTP.
 *
 *   node scripts/fetch-acs-rents.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'county-acs-rents.json');
const BASEMAP = join(ROOT, 'data', 'us-basemap.json');

const VINTAGE = '2023';

const SOURCE = {
  name: 'US Census Bureau, American Community Survey 5-year estimates',
  table: 'B25064 — Median Gross Rent',
  url: `https://www2.census.gov/programs-surveys/acs/summary_file/${VINTAGE}/table-based-SF/data/5YRData/acsdt5y${VINTAGE}-b25064.dat`,
  homepage: 'https://www.census.gov/programs-surveys/acs',
  metric:
    'Median gross rent (contract rent plus utilities) paid by renter-occupied units, ' +
    `${Number(VINTAGE) - 4}-${VINTAGE} five-year estimate`,
  coverage: 'All US counties and county-equivalents',
};

/** Census null sentinels: negative nine-digit codes, not real values. */
const isSentinel = (n) => !Number.isFinite(n) || n <= 0;

/** County summary level in an ACS GEO_ID. */
const COUNTY_PREFIX = '0500000US';

function fail(message) {
  console.error(`\n  ingest failed: ${message}\n`);
  process.exit(1);
}

async function main() {
  const basemap = JSON.parse(await readFile(BASEMAP, 'utf8'));
  const known = new Set(basemap.counties.map((c) => c.id));

  console.log(`Fetching ${SOURCE.url}`);
  const response = await fetch(SOURCE.url);
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText} from the Census Bureau`);

  const text = await response.text();
  const lines = text.split('\n');

  const header = lines[0]?.trim();
  if (!header?.startsWith('GEO_ID|B25064_E001')) {
    fail(`unexpected header layout: "${header?.slice(0, 60)}"`);
  }

  console.log(`  ${(text.length / 1048576).toFixed(1)} MB, ${lines.length - 1} rows`);

  const counties = [];
  let sentinels = 0;

  for (const line of lines) {
    if (!line.startsWith(COUNTY_PREFIX)) continue;

    const [geoId, estimate, margin] = line.split('|');
    const fips = geoId.slice(COUNTY_PREFIX.length);
    // Territories appear in ACS but not in this project's basemap.
    if (!known.has(fips)) continue;

    const rent = Number(estimate);
    if (isSentinel(rent)) {
      sentinels++;
      continue;
    }

    const moe = Number(margin);
    counties.push({
      fips,
      rent: Math.round(rent),
      // The margin of error is carried through rather than dropped: on a small
      // rural county it can be a large fraction of the estimate, and a reader
      // comparing two counties deserves to know which figure is shaky.
      moe: isSentinel(moe) ? null : Math.round(moe),
    });
  }

  if (counties.length < 3000) {
    fail(`only ${counties.length} counties parsed — expected roughly 3,100`);
  }

  const rents = counties.map((c) => c.rent);
  if (Math.min(...rents) < 100 || Math.max(...rents) > 10000) {
    fail(`rents out of plausible range: $${Math.min(...rents)}-$${Math.max(...rents)}`);
  }

  if (counties.length !== new Set(counties.map((c) => c.fips)).size) {
    fail('duplicate county FIPS codes in the feed');
  }

  counties.sort((a, b) => a.fips.localeCompare(b.fips));

  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (previous && JSON.stringify(previous.counties) === JSON.stringify(counties)) {
    console.log('\n  unchanged — leaving data/county-acs-rents.json untouched');
    return;
  }

  const payload = {
    source: SOURCE,
    vintage: VINTAGE,
    fetchedAt: new Date().toISOString(),
    countyCount: counties.length,
    counties,
  };

  await writeFile(OUT, `${JSON.stringify(payload, null, 0)}\n`);

  const coverage = ((counties.length / basemap.counties.length) * 100).toFixed(1);
  console.log(`\n  wrote ${counties.length} counties -> data/county-acs-rents.json`);
  console.log(`  coverage    : ${coverage}% of the ${basemap.counties.length} counties on the map`);
  console.log(`  suppressed  : ${sentinels} counties with no published estimate`);
  console.log(`  rent range  : $${Math.min(...rents)}-$${Math.max(...rents)}/mo`);
}

main().catch((err) => fail(err.stack ?? String(err)));
