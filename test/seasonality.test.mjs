import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  centredTrend,
  seasonalIndex,
  seasonalSaving,
  MONTH_NAMES,
  MEANINGFUL_AMPLITUDE,
} from '../src/seasonality.js';

const closeTo = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${expected}, got ${actual}`);

/** A clean synthetic series: known trend times known seasonal factors. */
function synthesise({ months, startLevel, monthlyGrowth, factors, startMonth = 0 }) {
  return Array.from({ length: months }, (_, i) => {
    const trend = startLevel * (1 + monthlyGrowth) ** i;
    return trend * factors[(startMonth + i) % 12];
  });
}

describe('centredTrend', () => {
  test('reproduces a straight line exactly', () => {
    const series = Array.from({ length: 40 }, (_, i) => 1000 + i * 10);
    const trend = centredTrend(series);

    // A centred average of a linear series is the series itself.
    for (let i = 6; i < 34; i++) closeTo(trend[i], series[i], 1e-6);
  });

  test('leaves the first and last six months undefined', () => {
    const trend = centredTrend(Array.from({ length: 30 }, () => 100));
    for (let i = 0; i < 6; i++) assert.equal(trend[i], null);
    for (let i = 24; i < 30; i++) assert.equal(trend[i], null);
    assert.notEqual(trend[6], null);
  });

  test('averages away a pure seasonal cycle, leaving the level', () => {
    // Twelve factors that multiply to a mean of 1 around a flat level.
    const factors = [0.9, 0.95, 1.0, 1.05, 1.1, 1.05, 1.0, 0.95, 0.9, 1.0, 1.05, 1.05];
    const mean = factors.reduce((a, b) => a + b, 0) / 12;
    const series = synthesise({ months: 48, startLevel: 100, monthlyGrowth: 0, factors });

    const trend = centredTrend(series);
    for (let i = 6; i < 42; i++) closeTo(trend[i], 100 * mean, 1e-6);
  });

  test('a gap in the data blocks only the windows that need it', () => {
    const series = Array.from({ length: 40 }, () => 100);
    series[20] = null;

    const trend = centredTrend(series);
    // Every window covering index 20 is unusable; ones clear of it are fine.
    assert.equal(trend[20], null);
    assert.equal(trend[14], null);
    assert.equal(trend[26], null);
    assert.notEqual(trend[13], null);
    assert.notEqual(trend[27], null);
  });
});

describe('seasonalIndex', () => {
  test('recovers the factors it was built from', () => {
    const factors = [0.96, 0.97, 0.99, 1.0, 1.01, 1.02, 1.04, 1.03, 1.01, 1.0, 0.98, 0.97];
    const normalised = (() => {
      const mean = factors.reduce((a, b) => a + b, 0) / 12;
      return factors.map((f) => f / mean);
    })();

    const series = synthesise({ months: 120, startLevel: 1500, monthlyGrowth: 0, factors });
    const result = seasonalIndex(series, 0);

    assert.ok(result, 'expected an index');
    for (let m = 0; m < 12; m++) closeTo(result.index[m], normalised[m], 1e-6);
  });

  test('recovers them through a strong upward trend', () => {
    // This is the whole point of dividing by a centred moving average: a series
    // that grows 0.5% a month must not have that growth read as seasonality.
    const factors = [0.95, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06, 1.05, 1.02, 1.0, 0.97, 0.95];
    const series = synthesise({ months: 144, startLevel: 1200, monthlyGrowth: 0.005, factors });

    const result = seasonalIndex(series, 0);
    assert.ok(result);

    const mean = factors.reduce((a, b) => a + b, 0) / 12;
    for (let m = 0; m < 12; m++) closeTo(result.index[m], factors[m] / mean, 1e-3);

    assert.equal(result.cheapest, 0, 'January should be cheapest');
    assert.equal(result.dearest, 6, 'July should be dearest');
  });

  test('the index always averages to 1', () => {
    const factors = [0.9, 1.2, 1.0, 1.1, 0.95, 1.05, 1.0, 0.98, 1.02, 1.0, 0.99, 1.01];
    const series = synthesise({ months: 120, startLevel: 900, monthlyGrowth: 0.002, factors });

    const { index } = seasonalIndex(series, 0);
    closeTo(index.reduce((a, b) => a + b, 0) / 12, 1, 1e-9);
  });

  test('honours the calendar month the series starts on', () => {
    const factors = [0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0];
    // Start in July: the cheapest calendar month is still January.
    const series = synthesise({ months: 120, startLevel: 1000, monthlyGrowth: 0, factors, startMonth: 6 });

    const result = seasonalIndex(series, 6);
    assert.equal(result.cheapest, 0, `expected January, got ${MONTH_NAMES[result.cheapest]}`);
    assert.equal(result.dearest, 6, `expected July, got ${MONTH_NAMES[result.dearest]}`);
  });

  test('a flat series has essentially no amplitude', () => {
    const series = Array.from({ length: 120 }, () => 1000);
    const result = seasonalIndex(series, 0);

    assert.ok(result.amplitude < 1e-9, `expected no swing, got ${result.amplitude}`);
  });

  test('refuses a series too short to average a calendar month', () => {
    // 24 months leaves only 12 usable ratios — one per calendar month, so fewer
    // than the three years demanded.
    assert.equal(seasonalIndex(Array.from({ length: 24 }, () => 100), 0), null);
  });

  test('refuses when gaps starve one calendar month', () => {
    const series = synthesise({
      months: 120, startLevel: 1000, monthlyGrowth: 0,
      factors: Array.from({ length: 12 }, () => 1),
    });
    // Blank out every March.
    for (let i = 2; i < series.length; i += 12) series[i] = null;

    assert.equal(seasonalIndex(series, 0), null);
  });
});

describe('seasonalSaving', () => {
  test('values the swing against the mid-point of the cycle', () => {
    const index = [0.98, 0.99, 1.0, 1.0, 1.01, 1.01, 1.02, 1.02, 1.0, 1.0, 0.99, 0.98];
    const { monthly, annual } = seasonalSaving(index, 2000);

    // Peak-to-trough is 4% of the trend level, and the mid-point of 0.98/1.02 is
    // exactly 1.0, so the trend level here is the rent itself.
    closeTo(monthly, 2000 * 0.04, 1e-6);
    closeTo(annual, monthly * 12, 1e-6);
  });

  test('scales with rent', () => {
    const index = [0.97, 1, 1, 1, 1, 1, 1.03, 1, 1, 1, 1, 1];
    assert.ok(seasonalSaving(index, 4000).monthly > seasonalSaving(index, 2000).monthly);
  });
});

/**
 * The committed dataset is what the page serves, so its shape and its internal
 * consistency are worth pinning independently of the maths that produced it.
 */
describe('the committed rent history', () => {
  const data = JSON.parse(
    readFileSync(new URL('../data/rent-history.json', import.meta.url), 'utf8'),
  );

  test('covers a plausible number of counties', () => {
    assert.ok(data.counties.length > 900, `only ${data.counties.length} counties`);
    assert.ok(data.seasonalCount > 400, `only ${data.seasonalCount} with a seasonal index`);
  });

  test('every seasonal index has twelve entries averaging 1', () => {
    for (const county of data.counties) {
      if (!county.season) continue;
      assert.equal(county.season.length, 12, `${county.name} has ${county.season.length} months`);

      const mean = county.season.reduce((a, b) => a + b, 0) / 12;
      // Values are rounded to three decimals on the way out, so allow for that.
      assert.ok(Math.abs(mean - 1) < 0.002, `${county.name} index averages ${mean}`);
    }
  });

  test('cheapest and dearest agree with the index they came from', () => {
    for (const county of data.counties) {
      if (!county.season) continue;

      const min = Math.min(...county.season);
      const max = Math.max(...county.season);
      assert.equal(county.season[county.cheapest], min, `${county.name} cheapest month is wrong`);
      assert.equal(county.season[county.dearest], max, `${county.name} dearest month is wrong`);
      assert.ok(Math.abs(county.amplitude - (max - min)) < 0.002, `${county.name} amplitude`);
    }
  });

  test('the meaningful flag matches the threshold', () => {
    for (const county of data.counties) {
      if (!county.season) continue;
      assert.equal(
        Boolean(county.meaningful),
        county.amplitude >= MEANINGFUL_AMPLITUDE,
        `${county.name} meaningful flag disagrees with its amplitude`,
      );
    }
  });

  test('amplitudes stay in a believable range', () => {
    for (const county of data.counties) {
      if (!county.season) continue;
      // A county whose rent halves and doubles within a year is a parse error,
      // not a housing market.
      assert.ok(county.amplitude < 0.5, `${county.name} swings ${county.amplitude}`);
    }
  });

  test('every county has history to chart', () => {
    for (const county of data.counties) {
      assert.equal(county.history.length, data.historyMonths, `${county.name} history length`);
      assert.ok(
        county.history.some((v) => v !== null),
        `${county.name} has no observations at all`,
      );
      for (const v of county.history) {
        if (v !== null) assert.ok(v > 100 && v < 30_000, `${county.name} rent ${v}`);
      }
    }
  });

  test('records the smoothing caveat that makes these figures conservative', () => {
    assert.match(data.source.caveat, /smooth/i);
    assert.match(data.method, /centred moving average/i);
  });
});
