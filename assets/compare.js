/**
 * The "compare two counties" page.
 *
 * Every other page on this site holds a place still and asks what it costs. This
 * one holds a *standard of living* still and asks what it costs in two places —
 * which is the question anyone actually looking at an out-of-state offer has, and
 * the one a salary figure on its own cannot answer, because a move changes what
 * the place costs and what the state takes in the same instant.
 *
 * The arithmetic is not here. `equivalentSalary` in engine.js evaluates curves
 * Python published, and `app/bands.py` holds the specification the parity fixture
 * pins it to. What lives in this file is which counties are offerable, what the
 * verdict says, and how the difference is drawn.
 *
 * Two readings are always shown and never averaged into one. Holding your needs
 * *share* constant assumes discretionary spending scales with the destination;
 * holding your *surplus* constant assumes none of it does. They bracket the
 * honest answer, and picking one silently would be taking a side in an argument
 * the reader is better placed to settle.
 */

import * as engine from './engine.js';
import { divergingBars, showTooltip, hideTooltip, pct, money } from './charts.js';
import { countyMap, rampLegendFor } from './map.js';
import { countyPicker, indexCounty } from './county-picker.js';
import { initTheme } from './theme.js';
import { initFooter } from './footer.js';
import { dataUrl } from './data.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Model constants, fetched at boot. `let` rather than `const` because they arrive
 * over the network and are only ever read; nothing below runs before `load()` has
 * awaited `engine.boot()`.
 */
let STATES = {};
let LOCAL = {};
let TAX_YEAR = 0;
let UNMODELLED_LOCAL_TAX = {};
let CATEGORY_ORDER = [];
let CATEGORY_LABELS = {};

/** Travis County, TX — cheap, no state income tax, on both rent bases. */
const DEFAULT_FROM = '48453';
/** San Francisco County, CA — the other end of both axes at once. */
const DEFAULT_TO = '06075';

/** The two rent measures, never converted into one another. */
const RENT_BASIS = {
  acs: {
    key: 'rentAcs',
    short: 'Census ACS',
    hint: 'Every county. Five-year average, includes utilities, sized by unit.',
    hasBedrooms: true,
  },
  zori: {
    key: 'rentZori',
    short: 'Zillow ZORI',
    hint: 'Current month, all sizes pooled, only where Zillow indexes.',
    hasBedrooms: false,
  },
};

/** Matching the explore page: a single adult is priced against a one-bedroom. */
const UNIT_SIZES = [
  { key: 'br1', label: '1 bedroom' },
  { key: 'studio', label: 'Studio' },
  { key: 'br2', label: '2 bedrooms' },
  { key: 'all', label: 'All sizes' },
];

/**
 * Class breaks for the map, on the salary a county demands as a multiple of what
 * the reader earns today.
 *
 * Anchored on 1.0 rather than on quantiles, because 1.0 is the only break that
 * means something on its own: below it the move is affordable at your current
 * salary, above it it is not. Round multiples either side keep the legend
 * readable ("you would need half as much again") instead of "the fifth seventh".
 *
 * Fixed rather than rescaled per origin, so switching the origin county shows a
 * change in the data rather than a change in the scale underneath it.
 */
const MULTIPLE_BREAKS = [0.7, 0.85, 1.0, 1.2, 1.5, 2.0];

/** Legend copy, lightest (cheapest destination) first. */
const MULTIPLE_CLASSES = [
  { label: 'under 70%', note: 'you could take a large pay cut and still come out ahead' },
  { label: '70-85%' },
  { label: '85-100%', note: 'slightly less than you earn now' },
  { label: '100-120%' },
  { label: '120-150%' },
  { label: '150-200%' },
  { label: 'over 200%', note: 'you would have to more than double your salary' },
];

/** Which class a multiple falls in: 0 (cheapest) to 6 (dearest). */
function multipleStep(multiple) {
  if (multiple === null || multiple === undefined || !Number.isFinite(multiple)) return null;
  for (let i = 0; i < MULTIPLE_BREAKS.length; i += 1) {
    if (multiple <= MULTIPLE_BREAKS[i]) return i;
  }
  return MULTIPLE_BREAKS.length;
}

