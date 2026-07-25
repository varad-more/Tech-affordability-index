#!/usr/bin/env node
/**
 * Ingest per-county living costs from the MIT Living Wage Calculator.
 *
 * Covers EVERY county in the United States, not only the ones with a rent index.
 * MIT publishes a budget for all of them, and a county's cost of living is worth
 * showing even where rent is unavailable — it is half the answer, and the half
 * that varies least dramatically.
 *
 * The county list comes from the committed basemap, so the data layer and the
 * map layer cannot drift apart.
 *
 * Resumable: an existing `data/county-living-wage.json` is loaded first and only
 * missing counties are fetched. A run interrupted at county 900 picks up at 900.
 *
 * Fails loudly on a parse error or an implausible figure. Individual 404s are
 * tolerated and reported — a handful of counties have no page — but the run
 * fails if more than a small fraction go missing, because that means the site
 * moved rather than that a few counties are unusual.
 *
 *   node scripts/fetch-county-living-wage.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseLivingWage, PLAUSIBLE_MONTHLY, CATEGORY_ORDER } from '../src/living-wage-parse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'county-living-wage.json');
const BASEMAP = join(ROOT, 'data', 'us-basemap.json');

const SOURCE = {
  name: 'MIT Living Wage Calculator',
  homepage: 'https://livingwage.mit.edu/',
  urlPattern: 'https://livingwage.mit.edu/counties/{fips}',
  household: '1 adult, 0 children',
  metric:
    'Annual "typical expenses" for a single adult, excluding housing. Housing is taken from ZORI instead.',
};

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

/** Concurrency and pacing. Deliberately modest — roughly 3-4 requests a second. */
const CONCURRENCY = 4;
const DELAY_MS = 200;

/** Above this share of missing pages, assume the site changed rather than the data. */
const MAX_MISSING_SHARE = 0.06;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\n  ingest failed: ${message}\n`);
  process.exit(1);
}

async function fetchCounty(county) {
  const url = SOURCE.urlPattern.replace('{fips}', county.fips);

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (err) {
      if (attempt === 2) throw new Error(`${county.name}: ${err.message}`);
      await sleep(800 * (attempt + 1));
      continue;
    }

    if (res.status === 404) return { missing: true, fips: county.fips, name: county.name };

    // Back off on rate limiting or a transient server error rather than
    // hammering, and only give up after three tries.
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 2) throw new Error(`${county.name}: HTTP ${res.status} after 3 attempts`);
      await sleep(1500 * (attempt + 1));
      continue;
    }

    if (!res.ok) throw new Error(`${county.name}: ${url} returned HTTP ${res.status}`);

    const parsed = parseLivingWage(await res.text(), county.name);
    const monthly = parsed.nonHousingMonthly;

    if (monthly < PLAUSIBLE_MONTHLY.min || monthly > PLAUSIBLE_MONTHLY.max) {
      throw new Error(`${county.name}: non-housing $${monthly}/mo is outside the plausible range`);
    }

    return {
      fips: county.fips,
      name: county.name,
      state: county.state,
      nonHousingMonthly: monthly,
      // Per-category monthly figures, rounded, in CATEGORY_ORDER. Stored as a
      // bare array rather than an object: at 1,350 counties the repeated keys
      // would roughly triple the committed file for no added meaning.
      //
      // These round independently, so they can sum to a dollar or two either
      // side of `nonHousingMonthly`. That field stays the authoritative total;
      // the components are for showing the reader where the money goes.
      e: CATEGORY_ORDER.map((k) => Math.round(parsed.expenses[k] / 12)),
    };
  }
  throw new Error(`${county.name}: exhausted retries`);
}

async function main() {
  const basemap = JSON.parse(await readFile(BASEMAP, 'utf8'));
  const allCounties = basemap.counties.map((c) => ({
    fips: c.id,
    name: c.name,
    state: c.id.slice(0, 2),
  }));

  let existing = { metros: [], counties: [] };
  try {
    existing = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Rows written before the per-category breakdown existed are re-fetched, so
  // upgrading the schema tops the file up instead of needing a manual wipe.
  const have = new Map(
    (existing.counties ?? []).filter((c) => Array.isArray(c.e)).map((c) => [c.fips, c]),
  );
  const missingKnown = new Set(existing.missing ?? []);

  const todo = allCounties.filter((c) => !have.has(c.fips) && !missingKnown.has(c.fips));

  console.log(`  counties in basemap: ${allCounties.length}`);
  console.log(`  already ingested   : ${have.size}`);
  console.log(`  to fetch           : ${todo.length}`);

  if (!todo.length) {
    console.log('\n  nothing to do — data/county-living-wage.json is complete');
    return;
  }

  const results = [...have.values()];
  const missing = [...missingKnown];
  let done = 0;
  let failure = null;

  // A fixed pool of workers pulling from one queue, so pacing is predictable
  // regardless of how fast any individual response comes back.
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !failure) {
      const county = queue.shift();
      try {
        const row = await fetchCounty(county);
        if (row.missing) missing.push(row.fips);
        else results.push(row);
      } catch (err) {
        failure ??= err;
        return;
      }

      done++;
      if (done % 50 === 0 || done === todo.length) {
        const pct = ((done / todo.length) * 100).toFixed(0);
        process.stdout.write(`\r  fetched ${done}/${todo.length} (${pct}%)  missing ${missing.length}   `);
      }
      await sleep(DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  // Save whatever completed before re-throwing, so a long run is never lost.
  const persist = async () => {
    results.sort((a, b) => a.fips.localeCompare(b.fips));
    missing.sort();
    await writeFile(
      OUT,
      `${JSON.stringify(
        {
          source: SOURCE,
          fetchedAt: new Date().toISOString(),
          countyCount: results.length,
          categories: CATEGORY_ORDER,
          missing,
          counties: results,
        },
        null,
        0,
      )}\n`,
    );
  };

  if (failure) {
    await persist();
    fail(`${failure.message}\n  (partial progress saved — rerun to resume)`);
  }

  const missingShare = missing.length / allCounties.length;
  if (missingShare > MAX_MISSING_SHARE) {
    await persist();
    fail(
      `${missing.length} of ${allCounties.length} counties had no page ` +
        `(${(missingShare * 100).toFixed(1)}%) — the site layout has probably changed`,
    );
  }

  await persist();

  const values = results.map((r) => r.nonHousingMonthly);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  console.log(`\n  wrote ${results.length} counties -> data/county-living-wage.json`);
  console.log(`  missing pages      : ${missing.length}`);
  console.log(
    `  non-housing /mo    : $${Math.min(...values).toFixed(0)}–$${Math.max(...values).toFixed(0)} (mean $${mean.toFixed(0)})`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
