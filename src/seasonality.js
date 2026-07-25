/**
 * Rent seasonality — when in the year is a lease cheapest to sign?
 *
 * Classical multiplicative decomposition. For a monthly series:
 *
 *   1. trend      = 12-month centred moving average (half weight on the two end
 *                   months, so the window covers exactly one year and no calendar
 *                   month is counted twice)
 *   2. ratio      = value / trend, which strips the trend and leaves season+noise
 *   3. index[m]   = mean ratio for calendar month m, across every year available
 *   4. normalise  so the twelve indices average to exactly 1.0
 *
 * A centred average is what makes this work: a trailing average lags the series
 * by six months and would smear the seasonal peak into the wrong months.
 *
 * The result reads directly — 0.98 for January means January rents sit about 2%
 * below that year's trend.
 *
 * HONESTY NOTE, which the page repeats: ZORI is a *smoothed* index, and
 * smoothing damps exactly the within-year movement measured here. So these
 * amplitudes are, if anything, an understatement of what a listing-level series
 * would show — but they are what this data can support, and they are small
 * compared with the differences between places.
 */

/** Half-weight on the two end months so the window spans exactly twelve. */
const HALF_WINDOW = 6;

/**
 * Centred 12-month moving average.
 *
 * @param {Array<number|null>} series
 * @returns {Array<number|null>} same length, null where the window is incomplete
 */
export function centredTrend(series) {
  const n = series.length;
  const trend = new Array(n).fill(null);

  for (let i = HALF_WINDOW; i < n - HALF_WINDOW; i++) {
    let sum = 0;
    let complete = true;

    for (let k = -HALF_WINDOW; k <= HALF_WINDOW; k++) {
      const value = series[i + k];
      if (value === null || value === undefined) {
        complete = false;
        break;
      }
      sum += Math.abs(k) === HALF_WINDOW ? value / 2 : value;
    }

    if (complete) trend[i] = sum / 12;
  }
  return trend;
}

/**
 * Seasonal index by calendar month.
 *
 * @param {Array<number|null>} series   monthly values, oldest first
 * @param {number} startMonth           calendar month of series[0], 0 = January
 * @param {number} minYears             reject a series too short to average over
 * @returns {{ index: number[], years: number[], amplitude: number,
 *             cheapest: number, dearest: number } | null}
 */
export function seasonalIndex(series, startMonth, minYears = 3) {
  const trend = centredTrend(series);

  // Ratios grouped by calendar month.
  const ratios = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (value === null || value === undefined || trend[i] === null) continue;
    ratios[(startMonth + i) % 12].push(value / trend[i]);
  }

  // Every calendar month needs enough observations, or the index is comparing
  // months measured over different spans of the trend.
  const counts = ratios.map((r) => r.length);
  if (Math.min(...counts) < minYears) return null;

  const raw = ratios.map((r) => r.reduce((a, b) => a + b, 0) / r.length);
  const mean = raw.reduce((a, b) => a + b, 0) / 12;
  const index = raw.map((v) => v / mean);

  const cheapest = index.indexOf(Math.min(...index));
  const dearest = index.indexOf(Math.max(...index));

  return {
    index,
    years: counts,
    // Peak-to-trough, as a fraction: 0.037 means a 3.7% swing across the year.
    amplitude: Math.max(...index) - Math.min(...index),
    cheapest,
    dearest,
  };
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_SHORT = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/**
 * What the seasonal swing is worth, in money.
 *
 * @param {number[]} index  twelve seasonal factors
 * @param {number}   rent   current monthly rent
 */
export function seasonalSaving(index, rent) {
  const cheapest = Math.min(...index);
  const dearest = Math.max(...index);

  // The trend-level rent this index is expressed against.
  const base = rent / ((cheapest + dearest) / 2);

  const monthly = base * (dearest - cheapest);
  return { monthly, annual: monthly * 12 };
}

/**
 * Whether a seasonal pattern is worth acting on.
 *
 * Below about 1.5% peak-to-trough the signal is comparable to the noise in a
 * smoothed index, and telling someone to move house over it would be false
 * precision.
 */
export const MEANINGFUL_AMPLITUDE = 0.015;