const state = {
  counties: null,
  countyList: null,
  fromPicker: null,
  toPicker: null,
  basemap: null,
  map: null,
  from: DEFAULT_FROM,
  to: DEFAULT_TO,
  salary: 130000,
  rentBasis: 'acs',
  unitSize: 'br1',
  asOf: null,
};

/** What the engine computed for the current pair, salary and basis. */
const computed = {
  pair: null,
  everywhere: null,
};

const basis = () => RENT_BASIS[state.rentBasis];
const countyOf = (fips) => state.counties.get(fips) ?? null;

/* ------------------------------------------------------------------ load */

async function load() {
  const meta = await engine.boot();
  ({
    states: STATES,
    categoryOrder: CATEGORY_ORDER,
    categoryLabels: CATEGORY_LABELS,
    taxYear: TAX_YEAR,
    unmodelledLocalTax: UNMODELLED_LOCAL_TAX,
  } = meta);
  LOCAL = Object.fromEntries(
    Object.entries(meta.modelledLocalTax).map(([code, name]) => [code, { name }]),
  );

  const [rents, countyZori, countyAcs, countyWage, basemap] = await Promise.all([
    fetch(dataUrl('rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-acs-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-living-wage.json')).then((r) => r.json()),
    fetch(dataUrl('us-basemap.json')).then((r) => r.json()),
  ]);

  state.asOf = rents.asOf;
  state.basemap = basemap;

  const zoriByFips = new Map(countyZori.counties.map((c) => [c.fips, c]));
  const acsByFips = new Map(countyAcs.counties.map((c) => [c.fips, c]));
  const geoByFips = new Map(basemap.counties.map((c) => [c.id, c]));

  // Cost of living is the spine, exactly as on the explore page: a county with no
  // MIT budget cannot be scored on any rent basis, so it is never offerable.
  state.counties = new Map();
  for (const wage of countyWage.counties) {
    const geo = geoByFips.get(wage.fips);
    if (!geo?.st || !STATES[geo.st]) continue;

    const zori = zoriByFips.get(wage.fips);
    const acs = acsByFips.get(wage.fips);
    if (!zori && !acs) continue;

    state.counties.set(wage.fips, indexCounty({
      fips: wage.fips,
      name: geo.name,
      state: geo.st,
      metro: zori?.metro ?? null,
      rentZori: zori?.rent ?? null,
      rentAcs: acs?.rent ?? null,
      acsByUnit: acs
        ? { all: acs.rent ?? null, studio: acs.studio ?? null, br1: acs.br1 ?? null, br2: acs.br2 ?? null }
        : null,
      nonHousingMonthly: wage.nonHousingMonthly,
      expenses: wage.e ?? null,
    }));
  }

  state.countyList = [...state.counties.values()].sort((a, b) => a.label.localeCompare(b.label));

  renderMasthead(countyZori, countyAcs);
  buildPickers();
  renderUnitSizePicker();
  buildMap();
  bindInputs();
  initTheme();
  initFooter();

  // Reveal before the first render: the chart sizes itself to the width actually
  // available and the map frames a county from a bounding box. Both measure zero
  // inside a hidden container.
  $('#loading').hidden = true;
  $('#app').hidden = false;

  await renderAll();
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
      renderDelta();
    }, 140);
  });
}

/* ------------------------------------------------------------- the model */

/**
 * Both answers for the current selection.
 *
 * The pair drives everything above the map; the national solve drives the map.
 * They are fetched together because they share the same counties file, and they
 * go through the same `matchIn` inside the engine, so the county under the
 * cursor and the county in the verdict cannot disagree.
 */
