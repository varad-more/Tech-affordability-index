/**
 * 2026 US tax constants — single filer, standard deduction, no dependents.
 *
 * Every figure below carries the source it came from. When a new tax year lands,
 * this is the only file that needs editing: `tax.js` holds no numbers.
 *
 * Brackets are expressed as `{ from, rate }` where `from` is the INCLUSIVE lower
 * bound of the bracket in taxable-income dollars, sorted ascending.
 */

export const TAX_YEAR = 2026;
export const FILING_STATUS = 'single';

export const SOURCES = {
  federal: {
    url: 'https://taxfoundation.org/data/all/federal/2026-tax-brackets/',
    note: 'IRS Rev. Proc. 2025-32 inflation adjustments (post-OBBBA)',
    asOf: '2026-01-01',
  },
  fica: {
    url: 'https://www.ssa.gov/oact/cola/cbb.html',
    note: 'SSA contribution and benefit base 2026',
    asOf: '2026-01-01',
  },
  states: {
    url: 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/',
    note: 'Tax Foundation, State Individual Income Tax Rates and Brackets 2026',
    asOf: '2026-02-11',
  },
};

/** Federal ordinary income tax. */
export const FEDERAL = {
  standardDeduction: 16100,
  brackets: [
    { from: 0, rate: 0.10 },
    { from: 12400, rate: 0.12 },
    { from: 50400, rate: 0.22 },
    { from: 105700, rate: 0.24 },
    { from: 201775, rate: 0.32 },
    { from: 256225, rate: 0.35 },
    { from: 640600, rate: 0.37 },
  ],
};

/**
 * FICA. The Social Security wage base is indexed annually; the 0.9% Additional
 * Medicare Tax threshold is fixed in statute at $200,000 for single filers and
 * is NOT inflation-adjusted.
 */
export const FICA = {
  socialSecurityRate: 0.062,
  socialSecurityWageBase: 184500,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThreshold: 200000,
};

/**
 * Per-state rules.
 *
 *   standardDeduction — the STATE's own deduction. Using the federal figure here
 *                       is a real and common bug: it understates state tax badly
 *                       (CA's is $5,540, not $16,100).
 *   brackets          — progressive schedule applied to state taxable income.
 *   payroll           — flat employee-side levies assessed on GROSS wages, not on
 *                       taxable income (CA SDI, WA PFML, WA Cares).
 *
 * `payroll[].cap` of null means the levy has no wage ceiling.
 */
