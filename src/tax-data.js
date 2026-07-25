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
 * Employee-side payroll levies beyond FICA.
 *
 * COVERAGE, stated because it is a real limitation of the numbers on the page:
 * only California and Washington are modelled below. Around a dozen other states
 * run employee-funded paid-leave or temporary-disability programmes — typically
 * 0.3% to 0.7% of wages — and their rates move yearly, are set by different
 * agencies, and several are mid-phase-in for 2026.
 *
 * Rather than transcribe a dozen rates that could not be verified to the same
 * standard as everything else in this file, they are omitted and the omission is
 * declared. Take-home in the affected states is therefore overstated by roughly
 * half a percent of gross. That is a bounded, disclosed error; a wrong rate
 * presented with the same confidence as a right one is not.
 */
export const PAYROLL_MODELLED_STATES = ['CA', 'WA'];

export const PAYROLL_COVERAGE_NOTE =
  'State paid-leave and disability payroll levies are modelled for California and Washington only. ' +
  'Roughly a dozen other states run employee-funded programmes of about 0.3-0.7% of wages, which are ' +
  'not included — take-home in those states is overstated slightly.';

/**
 * Per-state rules.
 *
 *   standardDeduction — the STATE's own deduction. Using the federal figure here
 *                       is a real and common bug: it understates state tax badly
 *                       (CA's is $5,540, not $16,100). A handful of states —
 *                       Colorado, Idaho, Iowa, Montana, New Mexico, North Dakota,
 *                       South Carolina — genuinely start from federal taxable
 *                       income and so do inherit the federal figure.
 *   brackets          — progressive schedule applied to state taxable income. A
 *                       leading `{ from: 0, rate: 0 }` marks a state whose first
 *                       taxed bracket begins above zero.
 *   payroll           — flat employee-side levies assessed on GROSS wages, not on
 *                       taxable income. See PAYROLL_COVERAGE_NOTE.
 *
 * `payroll[].cap` of null means the levy has no wage ceiling.
 *
 * Every bracket table below is from the Tax Foundation's 2026 single-filer
 * survey (SOURCES.states). States with no wage income tax carry empty brackets.
 */