async function syncEngine() {
  const [pair, everywhere] = await Promise.all([
    engine.comparePair(state.from, state.to, state.salary, state.rentBasis, state.unitSize),
    engine.equivalentEverywhere(state.from, state.salary, state.rentBasis, state.unitSize),
  ]);
  computed.pair = pair;
  computed.everywhere = everywhere;
}

/** Rent for a county on the active basis and unit size, for the picker rows. */
function rentInfo(county) {
  if (!basis().hasBedrooms) return { rent: county.rentZori, fellBack: false };

  const sized = county.acsByUnit?.[state.unitSize] ?? null;
  if (sized !== null) return { rent: sized, fellBack: false };
  return { rent: county.rentAcs, fellBack: state.unitSize !== 'all' };
}

/* --------------------------------------------------------------- render */

function renderMasthead(countyZori, countyAcs) {
  const month = new Date(`${state.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  $('#freshness').innerHTML =
    `<span class="dot"></span> ${state.counties.size.toLocaleString()} counties · ` +
    `Zillow rents <strong>${month}</strong> · Census ACS ${countyAcs.vintage} · ` +
    `MIT living wage, ${countyZori.countyCount.toLocaleString()} counties on both`;

  $('#tax-year-badge').textContent = TAX_YEAR;
}

function renderUnitSizePicker() {
  const select = $('#unit-size');
  select.replaceChildren();
  for (const size of UNIT_SIZES) {
    const o = document.createElement('option');
    o.value = size.key;
    o.textContent = size.label;
    if (size.key === state.unitSize) o.selected = true;
    select.appendChild(o);
  }
  syncUnitSizeControl();
}

function syncUnitSizeControl() {
  const supported = basis().hasBedrooms;
  $('#unit-size').disabled = !supported;
  $('#unit-size-hint').textContent = supported
    ? 'Applied to both counties, so the comparison stays like for like.'
    : 'Zillow publishes no bedroom breakdown, so all unit sizes are pooled.';
  $('#rent-basis-hint').textContent = basis().hint;
}

/* ------------------------------------------------------------- pickers */

/**
 * Two pickers, one factory.
 *
 * `countyPicker` owns its own filter state, so the two instances share nothing —
 * which is the whole reason the destination list can be narrowed to one state
 * while the origin list stays national.
 */
function buildPickers() {
  const meta = (county) => {
    const { rent } = rentInfo(county);
    return rent === null ? { text: 'no data', muted: true } : { text: money(rent) };
  };

  state.fromPicker = countyPicker({
    counties: state.countyList,
    input: $('#from-county'),
    listbox: $('#from-listbox'),
    toggle: $('#from-toggle'),
    status: $('#from-status'),
    stateSelect: $('#from-state'),
    stateHint: $('#from-state-hint'),
    selected: () => countyOf(state.from),
    onSelect: (fips) => selectCounty('from', fips),
    meta,
    idleHint: 'Narrow the list, or search the whole country.',
  });

  state.toPicker = countyPicker({
    counties: state.countyList,
    input: $('#to-county'),
    listbox: $('#to-listbox'),
    toggle: $('#to-toggle'),
    status: $('#to-status'),
    stateSelect: $('#to-state'),
    stateHint: $('#to-state-hint'),
    selected: () => countyOf(state.to),
    onSelect: (fips) => selectCounty('to', fips),
    meta,
    // The destination list is the one people narrow by state, because a move is
    // usually to somewhere in particular rather than to anywhere at all.
    onStateFilter: (code) => {
      if (code) state.map?.zoomToState(code);
      else state.map?.reset();
    },
    idleHint: 'Narrow to the state you are considering, or search everywhere.',
  });
}

/** The one path into a selection on either side. */
function selectCounty(side, fips) {
  if (!state.counties.has(fips) || state[side] === fips) {
    // Even a no-op has to put the label back: the box may be holding a query.
    (side === 'from' ? state.fromPicker : state.toPicker).sync();
    return;
  }
  state[side] = fips;
  renderAll().catch(showError);
}

function syncPickers() {
  state.fromPicker.sync();
  state.toPicker.sync();

  for (const [side, fips] of [['from', state.from], ['to', state.to]]) {
    const county = countyOf(fips);
    const local = engine.localFor(fips);
    $(`#${side}-hint`).textContent =
      `${STATES[county.state].name}${local ? ` · ${LOCAL[local].name}` : ''}` +
      `${county.metro ? ` · ${county.metro}` : ''}`;
  }
}

