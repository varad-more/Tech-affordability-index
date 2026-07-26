/**
 * The "by state" page.
 *
 * Everything else on this site works at county level, because that is the
 * geography the data is honest at. But every job post, every tax comparison and
 * every relocation conversation is conducted in states, so refusing to say
 * anything at state level just leaves the reader to average it themselves,
 * badly.
 *
 * The compromise this page makes: no state is ever given a single number. It is
 * given a real county in the middle, the two real counties at its ends, and the
 * ratio between them. When that ratio is near 1 the state is one market and a
 * sentence about it means something. When it is 2, the state is several places
 * wearing one name, and the page says so.
 */

import { salaryBands, classify, monthlyNeeds } from '../src/bands.js';
import { totalTax } from '../src/tax.js';
import { STATES, LOCAL, TAX_YEAR, UNMODELLED_LOCAL_TAX } from '../src/tax-data.js';
import { CATEGORY_ORDER, CATEGORY_LABELS } from '../src/living-wage-parse.js';
import { rollUpStates } from '../src/state-rollup.js';
import { heatmap, rampLegend, rankedBarChart, pct, money } from './charts.js';
import { BAND_STEP } from './map.js';
import { initTheme } from './theme.js';
import { initFooter } from './footer.js';
import { dataUrl } from './data.js';

const $ = (sel) => document.querySelector(sel);

const DEFAULT_STATE = 'CA';

/** Same two measures as the explore page, and never mixed. */
const RENT_BASIS = {
  acs: {
    key: 'rentAcs',
    short: 'Census ACS',
    hint: 'Every county. Five-year average, includes utilities.',
  },
  zori: {
    key: 'rentZori',
    short: 'Zillow ZORI',
    hint: 'Current month, but only the ~1,360 counties Zillow indexes.',
  },
};

/**
 * One bedroom, matching the explore page's default.
 *
 * The unit-size control is deliberately not repeated here. This page compares
 * states, and a control that changes every row by roughly the same proportion
 * adds a decision without changing an answer.
 */
const UNIT = 'br1';

const state = {
  counties: null,
  rollups: null,
  /** Rollups keyed by state, ordered by their median county's monthly cost. */
  ordered: null,
  selected: DEFAULT_STATE,
  rentBasis: 'acs',
  salary: 130000,
  asOf: null,
};

/* ------------------------------------------------------------------ load */

async function load() {
  const [rents, countyZori, countyAcs, countyWage, basemap] = await Promise.all([
    fetch(dataUrl('rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-acs-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-living-wage.json')).then((r) => r.json()),
    fetch(dataUrl('us-basemap.json')).then((r) => r.json()),
  ]);

  state.asOf = rents.asOf;

  const zoriByFips = new Map(countyZori.counties.map((c) => [c.fips, c]));
  const acsByFips = new Map(countyAcs.counties.map((c) => [c.fips, c]));
  const geoByFips = new Map(basemap.counties.map((c) => [c.id, c]));

  state.counties = [];
  for (const wage of countyWage.counties) {
    const geo = geoByFips.get(wage.fips);
    if (!geo?.st || !STATES[geo.st]) continue;

    const zori = zoriByFips.get(wage.fips);
    const acs = acsByFips.get(wage.fips);
    if (!zori && !acs) continue;

    state.counties.push({
      fips: wage.fips,
      name: geo.name,
      state: geo.st,
      rentZori: zori?.rent ?? null,
      // The explore page's default unit size, with the same fallback: a
      // suppressed one-bedroom figure drops to the overall median rather than
      // dropping the county.
      rentAcs: acs ? (acs[UNIT] ?? acs.rent ?? null) : null,
      nonHousingMonthly: wage.nonHousingMonthly,
      expenses: wage.e ?? null,
    });
  }

  // Rollups first: the masthead counts the states that survived, and the picker
  // is built from the ones that have data on the basis currently selected.
  rebuildRollups();
  renderMasthead();
  bindInputs();
  initTheme(() => {
    // Both heatmaps pick their label ink from the resolved surface.
    renderCountyHeat();
    renderStateHeat();
  });
  initFooter();

  // Reveal before the first render: both heatmaps size their cells to the width
  // actually available, and a hidden container measures zero.
  $('#loading').hidden = true;
  $('#app').hidden = false;

  recompute();
  bindResize();
}

