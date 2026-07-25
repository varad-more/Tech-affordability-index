/**
 * Affordability = the share of one month's take-home pay that rent consumes.
 *
 * The headline ratio deliberately uses BASE SALARY ONLY. Equity and bonuses are
 * shown alongside it, never folded silently into the headline: a sign-on bonus
 * is one lump in January, and RSUs vest quarterly at a price nobody can predict,
 * so treating either as evenly-spendable monthly income flatters the number
 * exactly where a relocation decision can least afford flattery.
 */

import { totalTax } from './tax.js';

/**
 * HUD's long-standing definition of "cost-burdened": more than 30% of income
 * spent on housing. It anchors the charts with a real threshold rather than an
 * arbitrary one.
 */
export const COST_BURDENED_THRESHOLD = 0.30;
export const SEVERELY_COST_BURDENED_THRESHOLD = 0.50;

/**
 * Gross wage income in a given year of the offer.
 *
 * @param {number} year 0-indexed (0 = first year)
 */
export function grossForYear(profile, year) {
  const { baseSalary, rsuGrant = 0, vesting = [], bonuses = [], equityHaircut = 1 } = profile;

  const vested = (vesting[year] ?? 0) * rsuGrant * equityHaircut;
  const bonus = bonuses[year] ?? 0;

  return baseSalary + bonus + vested;
}

function ratio(monthlyRent, monthlyNet) {
  // An offer that nets nothing monthly can't cover any rent; report it as such
  // rather than dividing by zero and rendering Infinity into a chart.
  if (!(monthlyNet > 0)) return null;
  return monthlyRent / monthlyNet;
}

/**
 * Affordability for one compensation profile in one location.
 *
 * @param {object} profile  { baseSalary, rsuGrant, vesting[], bonuses[], equityHaircut }
 * @param {object} location { state, local, rent }  monthly rent
 */
export function affordability(profile, location) {
  const { state, local = null, rent } = location;

  const baseTax = totalTax(profile.baseSalary, { state, local });
  const baseMonthlyNet = baseTax.net / 12;

  const yearCount = Math.max(profile.vesting?.length ?? 0, profile.bonuses?.length ?? 0, 1);

  const years = Array.from({ length: yearCount }, (_, y) => {
    const gross = grossForYear(profile, y);
    const tax = totalTax(gross, { state, local });
    const monthlyNet = tax.net / 12;

    return {
      year: y + 1,
      gross,
      tax,
      monthlyNet,
      ratio: ratio(rent, monthlyNet),
    };
  });

  return {
    rent,
    state,
    local,
    // Headline: rent against take-home from base salary alone.
    baseRatio: ratio(rent, baseMonthlyNet),
    baseMonthlyNet,
    baseTax,
    // Same ratio once equity and bonuses are counted, year by year.
    years,
    totalRatioY1: years[0]?.ratio ?? null,
  };
}

/** Classify a ratio against the HUD thresholds. */
export function burdenLevel(r) {
  if (r === null || r === undefined) return 'unknown';
  if (r >= SEVERELY_COST_BURDENED_THRESHOLD) return 'severe';
  if (r >= COST_BURDENED_THRESHOLD) return 'burdened';
  return 'ok';
}

/** Rank locations for a profile, cheapest rent burden first. */
export function rankLocations(profile, locations) {
  return locations
    .map((loc) => ({ location: loc, result: affordability(profile, loc) }))
    .sort((a, b) => (a.result.baseRatio ?? Infinity) - (b.result.baseRatio ?? Infinity));
}