/* ------------------------------------------------------------- verdict */

/**
 * The direction of a move, in the words the chip uses and the colour it wears.
 *
 * Diverging rather than the band ramp the other pages use, and deliberately the
 * same two hues as the chart below it: "needs more" and "needs less" are opposite
 * signs of one quantity with a real midpoint, not two points on a scale of bad.
 */
function direction(from, to) {
  if (to === null) return { chip: 'No answer', tone: 'var(--map-nodata)' };
  const change = to / from - 1;
  if (Math.abs(change) < 0.005) return { chip: 'Break-even', tone: 'var(--div-mid)' };
  return change > 0
    ? { chip: `Needs ${pct(change, 0)} more`, tone: 'var(--div-warm)' }
    : { chip: `Could take ${pct(-change, 0)} less`, tone: 'var(--div-cool)' };
}

function renderVerdict() {
  const pair = computed.pair;
  const verdict = $('#verdict');

  if (!pair.available) {
    const missingSide = !pair.from.available ? 'from' : 'to';
    const county = countyOf(missingSide === 'from' ? state.from : state.to);
    const other = state.rentBasis === 'acs' ? 'zori' : 'acs';
    const hasOther = county[RENT_BASIS[other].key] !== null;

    verdict.className = 'verdict';
    verdict.style.setProperty('--band', 'var(--map-nodata)');
    verdict.innerHTML =
      '<span class="verdict-chip">No data</span>' +
      `<div class="verdict-text">No ${basis().short} rent figure is published for ` +
      `${county.name}, so there is nothing to compare against.` +
      (hasOther ? ` Switch the rent basis to ${RENT_BASIS[other].short} to see it.` : '') +
      '</div>';
    $('#compare-stats').replaceChildren();
    $('#reading-note').textContent = '';
    return;
  }

  const { equivalence: eq, from, to } = pair;
  const fromCounty = countyOf(state.from);
  const toCounty = countyOf(state.to);

  // No take-home means no standard of living to hold constant, which is a real
  // answer rather than a failure — so it gets said rather than swallowed.
  if (eq.sameShare === null) {
    verdict.className = 'verdict';
    verdict.style.setProperty('--band', 'var(--map-nodata)');
    verdict.innerHTML =
      '<span class="verdict-chip">No answer</span>' +
      `<div class="verdict-text">${money(state.salary)} leaves no take-home pay in ` +
      `${fromCounty.name}, so there is no standard of living to carry to ` +
      `${toCounty.name}.</div>`;
    $('#compare-stats').replaceChildren();
    $('#reading-note').textContent = '';
    return;
  }

  const dir = direction(state.salary, eq.sameShare);
  verdict.className = 'verdict';
  verdict.style.setProperty('--band', dir.tone);
  verdict.innerHTML =
    `<span class="verdict-chip">${dir.chip}</span>` +
    `<div class="verdict-text">` +
    `<strong>${money(state.salary)}</strong> in ${fromCounty.name}, ${fromCounty.state} ` +
    `is <strong>${money(eq.sameShare)}</strong> in ${toCounty.name}, ${toCounty.state}. ` +
    `Necessities take ${pct(eq.fromNeedsShare, 0)} of take-home in both.</div>`;

  const change = eq.sameShare - state.salary;
  const surplusChange = eq.sameSurplus - state.salary;

  const tiles = [
    {
      label: 'Equivalent salary',
      value: money(eq.sameShare),
      note: `holds necessities at ${pct(eq.fromNeedsShare, 0)} of take-home`,
    },
    {
      label: change >= 0 ? 'Raise required' : 'Cut you could absorb',
      value: `${change >= 0 ? '+' : '−'}${money(Math.abs(change))}`,
      value2: pct(Math.abs(change) / state.salary, 0),
      note: `on ${money(state.salary)} today`,
      rail: change <= 0 ? 'is-good' : 'is-short',
    },
    {
      label: 'If you match the dollars instead',
      value: money(eq.sameSurplus),
      note:
        `${surplusChange >= 0 ? '+' : '−'}${money(Math.abs(surplusChange))} · keeps ` +
        `${money(Math.abs(eq.fromMonthlySurplus))}/mo ` +
        `${eq.fromMonthlySurplus >= 0 ? 'left over' : 'short'}`,
    },
    {
      label: 'What a month costs',
      value: `${money(eq.fromMonthlyNeeds)} → ${money(eq.toMonthlyNeeds)}`,
      note: `${money(from.rent)} → ${money(to.rent)} of that is rent`,
    },
  ];

  $('#compare-stats').replaceChildren(...tiles.map(statTile));

  // Which reading is the tighter constraint is not fixed: moving somewhere dearer
  // the share reading asks for more, moving somewhere cheaper it concedes more.
  // Saying which is which here beats leaving the reader to infer it from two
  // numbers that swap places.
  const spread = Math.abs(eq.sameShare - eq.sameSurplus);
  $('#reading-note').innerHTML = spread < 1
    ? `Both readings land on the same salary here: the two counties cost close ` +
      `enough that there is nothing to argue about.`
    : `The two readings are <strong>${money(spread)}</strong> apart. ` +
      `${money(Math.max(eq.sameShare, eq.sameSurplus))} assumes the spending you do ` +
      `beyond necessities moves with the cost of living; ` +
      `${money(Math.min(eq.sameShare, eq.sameSurplus))} assumes none of it does. ` +
      `Where you sit between them depends on how much of your life is bought locally.`;
}