function bindResize() {
  let last = window.innerWidth;
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === last) return;
      last = window.innerWidth;
      renderCountyHeat();
      renderStateHeat();
      renderSpread();
    }, 140);
  });
}

/* ------------------------------------------------------------- the model */

const basis = () => RENT_BASIS[state.rentBasis];
const rentOf = (county) => county[basis().key];
const selected = () => state.rollups.get(state.selected);

/**
 * Roll every priced county up to its state.
 *
 * A single pass over ~3,100 counties, so it simply runs again when the rent
 * basis changes rather than being cached against a partial redraw.
 */
function rebuildRollups() {
  const priced = state.counties
    .filter((c) => rentOf(c) !== null)
    .map((c) => ({ ...c, rent: rentOf(c), needs: monthlyNeeds(rentOf(c), c.nonHousingMonthly) }));

  state.rollups = rollUpStates(priced);
  state.ordered = [...state.rollups.entries()]
    .map(([code, roll]) => ({ code, roll }))
    .sort((a, b) => b.roll.median.needs - a.roll.median.needs);

  // A state can have counties on one basis and none on the other, and landing
  // on an empty page reads as a broken one.
  if (!state.rollups.has(state.selected)) {
    state.selected = state.rollups.has(DEFAULT_STATE) ? DEFAULT_STATE : state.ordered[0].code;
  }
}

/** Everything the rent basis touches, which is everything. */
function recompute() {
  rebuildRollups();
  renderStateSelect();
  renderForState();
  renderStateHeat();
  renderSpread();
}

/** Everything the chosen state touches. */
function renderForState() {
  renderVerdict();
  renderTaxFacts();
  renderCountyHeat();
}

/** The tax picture for the salary on screen, in the selected state. */
const taxHere = () => totalTax(state.salary, { state: state.selected });

/* ------------------------------------------------------------- masthead */