const NO_INCOME_TAX = (name) => ({ name, standardDeduction: 0, brackets: [], payroll: [] });

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

  AL: {
    name: 'Alabama',
    standardDeduction: 3000,
    // Alabama phases its standard deduction down as AGI rises, so at the
    // salaries this site deals with the real figure is lower and the tax here is
    // marginally understated.
    brackets: [
      { from: 0, rate: 0.02 },
      { from: 500, rate: 0.04 },
      { from: 3000, rate: 0.05 },
    ],
    payroll: [],
  },

  AR: {
    name: 'Arkansas',
    standardDeduction: 2470,
    brackets: [
      { from: 0, rate: 0.02 },
      { from: 4600, rate: 0.039 },
    ],
    payroll: [],
  },

  CT: {
    name: 'Connecticut',
    // CT grants a personal exemption that is fully phased out well below tech
    // salaries, so the effective base is gross.
    standardDeduction: 0,
    brackets: [
      { from: 0, rate: 0.02 },
      { from: 10000, rate: 0.045 },
      { from: 50000, rate: 0.055 },
      { from: 100000, rate: 0.06 },
      { from: 200000, rate: 0.065 },
      { from: 250000, rate: 0.069 },
      { from: 500000, rate: 0.0699 },
    ],
    payroll: [],
  },

  DE: {
    name: 'Delaware',
    standardDeduction: 3250,
    brackets: [
      { from: 0, rate: 0 },
      { from: 2000, rate: 0.022 },
      { from: 5000, rate: 0.039 },
      { from: 10000, rate: 0.048 },
      { from: 20000, rate: 0.052 },
      { from: 25000, rate: 0.0555 },
      { from: 60000, rate: 0.066 },
    ],
    payroll: [],
  },

  HI: {
    name: 'Hawaii',
    standardDeduction: 4400,
    brackets: [
      { from: 0, rate: 0.014 },
      { from: 9600, rate: 0.032 },
      { from: 14400, rate: 0.055 },
      { from: 19200, rate: 0.064 },
      { from: 24000, rate: 0.068 },
      { from: 36000, rate: 0.072 },
      { from: 48000, rate: 0.076 },
      { from: 125000, rate: 0.079 },
      { from: 175000, rate: 0.0825 },
      { from: 225000, rate: 0.09 },
      { from: 275000, rate: 0.10 },
      { from: 325000, rate: 0.11 },
    ],
    payroll: [],
  },

  ID: {
    name: 'Idaho',
    standardDeduction: 16100, // starts from federal taxable income
    brackets: [
      { from: 0, rate: 0 },
      { from: 4811, rate: 0.053 },
    ],
    payroll: [],
  },

  IN: {
    name: 'Indiana',
    standardDeduction: 0,
    brackets: [{ from: 0, rate: 0.0295 }],
    payroll: [],
  },

  IA: {
    name: 'Iowa',
    standardDeduction: 16100, // starts from federal taxable income
    brackets: [{ from: 0, rate: 0.038 }],
    payroll: [],
  },

  KS: {
    name: 'Kansas',
    standardDeduction: 3605,
    brackets: [
      { from: 0, rate: 0.052 },
      { from: 23000, rate: 0.0558 },
    ],
    payroll: [],
  },

  KY: {
    name: 'Kentucky',
    standardDeduction: 3360,
    brackets: [{ from: 0, rate: 0.035 }],
    payroll: [],
  },

  LA: {
    name: 'Louisiana',
    standardDeduction: 12875,
    brackets: [{ from: 0, rate: 0.03 }],
    payroll: [],
  },

  ME: {
    name: 'Maine',
    standardDeduction: 8350,
    brackets: [
      { from: 0, rate: 0.058 },
      { from: 27399, rate: 0.0675 },
      { from: 64849, rate: 0.0715 },
    ],
    payroll: [],
  },

  MD: {
    name: 'Maryland',
    standardDeduction: 3350,
    brackets: [
      { from: 0, rate: 0.02 },
      { from: 1000, rate: 0.03 },
      { from: 2000, rate: 0.04 },
      { from: 3000, rate: 0.0475 },
      { from: 100000, rate: 0.05 },
      { from: 125000, rate: 0.0525 },
      { from: 150000, rate: 0.055 },
      { from: 250000, rate: 0.0575 },
      { from: 500000, rate: 0.0625 },
      { from: 1000000, rate: 0.065 },
    ],
    payroll: [],
  },

  MI: {
    name: 'Michigan',
    // MI grants a personal exemption rather than a standard deduction.
    standardDeduction: 0,
    brackets: [{ from: 0, rate: 0.0425 }],
    payroll: [],
  },

  MS: {
    name: 'Mississippi',
    standardDeduction: 2300,
    brackets: [
      { from: 0, rate: 0 },
      { from: 10000, rate: 0.04 },
    ],
    payroll: [],
  },

  MO: {
    name: 'Missouri',
    standardDeduction: 16100, // conforms to the federal standard deduction
    brackets: [
      { from: 0, rate: 0 },
      { from: 1348, rate: 0.02 },
      { from: 2696, rate: 0.025 },
      { from: 4044, rate: 0.03 },
      { from: 5392, rate: 0.035 },
      { from: 6740, rate: 0.04 },
      { from: 8088, rate: 0.045 },
      { from: 9436, rate: 0.047 },
    ],
    payroll: [],
  },

  MT: {
    name: 'Montana',
    standardDeduction: 16100, // starts from federal taxable income
    brackets: [
      { from: 0, rate: 0.047 },
      { from: 47500, rate: 0.0565 },
    ],
    payroll: [],
  },

  NE: {
    name: 'Nebraska',
    standardDeduction: 8850,
    brackets: [
      { from: 0, rate: 0.0246 },
      { from: 4130, rate: 0.0351 },
      { from: 24760, rate: 0.0455 },
    ],
    payroll: [],
  },

  NJ: {
    name: 'New Jersey',
    standardDeduction: 0,
    brackets: [
      { from: 0, rate: 0.014 },
      { from: 20000, rate: 0.0175 },
      { from: 35000, rate: 0.035 },
      { from: 40000, rate: 0.0553 },
      { from: 75000, rate: 0.0637 },
      { from: 500000, rate: 0.0897 },
      { from: 1000000, rate: 0.1075 },
    ],
    payroll: [],
  },

  NM: {
    name: 'New Mexico',
    standardDeduction: 16100, // starts from federal taxable income
    brackets: [
      { from: 0, rate: 0.015 },
      { from: 5500, rate: 0.032 },
      { from: 16500, rate: 0.043 },
      { from: 33500, rate: 0.047 },
      { from: 66500, rate: 0.049 },
      { from: 210000, rate: 0.059 },
    ],
    payroll: [],
  },

  ND: {
    name: 'North Dakota',
    standardDeduction: 16100, // starts from federal taxable income
    brackets: [
      { from: 0, rate: 0 },
      { from: 48475, rate: 0.0195 },
      { from: 244825, rate: 0.025 },
    ],
    payroll: [],
  },

  OH: {
    name: 'Ohio',
    standardDeduction: 0,
    brackets: [
      { from: 0, rate: 0 },
      { from: 26050, rate: 0.0275 },
    ],
    payroll: [],
  },

  OK: {
    name: 'Oklahoma',
    standardDeduction: 6350,
    brackets: [
      { from: 0, rate: 0 },
      { from: 3750, rate: 0.025 },
      { from: 4900, rate: 0.035 },
      { from: 7200, rate: 0.045 },
    ],
    payroll: [],
  },

  RI: {
    name: 'Rhode Island',
    standardDeduction: 11200,
    brackets: [
      { from: 0, rate: 0.0375 },
      { from: 82050, rate: 0.0475 },
      { from: 186450, rate: 0.0599 },
    ],
    payroll: [],
  },

  SC: {
    name: 'South Carolina',
    standardDeduction: 8350,
    brackets: [
      { from: 0, rate: 0 },
      { from: 3640, rate: 0.03 },
      { from: 18230, rate: 0.06 },
    ],
    payroll: [],
  },

  VT: {
    name: 'Vermont',
    standardDeduction: 7650,
    brackets: [
      { from: 0, rate: 0.0335 },
      { from: 49400, rate: 0.066 },
      { from: 119700, rate: 0.076 },
      { from: 249700, rate: 0.0875 },
    ],
    payroll: [],
  },

  WV: {
    name: 'West Virginia',
    standardDeduction: 0,
    brackets: [
      { from: 0, rate: 0.0222 },
      { from: 10000, rate: 0.0296 },
      { from: 25000, rate: 0.0333 },
      { from: 40000, rate: 0.0444 },
      { from: 60000, rate: 0.0482 },
    ],
    payroll: [],
  },

  WI: {
    name: 'Wisconsin',
    standardDeduction: 13960,
    brackets: [
      { from: 0, rate: 0.035 },
      { from: 15110, rate: 0.044 },
      { from: 51950, rate: 0.053 },
      { from: 332720, rate: 0.0765 },
    ],
    payroll: [],
  },

  DC: {
    name: 'District of Columbia',
    standardDeduction: 16100,
    brackets: [
      { from: 0, rate: 0.04 },
      { from: 10000, rate: 0.06 },
      { from: 40000, rate: 0.065 },
      { from: 60000, rate: 0.085 },
      { from: 250000, rate: 0.0925 },
      { from: 500000, rate: 0.0975 },
      { from: 1000000, rate: 0.1075 },
    ],
    payroll: [],
  },

  // No tax on wage income. Washington levies an income tax on capital gains
  // only, and New Hampshire's interest-and-dividends tax has been repealed —
  // neither touches a salary.
  TX: NO_INCOME_TAX('Texas'),
  FL: NO_INCOME_TAX('Florida'),
  TN: NO_INCOME_TAX('Tennessee'),
  NV: NO_INCOME_TAX('Nevada'),
  AK: NO_INCOME_TAX('Alaska'),
  SD: NO_INCOME_TAX('South Dakota'),
  WY: NO_INCOME_TAX('Wyoming'),
  NH: NO_INCOME_TAX('New Hampshire'),
};