function statTile(t) {
  const d = document.createElement('div');
  d.className = t.rail ? `stat ${t.rail}` : 'stat';
  d.innerHTML =
    `<div class="label">${t.label}</div>` +
    `<div class="value">${t.value}${t.value2 ? ` <span class="value-sub">${t.value2}</span>` : ''}</div>` +
    `<div class="note">${t.note}</div>`;
  return d;
}

/** Either end of the move levying a city tax this project does not model. */
function renderLocalTaxWarning() {
  const warning = $('#local-tax-warning');
  const offenders = [];

  for (const [label, fips] of [['leaving', state.from], ['arriving in', state.to]]) {
    const county = countyOf(fips);
    const unmodelled = UNMODELLED_LOCAL_TAX[county.state];
    if (unmodelled && !engine.localFor(fips)) {
      offenders.push(`${label} ${county.name} (${unmodelled.note} typically ${unmodelled.typical})`);
    }
  }

  warning.hidden = offenders.length === 0;
  if (offenders.length) {
    warning.textContent =
      `Heads up: local income tax is not modelled on one or both ends of this move. ` +
      `You are ${offenders.join('; ')}. Neither figure above includes it, so the real ` +
      `gap is wider than the page says.`;
  }
}

/* --------------------------------------------------- where it goes */

/**
 * Every monthly line that changes, signed.
 *
 * Cost of living plus income tax, because a move is both at once and a chart
 * showing only the first would be making the page's own argument badly. Tax is
 * measured at the reader's *current* salary on both ends, which isolates the
 * jurisdiction from the raise — comparing tax at two different salaries would
 * mix "this state takes more" with "you earn more now".
 *
 * That definition buys an identity worth having: these bars sum to exactly what
 * the naive move costs per month, because the only two things that can move your
 * surplus at a fixed salary are what you pay in tax and what the place costs.
 */
