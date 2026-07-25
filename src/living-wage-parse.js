/**
 * Parser for the MIT Living Wage Calculator's "Typical Expenses" table.
 *
 * Extracted from the ingest scripts so the metro and county pipelines share one
 * implementation, and so `test/living-wage.test.mjs` can exercise it against
 * saved fixtures without touching the network.
 *
 * The table is HTML meant for people, not an API, so the parser re-checks its
 * own assumptions on every row rather than trusting column positions. A silent
 * column shift here would move every salary threshold on the site.
 */

/** Rows of the "Typical Expenses" table, in published order. */
export const EXPENSE_ROWS = [
  'Food',
  'Child Care',
  'Medical',
  'Housing',
  'Transportation',
  'Civic',
  'Internet & Mobile',
  'Other',
];

export const REQUIRED_ROW = 'Required annual income after taxes';

/**
 * Everything a single adult needs that is not rent.
 *
 * Housing is excluded deliberately: MIT prices it from HUD Fair Market Rent,
 * published annually, and this project already carries ZORI, refreshed monthly.
 * Taking rent from ZORI and everything else from MIT keeps one rent series in
 * play instead of two that disagree.
 */
export const NON_HOUSING = [
  'Food',
  'Medical',
  'Transportation',
  'Civic',
  'Internet & Mobile',
  'Other',
];

/**
 * The order per-category figures are stored in, so the committed data can use a
 * bare array instead of repeating six keys on every one of 1,350 rows.
 *
 * `Civic` is MIT's term for the minimum civic and recreational participation it
 * treats as a necessity rather than a luxury — not a tax.
 */
export const CATEGORY_ORDER = NON_HOUSING;

export const CATEGORY_LABELS = {
  Food: 'Groceries',
  Medical: 'Healthcare',
  Transportation: 'Transport',
  Civic: 'Civic & recreation',
  'Internet & Mobile': 'Internet & phone',
  Other: 'Other essentials',
};

const stripTags = (s) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const parseMoney = (s) => {
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse one Living Wage page.
 *
 * @param {string} html  the page body
 * @param {string} label somewhere to point the reader when it throws
 * @returns {{ expenses: object, nonHousingAnnual: number, nonHousingMonthly: number }}
 * @throws if the table is missing, mis-shaped, or does not reconcile
 */
export function parseLivingWage(html, label) {
  const start = html.indexOf('Typical Expenses');
  if (start === -1) throw new Error(`${label}: no "Typical Expenses" table found`);

  const segment = html.slice(start, start + 8000);
  const rows = [...segment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1])),
  );

  // Column 1 is "1 Adult, 0 Children". Verify rather than assume — if MIT ever
  // reorders the household columns, every downstream figure would silently
  // become a two-adult budget.
  const header = rows.map((r) => r.join('|')).join(' ');
  if (!/1\s*ADULT/i.test(header) || !/0\s*Children/i.test(header)) {
    throw new Error(`${label}: header is not the expected "1 ADULT / 0 Children" layout`);
  }

  const expenses = {};
  for (const row of rows) {
    if (row.length < 2) continue;
    const name = row[0];
    if (!EXPENSE_ROWS.includes(name) && name !== REQUIRED_ROW) continue;

    const value = parseMoney(row[1]);
    if (value === null) throw new Error(`${label}: row "${name}" has no readable figure`);
    expenses[name] = value;
  }

  for (const row of [...EXPENSE_ROWS, REQUIRED_ROW]) {
    if (!(row in expenses)) throw new Error(`${label}: missing row "${row}"`);
  }

  // MIT's own stated total must reconcile against its components. If it does
  // not, the parser has latched onto the wrong column and every number is wrong
  // in a way no range check would catch.
  const componentSum = EXPENSE_ROWS.reduce((n, k) => n + expenses[k], 0);
  if (Math.abs(componentSum - expenses[REQUIRED_ROW]) > 12) {
    throw new Error(
      `${label}: components sum to $${componentSum} but the table states ` +
        `$${expenses[REQUIRED_ROW]} — column alignment is wrong`,
    );
  }

  const nonHousingAnnual = NON_HOUSING.reduce((n, k) => n + expenses[k], 0);

  return {
    expenses,
    nonHousingAnnual,
    nonHousingMonthly: Math.round((nonHousingAnnual / 12) * 100) / 100,
  };
}

/** A single adult's non-rent essentials outside this band means the page moved. */
export const PLAUSIBLE_MONTHLY = { min: 700, max: 6000 };