function renderMasthead() {
  const month = new Date(`${state.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  // The count is the counties this page can actually price, not the row count of
  // any one source file: a county needs both a rent figure and a cost of living
  // before it can appear anywhere here.
  const priced = state.counties.filter((c) => c.rentAcs !== null || c.rentZori !== null).length;

  $('#tax-year-badge').textContent = TAX_YEAR;
  $('#freshness').innerHTML =
    `<span class="dot"></span> ${priced.toLocaleString()} counties · ` +
    `rent through <strong>${month}</strong> · ${TAX_YEAR} tax law · ` +
    `${state.rollups.size} states with data`;
}

/* --------------------------------------------------------------- inputs */

function renderStateSelect() {
  const select = $('#state-select');
  const codes = [...state.rollups.keys()].sort((a, b) =>
    STATES[a].name.localeCompare(STATES[b].name),
  );

  select.replaceChildren();
  for (const code of codes) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = STATES[code].name;
    select.appendChild(o);
  }
  select.value = state.selected;

  const roll = selected();
  $('#state-hint').textContent =
    `${roll.n.toLocaleString()} ${roll.n === 1 ? 'county' : 'counties'} priced on ` +
    `${basis().short}.`;
  $('#rent-basis-hint').textContent = basis().hint;
}

function bindInputs() {
  $('#state-select').addEventListener('change', (e) => {
    state.selected = e.target.value;
    renderStateSelect();
    renderForState();
  });

  $('#salary').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    // A part-typed number is not an error, and blanking the field to retype it
    // must not blank the page. Keep the last usable figure until there is a new one.
    if (!Number.isFinite(value) || value < 0 || e.target.value.trim() === '') return;
    state.salary = value;
    renderVerdict();
    renderTaxFacts();
  });

  $('#rent-basis').addEventListener('change', (e) => {
    state.rentBasis = e.target.value;
    recompute();
  });
}

/* --------------------------------------------------------------- verdict */

function renderVerdict() {
  const roll = selected();
  const name = STATES[state.selected].name;

  const tax = taxHere();
  const net = tax.net / 12;
  const band = classify(net, roll.median.needs);
  const bands = salaryBands({
    state: state.selected,
    rent: roll.median.rent,
    nonHousingMonthly: roll.median.nonHousingMonthly,
  });

  const verdict = $('#verdict');
  verdict.className = `verdict band-${band.id}`;
  verdict.style.setProperty('--band', `var(${BAND_STEP[band.id]})`);
  verdict.innerHTML =
    `<span class="verdict-chip">${band.label}</span>` +
    `<div class="verdict-text">in the median ${name} county, ${roll.median.name}, on ` +
    `${money(state.salary)} base. Comfortable there starts at ` +
    `<strong>${money(bands.comfortable)}</strong>. Across the state the same standard runs ` +
    `from ${money(salaryFor(roll.cheapest))} in ${roll.cheapest.name} to ` +
    `${money(salaryFor(roll.dearest))} in ${roll.dearest.name}.</div>`;

  const tiles = [
    {
      label: 'Median county',
      value: `${money(roll.median.needs)}/mo`,
      note: `${roll.median.name}, of ${roll.n.toLocaleString()} with data`,
    },
    {
      label: 'Cheapest county',
      value: `${money(roll.cheapest.needs)}/mo`,
      note: roll.cheapest.name,
    },
    {
      label: 'Dearest county',
      value: `${money(roll.dearest.needs)}/mo`,
      note: roll.dearest.name,
    },
    {
      label: 'Spread',
      value: `${roll.spread.toFixed(2)}×`,
      // No colour rail. A wide spread is not a bad state, it is a state that
      // needs more than one number, and the reserved good/short colours would
      // say something about California that this figure does not.
      note: roll.spread >= 1.6
        ? 'one figure cannot stand for this state'
        : 'close enough to one market to generalise',
    },
  ];

  $('#state-stats').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = t.rail ? `stat ${t.rail}` : 'stat';
      d.innerHTML =
        `<div class="label">${t.label}</div><div class="value">${t.value}</div>` +
        `<div class="note">${t.note}</div>`;
      return d;
    }),
  );

  const warning = $('#local-tax-warning');
  const unmodelled = UNMODELLED_LOCAL_TAX[state.selected];
  if (unmodelled) {
    warning.hidden = false;
    warning.textContent =
      `Heads up: ${unmodelled.note} Typically ${unmodelled.typical}, and it is NOT included ` +
      `anywhere on this page, so real take-home in ${name} is lower than shown.`;
  } else {
    warning.hidden = true;
  }
}

/** What "comfortable" costs in one county, in gross salary. */
function salaryFor(county) {
  return salaryBands({
    state: county.state,
    rent: county.rent,
    nonHousingMonthly: county.nonHousingMonthly,
  }).comfortable;
}

/* ------------------------------------------------------------ tax detail */

function renderTaxFacts() {
  const code = state.selected;
  const st = STATES[code];
  const tax = taxHere();

  // Which bracket this salary actually lands in, which is the figure a top-rate
  // comparison hides: New York's top rate is 10.9% and an entry-level engineer
  // there pays 5.9% at the margin.
  const taxable = Math.max(0, state.salary - st.standardDeduction);
  const bracket = [...st.brackets].reverse().find((b) => taxable > b.from);
  const topRate = st.brackets.at(-1)?.rate ?? 0;

  const local = LOCAL_BY_STATE[code];
  const unmodelled = UNMODELLED_LOCAL_TAX[code];

  const rows = [
    ['Income tax', st.brackets.length === 0
      ? '<strong>None.</strong> No state income tax on wages.'
      : st.brackets.length === 1
        ? `<strong>Flat ${pct(topRate, 2)}</strong> on income after the state deduction.`
        : `<strong>${st.brackets.length} brackets</strong>, ${pct(st.brackets[0].rate, 2)} up to ${pct(topRate, 2)}.`],
    ['Your marginal rate', st.brackets.length === 0
      ? 'Not applicable.'
      : `<strong>${pct(bracket?.rate ?? 0, 2)}</strong> on the next dollar of ${money(state.salary)}.`],
    ['State standard deduction', st.standardDeduction > 0
      ? `${money(st.standardDeduction)}, single filer. The federal one is different and is not reused.`
      : 'None, or not applicable.'],
    ['Employee payroll levies', st.payroll.length
      ? st.payroll.map((p) => `<strong>${p.label}</strong> at ${pct(p.rate, 2)}${p.cap ? ` to ${money(p.cap)}` : ' on all wages'}`).join('; ')
      : 'None modelled. About a dozen states run small paid-leave programmes that are not in this engine.'],
    ['Local income tax', local
      ? `${LOCAL[local].name} is modelled, for that city only.`
      : unmodelled
        ? `<strong>Levied but not modelled.</strong> ${unmodelled.note} Typically ${unmodelled.typical}.`
        : 'None known at county or municipal level.'],
    ['Total tax at this salary', `${money(tax.federal + tax.fica + tax.stateIncome + tax.statePayroll)} a year, an effective ${pct(tax.effectiveRate, 1)} of gross.`],
  ];

  $('#tax-facts').innerHTML = `
    <thead><tr><th>Rule</th><th>${STATES[code].name}</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody>`;

  const lines = [
    ['Gross base salary', tax.gross],
    ['Federal income tax', -tax.federal],
    ['FICA (Social Security + Medicare)', -tax.fica],
    [`${st.name} income tax`, -tax.stateIncome],
    ...tax.statePayrollDetail.map((d) => [d.label, -d.amount]),
  ];

  $('#tax-table').innerHTML = `
    <thead><tr><th>Item</th><th>Per year</th><th>Of gross</th></tr></thead>
    <tbody>${lines.map(([label, value]) => `
      <tr>
        <td>${label}</td>
        <td>${value < 0 ? '−' : ''}${money(Math.abs(value))}</td>
        <td>${tax.gross > 0 ? pct(Math.abs(value) / tax.gross, 1) : '–'}</td>
      </tr>`).join('')}</tbody>
    <tfoot><tr>
      <td><strong>Take-home</strong></td>
      <td><strong>${money(tax.net)}</strong></td>
      <td><strong>${pct(1 - tax.effectiveRate, 1)}</strong></td>
    </tr></tfoot>`;
}

/** The two cities whose local tax the engine models, by state. */
const LOCAL_BY_STATE = { NY: 'NYC', PA: 'PHL' };

/* -------------------------------------------------------------- heatmaps */

/**
 * Total first, then rent, then MIT's categories in their published order.
 *
 * The total column exists because both grids are sorted by it. Without it the
 * eye lands on the rent column, finds it out of order, and concludes the sort
 * is broken: Contra Costa sits above Alameda on a lower rent because everything
 * else there costs more, which is exactly the thing worth noticing and is
 * invisible if the number being ranked is not on screen.
 */
/**
 * Shorter than the breakdown table's labels, because a heatmap header is
 * centred over one 74px cell rather than sitting in a column of its own:
 * "Civic & recreation" ran straight into "Internet & phone".
 */
const SHORT_LABELS = {
  Transportation: 'Transport',
  'Internet & Mobile': 'Internet',
  Civic: 'Civic & rec',
  Other: 'Other',
  Food: 'Groceries',
  Medical: 'Healthcare',
};

const COLUMNS = [
  { title: 'Total', subtitle: 'per month' },
  { title: 'Rent', subtitle: 'measured' },
  ...CATEGORY_ORDER.map((key) => ({
    title: SHORT_LABELS[key] ?? CATEGORY_LABELS[key] ?? key,
    subtitle: 'MIT',
  })),
];

/** One heatmap row: the total, rent, then each budget line, all monthly dollars. */
function budgetRow(county) {
  const parts = [county.needs, county.rent, ...(county.expenses ?? CATEGORY_ORDER.map(() => null))];

  return parts.map((value, i) => ({
    value,
    tooltip:
      `<div class="t-title">${county.name}</div>` +
      `<div class="t-row">${COLUMNS[i].title}: <strong>${value === null ? 'no figure' : `${money(value)}/mo`}</strong></div>` +
      `<div class="t-row">${money(county.needs)}/mo for one adult, all in</div>`,
  }));
}

function renderCountyHeat() {
  const roll = selected();
  const name = STATES[state.selected].name;
  // Dearest first, so the row a reader is most likely looking for is at the top
  // rather than at the bottom of a scroll.
  const counties = [...state.counties]
    .filter((c) => c.state === state.selected && rentOf(c) !== null)
    .map((c) => ({ ...c, rent: rentOf(c), needs: monthlyNeeds(rentOf(c), c.nonHousingMonthly) }))
    .sort((a, b) => b.needs - a.needs);

  $('#inside-state').textContent = name;
  $('#county-heat-intro').textContent =
    `Every ${name} county with a rent figure, ranked by what a month costs one adult. This ` +
    `is the spread the state figure above is hiding, and it is why no page on this site ` +
    `shades a state as one colour. Where a column is flat, MIT publishes that line of the ` +
    `budget at state level and it genuinely does not vary within ${name}.`;

  heatmap($('#county-heat'), {
    rowLabels: counties.map((c) =>
      c.name.replace(/ (County|Parish|Borough|Census Area|Municipality|city)$/, ''),
    ),
    colLabels: COLUMNS,
    cells: counties.map(budgetRow),
    format: (v) => money(v),
    scale: 'column',
    gutter: 132,
    focusable: false,
    label: `Monthly cost of living for one adult, by ${name} county and budget line`,
  });

  rampLegend($('#county-heat-legend'), 'cheapest in state', 'dearest in state');

  $('#county-heat-caption').textContent =
    `${counties.length.toLocaleString()} ${counties.length === 1 ? 'county' : 'counties'} · ` +
    `${money(roll.cheapest.needs)} to ${money(roll.dearest.needs)} a month for one adult · ` +
    `shaded within each column, against the other ${name} counties`;
}

function renderStateHeat() {
  const rows = state.ordered;

  heatmap($('#state-heat'), {
    rowLabels: rows.map(({ code }) => STATES[code].name),
    colLabels: COLUMNS,
    cells: rows.map(({ code, roll }) =>
      budgetRow({ ...roll.median, name: `${roll.median.name}, ${code}` }),
    ),
    format: (v) => money(v),
    scale: 'column',
    gutter: 132,
    focusable: false,
    label: 'Monthly cost of living for one adult in each state\'s median county, by budget line',
  });

  rampLegend($('#state-heat-legend'), 'cheapest state', 'dearest state');

  const top = rows[0];
  const bottom = rows.at(-1);
  const missing = Object.keys(STATES).filter((code) => !state.rollups.has(code));

  $('#state-heat-caption').textContent =
    `${rows.length} of the 51 states and DC, by what a month costs one adult in their ` +
    `median county · ${STATES[top.code].name} at ${money(top.roll.median.needs)} down to ` +
    `${STATES[bottom.code].name} at ${money(bottom.roll.median.needs)} · ` +
    `rent on the ${basis().short} basis` +
    (missing.length
      ? ` · ${missing.map((c) => STATES[c].name).join(', ')} absent, with no county ` +
        `joining both a rent figure and a cost of living`
      : '');
}

/* ---------------------------------------------------------------- spread */

function renderSpread() {
  // Ranked magnitude, so a ranked bar rather than a second heatmap. Fifteen is
  // where the tail flattens: below it the differences stop being interesting.
  //
  // The bars carry `spread - 1`, the amount by which the dearest county exceeds
  // the cheapest, not the ratio itself. A bar is a length from zero, and a state
  // with no spread at all has a ratio of 1.0 — drawn as a ratio it would get a
  // third of the plot for "these counties cost the same", which is a lie the
  // chart tells before anybody reads the axis.
  const rows = [...state.ordered]
    .filter(({ roll }) => roll.n > 1 && roll.spread !== null)
    .sort((a, b) => b.roll.spread - a.roll.spread)
    .slice(0, 15)
    .reverse()
    .map(({ code, roll }) => ({
      label: STATES[code].name,
      value: roll.spread - 1,
      tooltip:
        `<div class="t-title">${STATES[code].name}</div>` +
        `<div class="t-row">${roll.dearest.name} <strong>${money(roll.dearest.needs)}</strong>/mo</div>` +
        `<div class="t-row">${roll.cheapest.name} <strong>${money(roll.cheapest.needs)}</strong>/mo</div>` +
        `<div class="t-row">${roll.spread.toFixed(2)}× across ${roll.n} counties</div>`,
    }));

  rankedBarChart($('#spread'), rows, {
    gutter: 150,
    label: 'How much dearer each state\'s most expensive county is than its cheapest, ranked',
  });

  $('#spread-caption').textContent =
    `How much more a month costs in each state's dearest county than in its cheapest, ` +
    `for one adult, on the ${basis().short} basis. States with only one county priced ` +
    `are excluded, since a range needs two ends.`;
}

/* ------------------------------------------------------------------ boot */

load().catch((err) => {
  $('#loading').innerHTML =
    `<strong>Could not load county data.</strong> ${err.message}. If you opened this file ` +
    `directly, serve it over HTTP instead: run <code>npm run serve</code>.`;
});
