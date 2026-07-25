import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  progressiveTax,
  ficaTax,
  federalTax,
  stateTax,
  localTax,
  totalTax,
} from '../src/tax.js';
import { FEDERAL, FICA, STATES } from '../src/tax-data.js';

/** Money comparisons to the cent. */
const closeTo = (actual, expected, tol = 0.01, msg = '') =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );

describe('progressiveTax', () => {
  const brackets = [
    { from: 0, rate: 0.1 },
    { from: 100, rate: 0.2 },
    { from: 200, rate: 0.3 },
  ];

  test('charges each bracket only on the slice inside it', () => {
    closeTo(progressiveTax(50, brackets), 5); // 50 @10%
    closeTo(progressiveTax(100, brackets), 10); // 100 @10%
    closeTo(progressiveTax(150, brackets), 10 + 10); // +50 @20%
    closeTo(progressiveTax(200, brackets), 10 + 20); // full first two
    closeTo(progressiveTax(300, brackets), 10 + 20 + 30); // +100 @30%
  });

  test('is zero at or below zero income', () => {
    assert.equal(progressiveTax(0, brackets), 0);
    assert.equal(progressiveTax(-5000, brackets), 0);
  });

  test('returns zero for states with no brackets', () => {
    assert.equal(progressiveTax(500000, []), 0);
  });

  test('never jumps at a bracket boundary', () => {
    // Earning one dollar more must never cost more than one dollar in tax.
    for (const edge of [100, 200]) {
      const delta = progressiveTax(edge + 1, brackets) - progressiveTax(edge, brackets);
      assert.ok(delta > 0 && delta < 1, `discontinuity at ${edge}: ${delta}`);
    }
  });

  test('is monotonic across the federal schedule', () => {
    let prev = -1;
    for (let income = 0; income <= 800000; income += 5000) {
      const tax = progressiveTax(income, FEDERAL.brackets);
      assert.ok(tax >= prev, `federal tax decreased at ${income}`);
      prev = tax;
    }
  });
});

describe('federal income tax (2026, single)', () => {
  // Hand-computed against the published 2026 schedule.
  test('$100,000 gross', () => {
    // taxable 83,900 -> 12,400@10 + 38,000@12 + 33,500@22
    closeTo(federalTax(100000), 1240 + 4560 + 7370);
  });

  test('$185,000 gross', () => {
    // taxable 168,900 -> 1,240 + 4,560 + 12,166 + 15,168
    closeTo(federalTax(185000), 33134);
  });

  test('income at or below the standard deduction owes nothing', () => {
    assert.equal(federalTax(FEDERAL.standardDeduction), 0);
    assert.equal(federalTax(10000), 0);
  });
});

describe('FICA', () => {
  test('Social Security stops at the wage base', () => {
    const base = FICA.socialSecurityWageBase;
    const maxSS = base * FICA.socialSecurityRate;

    // Published 2026 maximum employee contribution.
    closeTo(maxSS, 11439);

    // Above the cap, SS contributes nothing further: the whole delta is Medicare.
    const delta = ficaTax(base + 10000) - ficaTax(base);
    closeTo(delta, 10000 * FICA.medicareRate);
  });

  test('additional Medicare applies only above the threshold', () => {
    const t = FICA.additionalMedicareThreshold;
    // At exactly the threshold the surtax has not started.
    closeTo(ficaTax(t), Math.min(t, FICA.socialSecurityWageBase) * 0.062 + t * 0.0145);

    const above = ficaTax(t + 50000) - ficaTax(t);
    closeTo(above, 50000 * (FICA.medicareRate + FICA.additionalMedicareRate));
  });

  test('$100,000 gross', () => {
    closeTo(ficaTax(100000), 6200 + 1450);
  });

  test('is zero at zero income', () => {
    assert.equal(ficaTax(0), 0);
  });
});