export const STATES = {
  CA: {
    name: 'California',
    standardDeduction: 5540,
    brackets: [
      { from: 0, rate: 0.011 },
      { from: 11079, rate: 0.022 },
      { from: 26264, rate: 0.044 },
      { from: 41452, rate: 0.066 },
      { from: 57542, rate: 0.088 },
      { from: 72724, rate: 0.093 },
      { from: 371479, rate: 0.103 },
      { from: 445771, rate: 0.113 },
      { from: 742953, rate: 0.123 },
      { from: 1000000, rate: 0.133 },
    ],
    payroll: [
      {
        label: 'CA SDI',
        rate: 0.013,
        cap: null,
        note: 'SB 951 removed the wage ceiling in 2024; 1.3% on all wages in 2026',
        source: 'https://hrwatchdog.calchamber.com/2025/12/2026-social-security-taxable-wage-base-california-sdi-withholding-rate-increase/',
      },
    ],
  },

  NY: {
    name: 'New York',
    standardDeduction: 8000,
    brackets: [
      { from: 0, rate: 0.039 },
      { from: 8500, rate: 0.044 },
      { from: 11700, rate: 0.0515 },
      { from: 13900, rate: 0.054 },
      { from: 80650, rate: 0.059 },
      { from: 215400, rate: 0.0685 },
      { from: 1077550, rate: 0.0965 },
      { from: 5000000, rate: 0.103 },
      { from: 25000000, rate: 0.109 },
    ],
    payroll: [],
  },

  WA: {
    name: 'Washington',
    standardDeduction: 0,
    brackets: [], // no state income tax on wages
    payroll: [
      {
        label: 'WA Paid Family & Medical Leave',
        // 1.13% total premium in 2026; the employee share is 71.43%.
        rate: 0.0113 * 0.7143,
        cap: 184500,
        note: 'Employee share of the 1.13% premium, capped at the SS wage base',
        source: 'https://esd.wa.gov/about-us/news-release/2025/paid-family-medical-leave-premium-rate-increases-113-2026',
      },
      {
        label: 'WA Cares',
        rate: 0.0058,
        cap: null,
        note: 'Employee-paid, no wage ceiling',
        source: 'https://wacaresfund.wa.gov/',
      },
    ],
  },

  MA: {
    name: 'Massachusetts',
    // MA grants a personal exemption rather than a standard deduction.
    standardDeduction: 4400,
    brackets: [
      { from: 0, rate: 0.05 },
      { from: 1083150, rate: 0.09 }, // 5% + 4% "millionaire's" surtax
    ],
    payroll: [],
  },

  IL: {
    name: 'Illinois',
    // The IL personal exemption is disallowed above $250k AGI, so at tech
    // compensation levels it is zero.
    standardDeduction: 0,
    brackets: [{ from: 0, rate: 0.0495 }],
    payroll: [],
  },

  CO: {
    name: 'Colorado',
    // CO starts from federal taxable income, so it inherits the federal deduction.
    standardDeduction: 16100,
    brackets: [{ from: 0, rate: 0.044 }],
    payroll: [],
  },

  GA: {
    name: 'Georgia',
    standardDeduction: 12000,
    brackets: [{ from: 0, rate: 0.0519 }],
    payroll: [],
  },

  NC: {
    name: 'North Carolina',
    standardDeduction: 12750,
    brackets: [{ from: 0, rate: 0.0399 }],
    payroll: [],
  },

  OR: {
    name: 'Oregon',
    standardDeduction: 2910,
    brackets: [
      { from: 0, rate: 0.0475 },
      { from: 4550, rate: 0.0675 },
      { from: 11400, rate: 0.0875 },
      { from: 125000, rate: 0.099 },
    ],
    payroll: [],
  },

  VA: {
    name: 'Virginia',
    standardDeduction: 8750,
    brackets: [
      { from: 0, rate: 0.02 },
      { from: 3000, rate: 0.03 },
      { from: 5000, rate: 0.05 },
      { from: 17000, rate: 0.0575 },
    ],
    payroll: [],
  },

  AZ: {
    name: 'Arizona',
    standardDeduction: 8350,
    brackets: [{ from: 0, rate: 0.025 }],
    payroll: [],
  },

  UT: {
    name: 'Utah',
    // UT uses a taxpayer credit rather than a deduction; the credit is fully
    // phased out at tech compensation levels, so the effective base is gross.
    standardDeduction: 0,
    brackets: [{ from: 0, rate: 0.045 }],
    payroll: [],
  },

  MN: {
    name: 'Minnesota',
    standardDeduction: 15300,
    brackets: [
      { from: 0, rate: 0.0535 },
      { from: 33310, rate: 0.068 },
      { from: 109430, rate: 0.0785 },
      { from: 203150, rate: 0.0985 },
    ],
    payroll: [],
  },

  PA: {
    name: 'Pennsylvania',
    // PA allows no standard deduction — the flat rate applies to gross comp.
    standardDeduction: 0,
    brackets: [{ from: 0, rate: 0.0307 }],
    payroll: [],
  },

  TX: { name: 'Texas', standardDeduction: 0, brackets: [], payroll: [] },
  FL: { name: 'Florida', standardDeduction: 0, brackets: [], payroll: [] },
  TN: { name: 'Tennessee', standardDeduction: 0, brackets: [], payroll: [] },
  NV: { name: 'Nevada', standardDeduction: 0, brackets: [], payroll: [] },
};

/**
 * City-level income taxes. Omitting these materially flatters the affected
 * metros — NYC's top resident rate alone is ~3.9%.
 *
 *   base: 'stateTaxable' — applied to income after the state deduction
 *   base: 'gross'        — applied to gross wages with no deduction
 */
export const LOCAL = {
  NYC: {
    name: 'New York City resident income tax',
    base: 'stateTaxable',
    brackets: [
      { from: 0, rate: 0.03078 },
      { from: 12000, rate: 0.03762 },
      { from: 25000, rate: 0.03819 },
      { from: 50000, rate: 0.03876 },
    ],
    source: 'https://www.tax.ny.gov/pit/file/new-york-city-tax-rates.htm',
  },
  PHL: {
    name: 'Philadelphia resident wage tax',
    base: 'gross',
    brackets: [{ from: 0, rate: 0.03735 }],
    note: 'Rate effective July 1, 2026 (reduced from 3.75%)',
    source: 'https://www.phila.gov/services/payments-assistance-taxes/taxes/income-taxes/earnings-tax-employees/',
  },
};
