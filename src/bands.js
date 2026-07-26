/**
 * Salary bands — what a metro actually costs, in dollars of gross salary.
 *
 * The rest of this project answers a *relative* question: given an offer, where
 * does rent eat least? That ranks metros against each other but never says
 * whether any of them is affordable. Two metros at an identical 28% rent burden
 * are not equally livable if one has materially higher transport and medical
 * costs, and a rent-share chart cannot see that difference.
 *
 * So the model here is absolute. For each metro:
 *
 *     needs = ZORI rent + MIT non-housing essentials      (monthly, after tax)
 *
 * and the thresholds are the salaries at which that figure lands on a
 * recognised share of take-home pay. Each cut is a published standard rather
 * than a number chosen to look reasonable:
 *
 *   Survival     needs = 100% of take-home.  MIT's living wage is explicitly a
 *                subsistence budget — it contains no savings, no travel and no
 *                dining out. Covering it exactly is the floor, not a target.
 *   Getting by   needs =  70% of take-home.  The 70/20/10 budget, leaving 20%
 *                for savings and 10% for debt or giving.
 *   Comfortable  needs =  50% of take-home.  The 50/30/20 rule, leaving 30% for
 *                discretionary spending and 20% for savings.
 *
 * Salaries are solved by inverting the tax engine numerically rather than
 * algebraically, so the bands stay correct for every state, bracket, payroll
 * levy and city tax automatically — including the kinks at the Social Security
 * wage cap and the additional Medicare threshold, which have no closed form.
 */

import { totalTax } from './tax.js';

/**
 * Share of take-home pay that essentials consume at each band boundary.
 * Ordered from hardest to easiest.
 */
export const BANDS = [
  {
    id: 'below-survival',
    label: 'Below survival',
    // No upper bound on the share: essentials cost more than the paycheque.
    maxNeedsShare: Infinity,
    description: 'Essentials cost more than take-home pay.',
  },
  {
    id: 'survival',
    label: 'Survival',
    maxNeedsShare: 1.0,
    description: 'Covers necessities with nothing meaningful left over.',
  },
  {
    id: 'getting-by',
    label: 'Getting by',
    maxNeedsShare: 0.7,
    description: 'Necessities under 70% of take-home, with room to save.',
  },
  {
    id: 'comfortable',
    label: 'Comfortable',
    maxNeedsShare: 0.5,
    description: 'Necessities under half of take-home, the full 50/30/20 headroom.',
  },
];

export const BAND_BY_ID = Object.fromEntries(BANDS.map((b) => [b.id, b]));

/** The two thresholds the page leads with. */
export const SURVIVAL_SHARE = 1.0;
export const COMFORTABLE_SHARE = 0.5;

/**
 * Class breaks for the map, on "share of take-home consumed by necessities".
 *
 * Why the map does not simply paint the four bands: at an entry-level tech
 * salary more than nine counties in ten fall into "comfortable", so a four-class
 * map is one colour almost everywhere and the encoding carries nothing. The
 * underlying quantity is continuous and varies a great deal inside that band —
 * necessities take about a quarter of take-home in rural Ohio and about
 * two-thirds in the Bay Area — so the map shows the continuous quantity and uses
 * the band boundaries as class breaks.
 *
 * The upper three breaks are exactly the named standards (50%, 70%, 100%), so
 * the map and the verdict never disagree; the lower ones subdivide the crowded
 * comfortable end where the real variation lives.
 */
export const NEEDS_SHARE_BREAKS = [0.25, 0.32, 0.4, 0.5, 0.7, 1.0];

/** Legend copy for each class, ordered lightest (easiest) to darkest. */
export const NEEDS_SHARE_CLASSES = [
  { max: 0.25, label: 'under 25%' },
  { max: 0.32, label: '25-32%' },
  { max: 0.4, label: '32-40%' },
  { max: 0.5, label: '40-50%' },
  { max: 0.7, label: '50-70%', note: 'past the 50/30/20 comfortable line' },
  { max: 1.0, label: '70-100%', note: 'past the 70/20/10 line, little left to save' },
  { max: Infinity, label: 'over 100%', note: 'necessities exceed take-home' },
];

/**
 * Which class a needs-share falls in: 0 (easiest) to 6 (hardest).
 *
 * @param {number|null} share necessities / monthly take-home
 */