describe('state tax', () => {
  test('no-income-tax states owe nothing on wages', () => {
    for (const code of ['TX', 'FL', 'TN', 'NV']) {
      assert.equal(stateTax(250000, code).total, 0, `${code} should be zero`);
    }
  });

  test('Washington has no income tax but real payroll levies', () => {
    const r = stateTax(200000, 'WA');
    assert.equal(r.incomeTax, 0);

    // PFML: employee share of 1.13%, capped at the SS wage base.
    const pfml = 184500 * (0.0113 * 0.7143);
    const waCares = 200000 * 0.0058; // uncapped
    closeTo(r.payrollTax, pfml + waCares);
    assert.ok(r.payrollTax > 2000, 'WA payroll should be material');
  });

  test('California uses its OWN standard deduction, not the federal one', () => {
    // This is the bug in the original Python engine: it subtracted the federal
    // $16,100 from state taxable income instead of California's $5,540, which
    // understates CA tax.
    const gross = 200000;
    const actual = stateTax(gross, 'CA').incomeTax;

    assert.equal(STATES.CA.standardDeduction, 5540);

    const wrong = progressiveTax_(gross - FEDERAL.standardDeduction, STATES.CA.brackets);
    assert.ok(actual > wrong, 'correct CA tax must exceed the federal-deduction version');
    // The gap is the deduction difference taxed at CA's 9.3% band.
    closeTo(actual - wrong, (FEDERAL.standardDeduction - 5540) * 0.093, 1);
  });

  test('CA SDI is uncapped and charged on gross', () => {
    const r = stateTax(500000, 'CA');
    closeTo(r.payrollTax, 500000 * 0.013);
  });

  test('Pennsylvania taxes gross with no deduction', () => {
    closeTo(stateTax(150000, 'PA').incomeTax, 150000 * 0.0307);
  });

  test('unknown state throws rather than silently returning zero', () => {
    // The original engine returned $0 for every unmodelled state.
    assert.throws(() => stateTax(100000, 'ZZ'), /Unknown state/);
  });
});

describe('local income tax', () => {
  test('NYC applies on top of New York State', () => {
    const gross = 185000;
    const nyc = localTax(gross, 'NYC', 'NY');

    // Taxable = 185,000 - 8,000 NY deduction = 177,000, walked through the
    // four NYC resident bands:
    //   12,000 @ 3.078% +  13,000 @ 3.762%
    // + 25,000 @ 3.819% + 127,000 @ 3.876%
    const expected = 12000 * 0.03078 + 13000 * 0.03762 + 25000 * 0.03819 + 127000 * 0.03876;
    closeTo(nyc, expected);
    closeTo(nyc, 6735.69);

    // The blended rate must land below the 3.876% top band, since the first
    // $50k is taxed lower — a flat-rate approximation would overstate it.
    const taxable = gross - STATES.NY.standardDeduction;
    assert.ok(nyc < taxable * 0.03876, 'blended NYC rate should sit under the top band');
  });

  test('a metro with no local tax pays none', () => {
    assert.equal(localTax(185000, null, 'TX'), 0);
  });

  test('Philadelphia is charged on gross, not on taxable income', () => {
    closeTo(localTax(150000, 'PHL', 'PA'), 150000 * 0.03735);
  });

  test('unknown locality throws', () => {
    assert.throws(() => localTax(100000, 'XYZ', 'CA'), /Unknown locality/);
  });
});

describe('totalTax', () => {
  test('breakdown sums to the total', () => {
    const r = totalTax(250000, { state: 'CA' });
    closeTo(r.federal + r.fica + r.stateIncome + r.statePayroll + r.local, r.total);
    closeTo(r.net, 250000 - r.total);
  });

  test('no-tax state beats high-tax state at equal gross', () => {
    const tx = totalTax(200000, { state: 'TX' });
    const ca = totalTax(200000, { state: 'CA' });
    const nyc = totalTax(200000, { state: 'NY', local: 'NYC' });

    assert.ok(tx.total < ca.total, 'TX should tax less than CA');
    assert.ok(ca.total < nyc.total, 'CA should tax less than NYC at this income');
  });

  test('effective rate is a sane fraction', () => {
    const r = totalTax(185000, { state: 'CA' });
    assert.ok(r.effectiveRate > 0.25 && r.effectiveRate < 0.45, `got ${r.effectiveRate}`);
  });

  test('take-home never exceeds gross and never goes negative', () => {
    for (const gross of [0, 50000, 185000, 1000000]) {
      for (const [state, local] of [['CA', null], ['NY', 'NYC'], ['TX', null], ['WA', null]]) {
        const r = totalTax(gross, { state, local });
        assert.ok(r.net <= gross, `net exceeded gross at ${gross} ${state}`);
        assert.ok(r.net >= 0, `net went negative at ${gross} ${state}`);
      }
    }
  });
});

// Local copy so the CA test can compare against the buggy formulation.
function progressiveTax_(taxable, brackets) {
  return progressiveTax(Math.max(0, taxable), brackets);
}
