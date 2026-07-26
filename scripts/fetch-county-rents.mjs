#!/usr/bin/env node
/**
 * Ingest county-level ZORI into `data/county-rents.json`.
 *
 * The metro file (`fetch-rents.mjs`) drives the offer-comparison charts, which
 * only need the 21 hubs. This one drives the map, which wants the whole country.
 *
 * COVERAGE, stated plainly because it is the map's central caveat: Zillow
 * publishes ZORI for roughly 1,360 of the ~3,140 US counties — the ones with
 * enough listing volume to compute a stable index. There is no free, keyless,
 * automatable source with a rent figure for every county. HUD's Fair Market
 * Rents do cover all of them, but huduser.gov answers automated requests with an
 * AWS WAF challenge rather than data, which is precisely the failure that left
 * this project's original HUD extractor silently serving hardcoded numbers.
 *
 * So the map draws every county and shades only the ones with a real
 * observation. The rest are drawn in a distinct "no rent data" fill. Inventing a
 * number for them — interpolating from neighbours, or falling back to a state
 * average — would produce a map that looks complete and is partly fiction.
 *
 * Fails loudly, like every ingest here.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsvLine } from '../src/csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'county-rents.json');

const SOURCE = {
  name: 'Zillow Observed Rent Index (ZORI), county level',
  url: 'https://files.zillowstatic.com/research/public_csvs/zori/County_zori_uc_sfrcondomfr_sm_month.csv',
  homepage: 'https://www.zillow.com/research/data/',
  metric: 'Smoothed asking rent, all home types (SFR + condo + multifamily), county level',
  coverage:
    'Counties with sufficient listing volume for a stable index, about 1,360 of ~3,140. Counties without an observation are shown as "no rent data" rather than estimated.',
};

/** RegionID, SizeRank, RegionName, RegionType, StateName, State, Metro, StateCodeFIPS, MunicipalCodeFIPS */
const METADATA_COLUMNS = 9;

const COL = {
  regionName: 2,
  regionType: 3,
  stateName: 4,
  state: 5,
  metro: 6,
  stateFips: 7,
  countyFips: 8,
};

function fail(message) {
  console.error(`\n  ingest failed: ${message}\n`);
  process.exit(1);
}

async function main() {
  console.log(`Fetching ${SOURCE.url}`);

  const response = await fetch(SOURCE.url);
  if (!response.ok) fail(`HTTP ${response.status} ${response.statusText} from Zillow`);

  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) fail(`expected a CSV body, got ${text.length} bytes`);

  const header = parseCsvLine(lines[0]);
  if (header[COL.stateFips] !== 'StateCodeFIPS' || header[COL.countyFips] !== 'MunicipalCodeFIPS') {
    fail(
      `unexpected column layout — expected StateCodeFIPS/MunicipalCodeFIPS at ${COL.stateFips}/${COL.countyFips}, ` +
        `got "${header[COL.stateFips]}"/"${header[COL.countyFips]}"`,
    );
  }

  const dateColumns = header.slice(METADATA_COLUMNS);
  if (!dateColumns.length) fail('no month columns found in header');

  console.log(`  ${lines.length - 1} county rows, ${dateColumns.length} monthly columns`);

  const rows = lines.slice(1).map(parseCsvLine).filter((c) => c[COL.regionType] === 'county');
  if (!rows.length) fail('no rows of RegionType "county"');

  // The most recent month at least 90% of counties report. Unlike the 21-hub
  // file, demanding EVERY county would drag the whole map back to whenever the
  // thinnest county last reported.
  let asOfIndex = -1;
  for (let i = dateColumns.length - 1; i >= 0; i--) {
    const reporting = rows.filter((r) => r[METADATA_COLUMNS + i] !== '').length;
    if (reporting / rows.length >= 0.9) {
      asOfIndex = i;
      break;
    }
  }
  if (asOfIndex === -1) fail('no month is reported by at least 90% of counties');

  const asOf = dateColumns[asOfIndex];
  const yearAgoIndex = asOfIndex - 12;

  const value = (cells, index) => {
    if (index < 0) return null;
    const raw = cells[METADATA_COLUMNS + index];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const counties = [];
  for (const cells of rows) {
    const rent = value(cells, asOfIndex);
    if (rent === null) continue;

    const stateFips = cells[COL.stateFips].padStart(2, '0');
    const countyFips = cells[COL.countyFips].padStart(3, '0');
    const rentYearAgo = value(cells, yearAgoIndex);

    counties.push({
      fips: `${stateFips}${countyFips}`,
      name: cells[COL.regionName],
      state: cells[COL.state],
      metro: cells[COL.metro] || null,
      rent: Math.round(rent),
      yoy: rentYearAgo ? Math.round(((rent - rentYearAgo) / rentYearAgo) * 10000) / 10000 : null,
    });
  }

  if (counties.length < 900) {
    fail(`only ${counties.length} counties have a rent for ${asOf} — expected roughly 1,300`);
  }

  const duplicates = counties.length - new Set(counties.map((c) => c.fips)).size;
  if (duplicates) fail(`${duplicates} duplicate county FIPS codes in the feed`);

  const rents = counties.map((c) => c.rent);
  if (Math.min(...rents) < 200 || Math.max(...rents) > 20000) {
    fail(`rents out of plausible range: $${Math.min(...rents)}–$${Math.max(...rents)}`);
  }

  counties.sort((a, b) => a.fips.localeCompare(b.fips));

  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (previous) {
    if (previous.asOf && previous.asOf > asOf) {
      fail(`refusing to overwrite ${previous.asOf} data with older ${asOf} data`);
    }
    if (previous.asOf === asOf && JSON.stringify(previous.counties) === JSON.stringify(counties)) {
      console.log(`\n  already current at ${asOf} — leaving data/county-rents.json untouched`);
      return;
    }
  }

  const payload = {
    source: SOURCE,
    asOf,
    fetchedAt: new Date().toISOString(),
    countyCount: counties.length,
    counties,
  };

  await writeFile(OUT, `${JSON.stringify(payload, null, 0)}\n`);

  const states = new Set(counties.map((c) => c.state));
  console.log(`\n  wrote ${counties.length} counties as of ${asOf} -> data/county-rents.json`);
  console.log(`  spanning ${states.size} states`);
  console.log(
    `  rent range $${Math.min(...rents).toLocaleString()}–$${Math.max(...rents).toLocaleString()}/mo`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
