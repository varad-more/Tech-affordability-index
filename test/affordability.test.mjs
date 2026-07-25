import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  affordability,
  grossForYear,
  burdenLevel,
  rankLocations,
  COST_BURDENED_THRESHOLD,
} from '../src/affordability.js';
import { totalTax } from '../src/tax.js';

const closeTo = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${expected}, got ${actual}`);

const PROFILE = {
  baseSalary: 185000,
  rsuGrant: 350000,
  vesting: [0.33, 0.33, 0.22, 0.12],
  bonuses: [27750, 27750, 27750, 27750],
  equityHaircut: 0.85,
};

describe('grossForYear', () => {
  test('adds bonus and haircut-adjusted vested equity to base', () => {
    closeTo(grossForYear(PROFILE, 0), 185000 + 27750 + 350000 * 0.33 * 0.85);
  });

  test('follows the vesting schedule year by year', () => {
    // Front-loaded grant: year 1 vests more than year 4.
    assert.ok(grossForYear(PROFILE, 0) > grossForYear(PROFILE, 3));
  });

  test('years beyond the schedule contribute no equity or bonus', () => {
    assert.equal(grossForYear(PROFILE, 99), PROFILE.baseSalary);
  });

  test('a haircut of 0 removes equity entirely (illiquid startup paper)', () => {
    const illiquid = { ...PROFILE, equityHaircut: 0 };
    closeTo(grossForYear(illiquid, 0), 185000 + 27750);
  });
});

describe('affordability', () => {
  const location = { state: 'TX', local: null, rent: 1800 };

  test('headline ratio uses base salary only', () => {
    const r = affordability(PROFILE, location);
    const expectedNet = totalTax(PROFILE.baseSalary, { state: 'TX', local: null }).net / 12;

    closeTo(r.baseMonthlyNet, expectedNet);
    closeTo(r.baseRatio, 1800 / expectedNet);
  });

  test('counting equity lowers the ratio below the base-only headline', () => {
    const r = affordability(PROFILE, location);
    assert.ok(
      r.years[0].ratio < r.baseRatio,
      'total comp should make rent a smaller share than base alone',
    );
  });

  test('produces one entry per vesting year', () => {
    assert.equal(affordability(PROFILE, location).years.length, 4);
  });

  test('a higher-tax state yields a worse ratio at identical rent', () => {
    const tx = affordability(PROFILE, { state: 'TX', rent: 2500 });
    const nyc = affordability(PROFILE, { state: 'NY', local: 'NYC', rent: 2500 });

    assert.ok(nyc.baseRatio > tx.baseRatio, 'NYC take-home is lower, so rent bites harder');
  });

  test('returns null rather than Infinity when take-home is zero', () => {
    const broke = { baseSalary: 0, rsuGrant: 0, vesting: [0], bonuses: [0] };
    const r = affordability(broke, location);

    assert.equal(r.baseRatio, null);
    assert.equal(r.years[0].ratio, null);
  });

  test('rent of zero costs nothing', () => {
    assert.equal(affordability(PROFILE, { state: 'TX', rent: 0 }).baseRatio, 0);
  });
});

describe('burdenLevel', () => {
  test('classifies against the HUD 30% and 50% thresholds', () => {
    assert.equal(burdenLevel(0.22), 'ok');
    assert.equal(burdenLevel(COST_BURDENED_THRESHOLD), 'burdened');
    assert.equal(burdenLevel(0.41), 'burdened');
    assert.equal(burdenLevel(0.5), 'severe');
    assert.equal(burdenLevel(null), 'unknown');
  });
});

describe('rankLocations', () => {
  const locations = [
    { city: 'Expensive', state: 'CA', rent: 3400 },
    { city: 'Cheap', state: 'TX', rent: 1600 },
    { city: 'Middle', state: 'WA', rent: 2200 },
  ];

  test('orders cheapest rent burden first', () => {
    const ranked = rankLocations(PROFILE, locations);
    assert.deepEqual(
      ranked.map((r) => r.location.city),
      ['Cheap', 'Middle', 'Expensive'],
    );
  });

  test('does not mutate the input array', () => {
    const before = locations.map((l) => l.city);
    rankLocations(PROFILE, locations);
    assert.deepEqual(locations.map((l) => l.city), before);
  });
});