function renderDelta() {
  const mount = $('#delta');
  const pair = computed.pair;

  if (!pair.available) {
    mount.replaceChildren();
    $('#delta-intro').textContent = '';
    $('#delta-caption').textContent = '';
    $('#compare-table').innerHTML = '';
    return;
  }

  const { from, toAtSameSalary: naive } = pair;
  const fromCounty = countyOf(state.from);
  const toCounty = countyOf(state.to);

  const bars = [{
    label: 'Rent',
    value: naive.rent - from.rent,
  }];

  // The MIT categories are positional and shared by both counties, so a county
  // missing the breakdown collapses to one bar rather than dropping the chart.
  if (from.breakdown && naive.breakdown) {
    CATEGORY_ORDER.forEach((key, i) => {
      bars.push({
        label: CATEGORY_LABELS[key] ?? key,
        value: naive.breakdown[i] - from.breakdown[i],
      });
    });
  } else {
    bars.push({
      label: 'Everything else',
      value: naive.nonHousingMonthly - from.nonHousingMonthly,
    });
  }

  bars.push({
    label: 'Income tax',
    value: (naive.tax.total - from.tax.total) / 12,
  });

  const signed = (v) => `${v < 0 ? '−' : '+'}${money(Math.abs(v))}`;

  divergingBars(
    mount,
    bars.map((b) => ({
      ...b,
      tooltip:
        `<div class="t-row"><strong>${b.label}</strong></div>` +
        `<div class="t-row">${signed(b.value)} a month</div>` +
        `<div class="t-row t-muted">${b.value >= 0 ? 'dearer' : 'cheaper'} in ${toCounty.name}</div>`,
    })),
    {
      format: signed,
      label:
        `Monthly change in each cost of living category and in income tax, moving from ` +
        `${fromCounty.name} to ${toCounty.name}`,
    },
  );

  const total = bars.reduce((sum, b) => sum + b.value, 0);

  $('#delta-intro').innerHTML =
    `Each bar is one monthly line, ${fromCounty.name} subtracted from ${toCounty.name}. ` +
    `Warm bars cost more after the move, cool bars less. Income tax is measured at your ` +
    `<em>current</em> salary on both ends, so this shows what the jurisdiction does, not ` +
    `what the raise does.`;

  $('#delta-caption').innerHTML =
    `They add up to <strong>${signed(total)} a month</strong>, or ` +
    `${money(Math.abs(total * 12))} a year. That sum is exact rather than indicative: at ` +
    `a fixed salary the only two things that can move the money left after necessities ` +
    `are what you pay in tax and what the place costs. So moving on the same salary would ` +
    `leave you ${total >= 0 ? 'worse' : 'better'} off by precisely that much, and closing ` +
    `the gap is what the equivalent salary above is for.`;

  renderCompareTable();
}

