import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseLivingWage,
  EXPENSE_ROWS,
  REQUIRED_ROW,
  NON_HOUSING,
  PLAUSIBLE_MONTHLY,
} from '../src/living-wage-parse.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const SF = fixture('living-wage-sf.html');
const TRAVIS = fixture('living-wage-travis.html');

/**
 * These fixtures are real saved pages. The parser reads HTML written for people,
 * not an API, so the risk it guards against is a silent column shift — numbers
 * that still look plausible but describe a different household.
 */
describe('parseLivingWage', () => {
  test('reads every published expense row', () => {
    const { expenses } = parseLivingWage(SF, 'San Francisco');
    for (const row of [...EXPENSE_ROWS, REQUIRED_ROW]) {
      assert.ok(typeof expenses[row] === 'number', `missing row "${row}"`);
    }
  });

  test('reads the 1-adult-0-children column, not a family budget', () => {
    // The single-adult column is the only one with zero child care; every other
    // household in the table has children.
    assert.equal(parseLivingWage(SF, 'sf').expenses['Child Care'], 0);
    assert.equal(parseLivingWage(TRAVIS, 'travis').expenses['Child Care'], 0);
  });

  test("components reconcile against MIT's own stated total", () => {
    for (const [html, label] of [[SF, 'San Francisco'], [TRAVIS, 'Travis']]) {
      const { expenses } = parseLivingWage(html, label);
      const sum = EXPENSE_ROWS.reduce((n, k) => n + expenses[k], 0);
      assert.ok(
        Math.abs(sum - expenses[REQUIRED_ROW]) <= 12,
        `${label}: components ${sum} vs stated ${expenses[REQUIRED_ROW]}`,
      );
    }
  });

  test('non-housing excludes rent and includes everything else', () => {
    const { expenses, nonHousingAnnual } = parseLivingWage(SF, 'sf');
    assert.equal(nonHousingAnnual, NON_HOUSING.reduce((n, k) => n + expenses[k], 0));

    // MIT rounds each row independently, so the components and the stated total
    // can disagree by a dollar or two. That is the same rounding slack the
    // parser's reconciliation check allows.
    const fromTotal = expenses[REQUIRED_ROW] - expenses.Housing - expenses['Child Care'];
    assert.ok(
      Math.abs(nonHousingAnnual - fromTotal) <= 12,
      `${nonHousingAnnual} vs ${fromTotal} — more than rounding apart`,
    );
  });

  test('monthly is annual over twelve', () => {
    const parsed = parseLivingWage(SF, 'sf');
    assert.ok(Math.abs(parsed.nonHousingMonthly - parsed.nonHousingAnnual / 12) < 0.01);
  });

  test('an expensive metro costs more than a cheaper one', () => {
    assert.ok(
      parseLivingWage(SF, 'sf').nonHousingMonthly >
        parseLivingWage(TRAVIS, 'travis').nonHousingMonthly,
      'San Francisco should out-cost Travis County on non-housing essentials',
    );
  });

  test('both fixtures land in the plausible range', () => {
    for (const [html, label] of [[SF, 'sf'], [TRAVIS, 'travis']]) {
      const { nonHousingMonthly } = parseLivingWage(html, label);
      assert.ok(nonHousingMonthly >= PLAUSIBLE_MONTHLY.min);
      assert.ok(nonHousingMonthly <= PLAUSIBLE_MONTHLY.max);
    }
  });
});

describe('parseLivingWage failure modes', () => {
  test('throws when the table is absent rather than returning zeros', () => {
    assert.throws(() => parseLivingWage('<html><body>nope</body></html>', 'empty'), /Typical Expenses/);
  });

  test('throws when the household header is not 1 adult / 0 children', () => {
    // Global: the header appears in more than one row, and the parser scans all
    // of them, so replacing only the first would leave the check satisfied.
    const swapped = SF.replace(/1\s*ADULT/gi, '2 ADULTS');
    assert.throws(() => parseLivingWage(swapped, 'swapped'), /1 ADULT/);
  });

  test('throws when a row goes missing', () => {
    const withoutFood = SF.replace(/Food/, 'Groceries');
    assert.throws(() => parseLivingWage(withoutFood, 'no-food'), /missing row "Food"/);
  });

  test('throws when the numbers stop reconciling — the silent-column-shift guard', () => {
    // Inflate the stated total without touching its components.
    const { expenses } = parseLivingWage(SF, 'sf');
    const broken = SF.replace(
      `$${expenses[REQUIRED_ROW].toLocaleString('en-US')}`,
      '$99,999',
    );
    assert.throws(() => parseLivingWage(broken, 'broken'), /column alignment is wrong/);
  });
});

/**
 * The committed county file is what the site actually serves, so its shape is
 * worth pinning independently of the parser that produced it.
 */
describe('the committed county cost data', () => {
  const data = JSON.parse(
    readFileSync(new URL('../data/county-living-wage.json', import.meta.url), 'utf8'),
  );

  test('covers the great majority of counties that have rent data', () => {
    const rents = JSON.parse(
      readFileSync(new URL('../data/county-rents.json', import.meta.url), 'utf8'),
    );
    const coverage = data.counties.length / rents.counties.length;
    assert.ok(coverage > 0.98, `only ${(coverage * 100).toFixed(1)}% of rent counties have costs`);
  });

  test('every row has a five-digit FIPS and a plausible figure', () => {
    for (const c of data.counties) {
      assert.match(c.fips, /^\d{5}$/, `bad FIPS ${c.fips}`);
      assert.ok(c.nonHousingMonthly >= PLAUSIBLE_MONTHLY.min);
      assert.ok(c.nonHousingMonthly <= PLAUSIBLE_MONTHLY.max);
    }
  });

  test('FIPS codes are unique', () => {
    assert.equal(new Set(data.counties.map((c) => c.fips)).size, data.counties.length);
  });

  test('records the source it came from', () => {
    assert.match(data.source.homepage, /livingwage\.mit\.edu/);
    assert.equal(data.source.household, '1 adult, 0 children');
  });
});
