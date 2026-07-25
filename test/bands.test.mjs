import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  grossForNet,
  salaryBands,
  classify,
  monthlyNeeds,
  assess,
  BANDS,
} from '../src/bands.js';
import { totalTax } from '../src/tax.js';
import { STATES } from '../src/tax-data.js';

const closeTo = (actual, expected, tol = 0.02) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${expected}, got ${actual}`);

describe('grossForNet', () => {
  test('inverts the tax engine — the salary it returns nets the target', () => {
    for (const state of ['CA', 'TX', 'NY', 'WA', 'MA']) {
      const target = 90_000;
      const gross = grossForNet(target, { state });
      closeTo(totalTax(gross, { state }).net, target, 0.05);
    }
  });

  test('round-trips against the forward direction at many salaries', () => {
    for (const gross of [40_000, 75_000, 120_000, 184_500, 200_000, 350_000]) {
      const net = totalTax(gross, { state: 'CA' }).net;
      closeTo(grossForNet(net, { state: 'CA' }), gross, 0.05);
    }
  });

  test('a target of zero or less needs no salary', () => {
    assert.equal(grossForNet(0, { state: 'TX' }), 0);
    assert.equal(grossForNet(-5, { state: 'TX' }), 0);
  });

  test('a higher-tax jurisdiction requires a higher gross for the same net', () => {
    const tx = grossForNet(100_000, { state: 'TX' });
    const ca = grossForNet(100_000, { state: 'CA' });
    const nyc = grossForNet(100_000, { state: 'NY', local: 'NYC' });

    assert.ok(ca > tx, 'California should need more gross than Texas');
    assert.ok(nyc > grossForNet(100_000, { state: 'NY' }), 'NYC adds city tax on top of NY');
  });

  test('stays correct across the Social Security wage cap, where net has a kink', () => {
    // Just below and just above the 2026 wage base: the marginal rate changes,
    // so an algebraic shortcut would go wrong exactly here.
    for (const gross of [184_000, 184_500, 185_000]) {
      const net = totalTax(gross, { state: 'WA' }).net;
      closeTo(grossForNet(net, { state: 'WA' }), gross, 0.05);
    }
  });

  test('is monotonic — more required net never means less required gross', () => {
    let previous = 0;
    for (let target = 20_000; target <= 300_000; target += 10_000) {
      const gross = grossForNet(target, { state: 'MN' });
      assert.ok(gross > previous, `gross fell at target ${target}`);
      previous = gross;
    }
  });
});

describe('salaryBands', () => {
  const location = { state: 'TX', local: null, rent: 1700, nonHousingMonthly: 2000 };

  test('needs is rent plus everything else', () => {
    assert.equal(monthlyNeeds(1700, 2000), 3700);
    assert.equal(salaryBands(location).monthlyNeeds, 3700);
  });

  test('thresholds ascend: survival < getting by < comfortable', () => {
    const b = salaryBands(location);
    assert.ok(b.survival < b.gettingBy, 'survival should be the lowest bar');
    assert.ok(b.gettingBy < b.comfortable, 'comfortable should be the highest bar');
  });

  test('at the survival salary, take-home exactly covers necessities', () => {
    const b = salaryBands(location);
    const net = totalTax(b.survival, { state: 'TX' }).net / 12;
    closeTo(net, b.monthlyNeeds, 0.05);
  });

  test('at the comfortable salary, necessities are exactly half of take-home', () => {
    const b = salaryBands(location);
    const net = totalTax(b.comfortable, { state: 'TX' }).net / 12;
    closeTo(b.monthlyNeeds / net, 0.5, 0.001);
  });

  test('higher rent raises every threshold', () => {
    const cheap = salaryBands({ ...location, rent: 1200 });
    const dear = salaryBands({ ...location, rent: 3200 });

    assert.ok(dear.survival > cheap.survival);
    assert.ok(dear.comfortable > cheap.comfortable);
  });

  test('non-housing costs move the thresholds too, not just rent', () => {
    const low = salaryBands({ ...location, nonHousingMonthly: 1800 });
    const high = salaryBands({ ...location, nonHousingMonthly: 2600 });

    assert.ok(
      high.comfortable > low.comfortable,
      'a metro with pricier essentials must demand a higher salary at identical rent',
    );
  });
});

describe('classify', () => {
  const needs = 4000;

  test('places a salary in the band its needs-share falls in', () => {
    assert.equal(classify(3000, needs).id, 'below-survival'); // needs > net
    assert.equal(classify(4000, needs).id, 'survival'); // needs = 100% of net
    assert.equal(classify(5000, needs).id, 'survival'); // 80%
    assert.equal(classify(6000, needs).id, 'getting-by'); // 66.7%
    assert.equal(classify(8000, needs).id, 'comfortable'); // 50%
    assert.equal(classify(12000, needs).id, 'comfortable'); // 33%
  });

  test('boundaries are inclusive of the easier band', () => {
    // Exactly 70% and exactly 50% should land on the better side of each cut.
    assert.equal(classify(needs / 0.7, needs).id, 'getting-by');
    assert.equal(classify(needs / 0.5, needs).id, 'comfortable');
  });

  test('zero or negative take-home is below survival, not an error', () => {
    assert.equal(classify(0, needs).id, 'below-survival');
    assert.equal(classify(-100, needs).id, 'below-survival');
  });

  test('every band carries a label and a description the UI renders', () => {
    for (const band of BANDS) {
      assert.ok(band.label.length > 0, `${band.id} needs a label`);
      assert.ok(band.description.length > 10, `${band.id} needs a description`);
    }
  });
});

describe('assess', () => {
  const location = { state: 'CA', local: null, rent: 3300, nonHousingMonthly: 2400 };

  test('agrees with the thresholds it reports', () => {
    const a = assess(200_000, location);
    // If the salary is above the comfortable threshold, the band must say so.
    assert.ok(a.gross > a.bands.gettingBy);
    assert.ok(['getting-by', 'comfortable'].includes(a.band.id));
  });

  test('surplus is take-home minus necessities', () => {
    const a = assess(160_000, location);
    closeTo(a.monthlySurplus, a.monthlyNet - a.monthlyNeeds);
  });

  test('a salary at the survival threshold classifies as survival', () => {
    const bands = salaryBands(location);
    assert.equal(assess(bands.survival, location).band.id, 'survival');
  });

  test('a salary at the comfortable threshold classifies as comfortable', () => {
    const bands = salaryBands(location);
    assert.equal(assess(bands.comfortable, location).band.id, 'comfortable');
  });
});

/**
 * The map paints every county in the country, so the engine must have brackets
 * for every state that appears in the data. A missing state would throw at
 * render time in someone's browser rather than here.
 */
describe('coverage of the committed county data', () => {
  const rents = JSON.parse(readFileSync(new URL('../data/county-rents.json', import.meta.url), 'utf8'));
  const wages = JSON.parse(
    readFileSync(new URL('../data/county-living-wage.json', import.meta.url), 'utf8'),
  );

  test('every state in the county rent data has a tax table', () => {
    const missing = [...new Set(rents.counties.map((c) => c.state))].filter((s) => !STATES[s]);
    assert.deepEqual(missing, [], `no tax brackets for: ${missing.join(', ')}`);
  });

  test('all 50 states plus DC are modelled', () => {
    assert.equal(Object.keys(STATES).length, 51);
  });

  test('every county with both rent and cost data produces a finite band', () => {
    const wageByFips = new Map(wages.counties.map((c) => [c.fips, c.nonHousingMonthly]));

    let checked = 0;
    for (const county of rents.counties) {
      const nonHousingMonthly = wageByFips.get(county.fips);
      if (nonHousingMonthly === undefined) continue;

      const band = classify(
        totalTax(150_000, { state: county.state }).net / 12,
        monthlyNeeds(county.rent, nonHousingMonthly),
      );
      assert.ok(band?.id, `${county.name}, ${county.state} produced no band`);
      checked++;
    }
    assert.ok(checked > 1200, `only ${checked} counties were checkable`);
  });

  test('county rents and county costs are both within sane bounds', () => {
    for (const c of rents.counties) {
      assert.ok(c.rent > 200 && c.rent < 20_000, `${c.name} rent $${c.rent}`);
      assert.match(c.fips, /^\d{5}$/, `${c.name} has a malformed FIPS "${c.fips}"`);
    }
    for (const c of wages.counties) {
      assert.ok(
        c.nonHousingMonthly > 700 && c.nonHousingMonthly < 6000,
        `${c.name} non-housing $${c.nonHousingMonthly}`,
      );
    }
  });
});