function renderCompareTable() {
  const { from, toAtSameSalary: naive, to, equivalence: eq } = computed.pair;
  const fromCounty = countyOf(state.from);
  const toCounty = countyOf(state.to);

  const shareText = (share) => (share === null ? '–' : pct(share, 0));
  const surplus = (assessment) =>
    `${assessment.monthlySurplus < 0 ? '−' : ''}${money(Math.abs(assessment.monthlySurplus))}`;

  // `to` is null only when there is no equivalent to assess, which the verdict
  // has already explained; the column still exists so the table keeps its shape.
  const third = (render, fallback = '–') => (to ? render(to) : fallback);

  const rows = [
    ['Salary', money(from.salary), money(naive.salary), third(() => money(eq.sameShare))],
    ['Take-home', `${money(from.monthlyNet)}/mo`, `${money(naive.monthlyNet)}/mo`,
      third((t) => `${money(t.monthlyNet)}/mo`)],
    ['Rent', `${money(from.rent)}/mo`, `${money(naive.rent)}/mo`, third((t) => `${money(t.rent)}/mo`)],
    ['Everything else', `${money(from.nonHousingMonthly)}/mo`, `${money(naive.nonHousingMonthly)}/mo`,
      third((t) => `${money(t.nonHousingMonthly)}/mo`)],
    ['Necessities', `${money(from.monthlyNeeds)}/mo`, `${money(naive.monthlyNeeds)}/mo`,
      third((t) => `${money(t.monthlyNeeds)}/mo`)],
    ['Share of take-home', shareText(from.needsShare), shareText(naive.needsShare),
      third((t) => shareText(t.needsShare))],
    ['Left over', `${surplus(from)}/mo`, `${surplus(naive)}/mo`, third((t) => `${surplus(t)}/mo`)],
    ['Total tax', money(from.tax.total), money(naive.tax.total), third((t) => money(t.tax.total))],
    ['Effective rate', pct(from.tax.effectiveRate, 1), pct(naive.tax.effectiveRate, 1),
      third((t) => pct(t.tax.effectiveRate, 1))],
    ['Verdict', from.band.label, naive.band.label, third((t) => t.band.label)],
  ];

  const body = rows
    .map(([label, a, b, c]) => `<tr><td>${label}</td><td>${a}</td><td>${b}</td><td>${c}</td></tr>`)
    .join('');

  $('#compare-table').innerHTML = `
    <thead><tr>
      <th></th>
      <th>${fromCounty.name}<span class="th-sub">today</span></th>
      <th>${toCounty.name}<span class="th-sub">same salary</span></th>
      <th>${toCounty.name}<span class="th-sub">equivalent salary</span></th>
    </tr></thead>
    <tbody>${body}</tbody>`;
}

/* ------------------------------------------------------------------ map */

function buildMap() {
  state.map = countyMap($('#map'), {
    basemap: state.basemap,
    // Clicking the map picks the destination. The origin is where you already
    // are, which is not something anyone discovers by browsing.
    onSelect: (fips) => selectCounty('to', fips),
    onHover: (fips, event) => {
      if (!fips) return hideTooltip();
      showMapTooltip(fips, event);
    },
    onLocate: () => state.to,
    locateLabel: 'Zoom to the destination county',
    label:
      'County-level map of the United States, shaded by the salary each county would ' +
      'demand to match your current standard of living. Zoom with the plus and minus ' +
      'keys, pan with the arrow keys.',
  });
}

let legendKey = null;
function syncMapLegend() {
  // Rebuilt only when the wording changes, because painting runs on every
  // keystroke in the salary field.
  const key = `${state.rentBasis}|${state.salary}`;
  if (legendKey === key) return;
  legendKey = key;

  rampLegendFor($('#map-legend'), MULTIPLE_CLASSES, {
    caption: `Salary needed there, as a share of the ${money(state.salary)} you earn now`,
    noDataNote: `${basis().short} publishes no rent figure for this county.`,
  });
}

function paintMap() {
  const steps = new Map();
  for (const [fips, answer] of Object.entries(computed.everywhere.salaries ?? {})) {
    steps.set(fips, multipleStep(answer.sameShare / state.salary));
  }
  state.map.paint(steps, state.to);
  syncMapLegend();

  const priced = steps.size;
  const cheaper = [...steps.values()].filter((s) => s !== null && s <= 2).length;

  $('#map-intro').innerHTML =
    `The same solve, run against every county in the country at once. Each one is shaded ` +
    `by the salary it would take to live there exactly as well as you live in ` +
    `<strong>${countyOf(state.from).name}</strong> on ${money(state.salary)} today. ` +
    `Click any county to make it the destination.`;

  $('#map-caption').textContent = computed.everywhere.available
    ? `${cheaper.toLocaleString()} of ${priced.toLocaleString()} priced counties would ` +
      `cost you no more than you already earn. The outlined county is the destination ` +
      `selected above.`
    : 'No shading: this salary leaves no take-home pay to carry anywhere.';

  renderMapTable();
}