export function needsShareStep(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return null;

  for (let i = 0; i < NEEDS_SHARE_BREAKS.length; i++) {
    if (share <= NEEDS_SHARE_BREAKS[i]) return i;
  }
  return NEEDS_SHARE_BREAKS.length;
}

/**
 * Monthly cost of everything a single adult needs in a metro.
 *
 * @param {number} rent             monthly rent (ZORI)
 * @param {number} nonHousingMonthly monthly non-rent essentials (MIT)
 */
export function monthlyNeeds(rent, nonHousingMonthly) {
  return rent + nonHousingMonthly;
}

/**
 * Smallest gross salary whose take-home pay reaches `targetAnnualNet`.
 *
 * Bisection, not algebra: take-home is piecewise-linear in gross with kinks at
 * every bracket edge, the Social Security wage cap and the additional Medicare
 * threshold. It is, however, strictly increasing, which is all bisection needs —
 * and it means one implementation covers every jurisdiction the engine knows.
 *
 * @returns {number|null} gross salary, or null if the target is unreachable
 */
export function grossForNet(targetAnnualNet, { state, local = null } = {}) {
  if (!(targetAnnualNet > 0)) return 0;

  const netOf = (gross) => totalTax(gross, { state, local }).net;

  // Grow the upper bound until it brackets the target. Marginal rates stay below
  // 100%, so this terminates; the cap is a guard against a malformed bracket
  // table rather than an expected path.
  let hi = Math.max(targetAnnualNet * 1.5, 10_000);
  for (let i = 0; netOf(hi) < targetAnnualNet; i++) {
    if (i > 40) return null;
    hi *= 2;
  }

  let lo = 0;
  // ~60 halvings takes a $10M interval well below a cent; the loop bound is a
  // belt-and-braces stop, and the width test is what actually ends it.
  for (let i = 0; i < 200 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (netOf(mid) < targetAnnualNet) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The salary ladder for one metro.
 *
 * @param {object} location { state, local, rent, nonHousingMonthly }
 */
export function salaryBands(location) {
  const { state, local = null, rent, nonHousingMonthly } = location;
  const needs = monthlyNeeds(rent, nonHousingMonthly);

  const salaryAtShare = (share) => grossForNet((needs * 12) / share, { state, local });

  return {
    rent,
    nonHousingMonthly,
    monthlyNeeds: needs,
    annualNeeds: needs * 12,
    survival: salaryAtShare(1.0),
    gettingBy: salaryAtShare(0.7),
    comfortable: salaryAtShare(0.5),
  };
}

/**
 * Where a given take-home figure lands on the ladder.
 *
 * @param {number} monthlyNet take-home pay per month
 * @param {number} needs      monthly essentials
 */
export function classify(monthlyNet, needs) {
  if (!(monthlyNet > 0)) return BAND_BY_ID['below-survival'];

  const share = needs / monthlyNet;

  // Bands are ordered hardest-first; the last one whose ceiling still admits
  // this share is the answer.
  let match = BAND_BY_ID['below-survival'];
  for (const band of BANDS) {
    if (share <= band.maxNeedsShare) match = band;
  }
  return match;
}

/**
 * Full picture for one salary in one metro: the ladder, where this salary sits
 * on it, and the tax that separates gross from net.
 *
 * @param {number} gross    annual gross salary
 * @param {object} location { state, local, rent, nonHousingMonthly }
 */
export function assess(gross, location) {
  const { state, local = null, rent, nonHousingMonthly } = location;

  const tax = totalTax(gross, { state, local });
  const monthlyNet = tax.net / 12;
  const needs = monthlyNeeds(rent, nonHousingMonthly);

  const bands = salaryBands(location);
  const band = classify(monthlyNet, needs);

  return {
    gross,
    tax,
    monthlyNet,
    monthlyNeeds: needs,
    // Share of take-home consumed by essentials — the quantity the bands cut on.
    needsShare: monthlyNet > 0 ? needs / monthlyNet : null,
    // What is left after rent and essentials, each month.
    monthlySurplus: monthlyNet - needs,
    rentShare: monthlyNet > 0 ? rent / monthlyNet : null,
    bands,
    band,
  };
}