/**
 * States where local income tax exists but is NOT computed here.
 *
 * About a third of the counties on the map sit in one of these states, so
 * leaving this undeclared would overstate take-home for a large minority of the
 * country without saying so.
 *
 * These rates are NOT used in any calculation. They exist so the page can tell a
 * reader in Columbus that something is missing and roughly how big it is. Two
 * jurisdictions ARE modelled — New York City and Philadelphia — because their
 * rates were verified against the taxing authority itself.
 *
 * Why not model the rest: Maryland and Indiana levy genuinely county-level
 * taxes, which would fit this data model, but the Comptroller's and DOR's own
 * rate schedules are published as PDFs that could not be read reliably, and
 * Maryland has moved two counties to tiered rates for 2026. Everywhere else the
 * tax is MUNICIPAL, not county — Pennsylvania alone has some 2,500 rates and
 * Ohio around 600, so no single figure is correct for a whole county. Guessing
 * from secondary aggregators was rejected: a search summary put Philadelphia's
 * wage tax at 2.235% when the city itself publishes 3.735%.
 *
 *   scope       'county'    — every resident pays, set at county level
 *               'municipal' — varies by city or township within the county
 *               'city'      — only specific named cities levy it
 */
export const UNMODELLED_LOCAL_TAX = {
  MD: { scope: 'county', typical: '2.25-3.30%', note: 'Every Maryland county and Baltimore City levies a local income tax.' },
  IN: { scope: 'county', typical: '0.5-3%', note: 'All 92 Indiana counties levy a local income tax.' },
  OH: { scope: 'municipal', typical: '1-2.5%', note: 'Most Ohio municipalities levy an income tax; some school districts add another.' },
  PA: { scope: 'municipal', typical: '1-2%', note: 'Pennsylvania municipalities levy an Earned Income Tax. Philadelphia is modelled; the rest are not.' },
  MI: { scope: 'city', typical: '1-2.4%', note: 'Twenty-four Michigan cities, including Detroit and Grand Rapids, levy an income tax.' },
  KY: { scope: 'municipal', typical: '0.5-2.5%', note: 'Many Kentucky counties and cities levy an occupational licence tax on wages.' },
  MO: { scope: 'city', typical: '1%', note: 'Kansas City and St. Louis levy a 1% earnings tax; the rest of Missouri does not.' },
  AL: { scope: 'city', typical: '0.5-2%', note: 'Several Alabama cities, including Birmingham, levy an occupational tax.' },
  NY: { scope: 'city', typical: '3-3.9%', note: 'New York City is modelled. Yonkers levies a surcharge that is not.' },
  OR: { scope: 'municipal', typical: '0.8-2.5%', note: 'Portland-area residents pay Metro and Multnomah County income taxes.' },
  IA: { scope: 'municipal', typical: '0-20% surtax', note: 'Iowa school districts levy a surtax on state income tax liability.' },
  DE: { scope: 'city', typical: '1.25%', note: 'Wilmington levies a wage tax; the rest of Delaware does not.' },
  WV: { scope: 'city', typical: '$2-5/week', note: 'Some West Virginia cities levy a flat weekly service fee rather than a rate.' },
  CO: { scope: 'city', typical: '$4-6/month', note: 'A few Colorado cities levy a small flat occupational privilege tax.' },
  NJ: { scope: 'city', typical: '1%', note: 'Newark levies a payroll tax, generally on employers rather than employees.' },
};

/**
 * City-level income taxes that ARE computed. Omitting these materially flatters
 * the affected metros — NYC's top resident rate alone is ~3.9%.
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