function showMapTooltip(fips, event) {
  const county = countyOf(fips);
  const answer = computed.everywhere.salaries?.[fips];
  if (!county) return hideTooltip();

  if (!answer) {
    showTooltip(
      `<div class="t-title">${county.name}, ${county.state}</div>` +
      `<div class="t-row t-muted">No ${basis().short} rent figure published</div>`,
      event,
    );
    return;
  }

  const change = answer.sameShare / state.salary - 1;
  showTooltip(
    `<div class="t-title">${county.name}, ${county.state}</div>` +
    `<div class="t-row"><strong>${money(answer.sameShare)}</strong> to match your ` +
    `standard of living</div>` +
    `<div class="t-row">${change >= 0 ? '+' : '−'}${pct(Math.abs(change), 0)} on ` +
    `${money(state.salary)}</div>` +
    `<div class="t-row t-muted">${money(answer.sameSurplus)} to match the dollars ` +
    `left over</div>`,
    event,
  );
}

/**
 * The extremes as a table, because colour is the map's only encoding.
 *
 * Ten each end rather than all 3,000: the point is to make the shading readable
 * as numbers, not to reproduce the dataset in a disclosure widget.
 */
function renderMapTable() {
  const rows = Object.entries(computed.everywhere.salaries ?? {})
    .map(([fips, answer]) => ({ fips, county: countyOf(fips), value: answer.sameShare }))
    .filter((r) => r.county && Number.isFinite(r.value))
    .sort((a, b) => a.value - b.value);

  if (rows.length === 0) {
    $('#map-table').innerHTML = '';
    return;
  }

  const line = (r) =>
    `<tr>
       <td>${r.county.name}, ${r.county.state}</td>
       <td>${money(r.value)}</td>
       <td>${r.value >= state.salary ? '+' : '−'}${pct(Math.abs(r.value / state.salary - 1), 0)}</td>
     </tr>`;

  const cheapest = rows.slice(0, 10).map(line).join('');
  const dearest = rows.slice(-10).reverse().map(line).join('');

  $('#map-table').innerHTML = `
    <thead><tr><th>County</th><th>Salary needed</th><th>vs today</th></tr></thead>
    <tbody>
      <tr><td colspan="3"><strong>Where the same life costs least</strong></td></tr>
      ${cheapest}
      <tr><td colspan="3"><strong>Where it costs most</strong></td></tr>
      ${dearest}
    </tbody>`;
}

/* --------------------------------------------------------------- inputs */

function bindInputs() {
  $('#salary').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    state.salary = Number.isFinite(value) && value >= 0 ? value : 0;
    scheduleRedraw();
  });

  $('#rent-basis').addEventListener('change', (e) => {
    state.rentBasis = e.target.value;
    syncUnitSizeControl();
    renderAll().catch(showError);
  });

  $('#unit-size').addEventListener('change', (e) => {
    state.unitSize = e.target.value;
    renderAll().catch(showError);
  });

  $('#swap').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    renderAll().catch(showError);
  });
}

/**
 * Redraw once the typing settles.
 *
 * The national solve is 3,000 inversions; at one per keystroke a held-down key
 * would run it faster than the page can paint. 140ms matches the settle every
 * other page on the site uses.
 */
let redrawTimer;
function scheduleRedraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    renderAll().catch(showError);
  }, 140);
}

async function renderAll() {
  await syncEngine();
  syncPickers();
  renderVerdict();
  renderLocalTaxWarning();
  renderDelta();
  paintMap();
}

/**
 * Surface a failure where the reader is looking, rather than leaving the last
 * good numbers on screen under a new question.
 */
function showError(err) {
  const banner = $('#load-error') ?? (() => {
    const el = document.createElement('div');
    el.id = 'load-error';
    el.className = 'loading';
    el.setAttribute('role', 'alert');
    $('#app').prepend(el);
    return el;
  })();
  banner.hidden = false;
  banner.innerHTML =
    `<strong>Could not compute the comparison.</strong> ${err.message}. ` +
    `The figures below may be out of date; reload to try again.`;
}

load().catch((err) => {
  $('#loading').hidden = false;
  $('#loading').innerHTML =
    `<strong>Could not load data.</strong> ${err.message}. ` +
    `Reload to try again.`;
});
