import { affordability, COST_BURDENED_THRESHOLD } from '../src/affordability.js';
import {
  salaryBands, classify, monthlyNeeds, needsShareStep, NEEDS_SHARE_CLASSES,
} from '../src/bands.js';
import { totalTax } from '../src/tax.js';
import { STATES, LOCAL, TAX_YEAR, UNMODELLED_LOCAL_TAX } from '../src/tax-data.js';
import { CATEGORY_ORDER, CATEGORY_LABELS } from '../src/living-wage-parse.js';
import {
  rankedBarChart, heatmap, rampLegend, sparkline, salaryLadder, stackedBar,
  pct, money,
} from './charts.js';
import { countyMap, rampLegendFor, BAND_STEP } from './map.js';
import { initTheme } from './theme.js';

const $ = (sel) => document.querySelector(sel);

/** King County, WA — a hub with data on both rent bases and no state income tax. */
const DEFAULT_COUNTY = '53033';

/**
 * The two rent measures, kept separate on purpose.
 *
 * They are not converted into one another. A single national ZORI/ACS multiplier
 * was tested against the 1,351 counties carrying both and rejected: correlation
 * 0.675, median error 11%, 90th-percentile error 27%. An 11% error in rent moves
 * the salary thresholds by roughly the same proportion.
 */
const RENT_BASIS = {
  acs: {
    key: 'rentAcs',
    label: 'Census ACS median gross rent',
    short: 'Census ACS',
    hint: 'Every county. Five-year average, includes utilities, sized by unit.',
    includesUtilities: true,
    hasBedrooms: true,
  },
  zori: {
    key: 'rentZori',
    label: 'Zillow Observed Rent Index',
    short: 'Zillow ZORI',
    hint: 'Current month, all unit sizes together, only where Zillow indexes.',
    includesUtilities: false,
    hasBedrooms: false,
  },
};

/**
 * Unit sizes available on the Census basis.
 *
 * This matters more than it looks. The model prices ONE ADULT with no children —
 * the same household MIT budgets for — but an all-bedroom median is pulled
 * upward by family-sized units. In King County it is $2,035 against $1,813 for a
 * one-bedroom, so defaulting to the overall median would overstate a single
 * person's rent by about 12%. One bedroom is therefore the default.
 *
 * Rarer sizes are suppressed in thin counties, so each falls back to the overall
 * median and says so rather than leaving the county blank.
 */
const UNIT_SIZES = [
  { key: 'br1', label: '1 bedroom' },
  { key: 'studio', label: 'Studio' },
  { key: 'br2', label: '2 bedrooms' },
  { key: 'all', label: 'All sizes' },
];

/**
 * The "Other" job — an offer that is nobody's published package.
 *
 * It deliberately does not live in data/profiles.json. Every row in that file
 * carries a source and a date, and a number the reader typed has neither; mixing
 * the two would quietly weaken the guarantee the rest of the file makes.
 *
 * Choosing it keeps whatever is currently in the fields, because starting from a
 * real anchor and adjusting beats retyping four numbers from zero. What it does
 * replace is the vesting shape: a preset's schedule is that company's, and once
 * the package is yours there is nothing left to justify assuming it.
 */
const CUSTOM_ID = 'custom';
const EVEN_VESTING = [0.25, 0.25, 0.25, 0.25];
const CUSTOM_VESTING_NOTE =
  'Equity vests in even quarters, the neutral assumption when no schedule is known.';

const state = {
  rents: null,
  profiles: null,
  counties: null,
  countyList: null,
  basemap: null,
  map: null,
  activeProfileId: 'google-l3',
  offer: null,
  selectedCounty: DEFAULT_COUNTY,
  rentBasis: 'acs',
  unitSize: 'br1',
  focusCity: 'sea',
};

/* ------------------------------------------------------------------ load */

async function load() {
  const [rents, profiles, countyZori, countyAcs, countyWage, basemap] = await Promise.all([
    fetch('data/rents.json').then((r) => r.json()),
    fetch('data/profiles.json').then((r) => r.json()),
    fetch('data/county-rents.json').then((r) => r.json()),
    fetch('data/county-acs-rents.json').then((r) => r.json()),
    fetch('data/county-living-wage.json').then((r) => r.json()),
    fetch('data/us-basemap.json').then((r) => r.json()),
  ]);

  state.rents = rents;
  state.profiles = profiles;
  state.basemap = basemap;

  const zoriByFips = new Map(countyZori.counties.map((c) => [c.fips, c]));
  const acsByFips = new Map(countyAcs.counties.map((c) => [c.fips, c]));
  // The basemap carries the Census gazetteer's official name and state for every
  // county, so geography has exactly one source of truth across the project.
  const geoByFips = new Map(basemap.counties.map((c) => [c.id, c]));

  // Cost of living is the spine: a county with no budget cannot be scored on any
  // rent basis. Rent is then attached from whichever sources have it.
  state.counties = new Map();
  for (const wage of countyWage.counties) {
    const geo = geoByFips.get(wage.fips);
    if (!geo?.st || !STATES[geo.st]) continue;

    const zori = zoriByFips.get(wage.fips);
    const acs = acsByFips.get(wage.fips);
    if (!zori && !acs) continue;

    state.counties.set(wage.fips, {
      fips: wage.fips,
      name: geo.name,
      state: geo.st,
      metro: zori?.metro ?? null,
      rentZori: zori?.rent ?? null,
      zoriYoy: zori?.yoy ?? null,
      rentAcs: acs?.rent ?? null,
      acsMoe: acs?.moe ?? null,
      acsByUnit: acs
        ? { all: acs.rent ?? null, studio: acs.studio ?? null, br1: acs.br1 ?? null, br2: acs.br2 ?? null }
        : null,
      nonHousingMonthly: wage.nonHousingMonthly,
      expenses: wage.e ?? null,
      label: `${geo.name}, ${geo.st}`,
    });
  }

  state.countyList = [...state.counties.values()].sort((a, b) => a.label.localeCompare(b.label));

  selectProfile(state.activeProfileId);
  renderMasthead(countyZori, countyAcs);
  renderPresets();
  renderCountyPicker();
  renderUnitSizePicker();
  renderCityPicker();
  buildMap();
  bindInputs();
  initTheme(() => {
    // The heatmap picks its label ink from the resolved surface, so it must redraw.
    renderHeatmap();
  });

  // Reveal before the first render, not after: the heatmap sizes its cells to the
  // width actually available, and a hidden container measures zero.
  $('#loading').hidden = true;
  $('#app').hidden = false;

  renderAll();
  bindResize();
}

/**
 * Every chart now sizes itself to the column it sits in, which means a resize can
 * leave all of them wrong. Only the charts are redrawn — the map keeps its own
 * geometry in a viewBox and needs nothing — and only once the drag has settled,
 * because re-rendering twenty-one bars and 147 heatmap cells on every resize
 * event is work nobody sees.
 */
function bindResize() {
  let last = window.innerWidth;
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === last) return;
      last = window.innerWidth;
      renderCountyPanel();
      renderBars();
      renderHeatmap();
      renderMultiples();
    }, 140);
  });
}

/* --------------------------------------------------------------- profile */

function selectProfile(id) {
  state.activeProfileId = id;

  if (id === CUSTOM_ID) {
    state.offer = {
      ...state.offer,
      vesting: [...EVEN_VESTING],
      label: 'Your offer',
      vestingNote: CUSTOM_VESTING_NOTE,
    };
    writeInputs();
    return;
  }

  const p = state.profiles.profiles.find((x) => x.id === id);
  state.offer = {
    baseSalary: p.baseSalary,
    rsuGrant: p.rsuGrant,
    vesting: [...p.vesting],
    bonuses: [...p.bonuses],
    equityHaircut: p.equityHaircut,
    label: `${p.company} — ${p.title}`,
    vestingNote: p.vestingNote,
  };
  writeInputs();
}

/** The active offer as a profile row, so it can sit beside the sourced ones. */
const customEntry = () => ({
  ...state.offer,
  id: CUSTOM_ID,
  company: 'Your offer',
  short: 'custom',
  title: 'Your own numbers',
});

/**
 * Profiles to compare against, which includes yours once you have one.
 *
 * The custom offer joins the grid and the vesting panels only when it is
 * actually selected. Before that it holds a copy of whichever preset was last
 * loaded, and showing a duplicate column labelled "Your offer" would be noise.
 */
const comparableProfiles = () =>
  state.activeProfileId === CUSTOM_ID
    ? [...state.profiles.profiles, customEntry()]
    : state.profiles.profiles;

function writeInputs() {
  $('#base').value = Math.round(state.offer.baseSalary);
  $('#grant').value = Math.round(state.offer.rsuGrant);
  $('#bonus').value = Math.round(state.offer.bonuses[0] ?? 0);
  $('#haircut').value = Math.round(state.offer.equityHaircut * 100);
}

function readInputs() {
  const num = (sel, fallback = 0) => {
    const v = Number($(sel).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };

  state.offer = {
    ...state.offer,
    baseSalary: num('#base'),
    rsuGrant: num('#grant'),
    bonuses: state.offer.bonuses.map((_, i) => (i === 0 ? num('#bonus') : state.offer.bonuses[i])),
    equityHaircut: Math.min(1, num('#haircut') / 100),
  };
}

function bindInputs() {
  for (const sel of ['#base', '#grant', '#bonus', '#haircut']) {
    $(sel).addEventListener('input', () => {
      readInputs();
      markCustom();
      renderAll();
    });
  }

  $('#county-picker').addEventListener('change', (e) => {
    const match = state.countyList.find((c) => c.label === e.target.value);
    if (match) {
      state.selectedCounty = match.fips;
      renderCountyPanel();
      paintMap();
      // Picking a county while zoomed into another part of the country would
      // otherwise outline something off-screen, which reads as a failed click.
      state.map.revealCounty(match.fips);
    }
  });

  $('#rent-basis').addEventListener('change', (e) => {
    state.rentBasis = e.target.value;
    syncUnitSizeControl();
    renderCountyPanel();
    paintMap();
  });

  $('#unit-size').addEventListener('change', (e) => {
    state.unitSize = e.target.value;
    renderCountyPanel();
    paintMap();
  });

  $('#city-picker').addEventListener('change', (e) => {
    state.focusCity = e.target.value;
    renderMultiples();
  });
}

function markCustom() {
  if (state.activeProfileId !== CUSTOM_ID) {
    // Typing over a preset's numbers makes the package yours, but the vesting
    // shape you started from is still the one being modelled. Say so, rather
    // than silently reshaping the four-year curve under the reader.
    const from = state.profiles.profiles.find((p) => p.id === state.activeProfileId);
    state.offer.vestingNote = from
      ? `${from.vestingNote} Kept from the ${from.company} preset you started from.`
      : CUSTOM_VESTING_NOTE;
    state.activeProfileId = CUSTOM_ID;
  }
  state.offer.label = 'Your offer';
  syncPresets();
}

/* ----------------------------------------------------------------- model */

const basis = () => RENT_BASIS[state.rentBasis];

/**
 * Rent for a county on the active basis and unit size.
 *
 * @returns {{ rent: number|null, unit: string|null, fellBack: boolean }}
 */
function rentInfo(county) {
  if (!basis().hasBedrooms) {
    return { rent: county.rentZori, unit: null, fellBack: false };
  }

  const wanted = state.unitSize;
  const sized = county.acsByUnit?.[wanted] ?? null;
  if (sized !== null) {
    return { rent: sized, unit: wanted, fellBack: false };
  }

  // Suppressed for this unit size in this county — fall back to the overall
  // median and flag it, rather than dropping the county off the map.
  return { rent: county.rentAcs, unit: 'all', fellBack: wanted !== 'all' };
}

const rentOf = (county) => rentInfo(county).rent;

function locationsFor(offer) {
  return state.rents.hubs.map((hub) => ({
    hub,
    result: affordability(offer, { state: hub.state, local: hub.local, rent: hub.rent }),
  }));
}

function jurisdictionLabel(hub) {
  const st = STATES[hub.state]?.name ?? hub.state;
  return hub.local ? `${st} + ${LOCAL[hub.local].name}` : st;
}

/**
 * Monthly take-home for the current base salary, once per state.
 *
 * Painting the map means classifying ~3,100 counties on every keystroke.
 * Take-home depends only on the tax jurisdiction, not the county, so it is
 * computed 51 times instead of 3,100 — the per-county work is then one division.
 */
function netByStateFor(gross) {
  const cache = new Map();
  for (const code of Object.keys(STATES)) {
    cache.set(code, totalTax(gross, { state: code, local: null }).net / 12);
  }
  return cache;
}

function paintDataForCounties() {
  const nets = netByStateFor(state.offer.baseSalary);
  const steps = new Map();
  const bandCounts = {};
  let withRent = 0;

  for (const county of state.counties.values()) {
    const rent = rentOf(county);
    if (rent === null) continue;

    withRent++;
    const net = nets.get(county.state);
    const needs = monthlyNeeds(rent, county.nonHousingMonthly);
    const share = net > 0 ? needs / net : Infinity;

    steps.set(county.fips, needsShareStep(share) ?? 6);
    const band = classify(net, needs).id;
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }
  return { steps, bandCounts, withRent };
}

const selectedCounty = () => state.counties.get(state.selectedCounty);

/**
 * The selected county's tax jurisdiction.
 *
 * City income tax is modelled for exactly two places, so it is matched on the
 * specific county rather than assumed from the state.
 */
function localCodeFor(county) {
  // New York County is Manhattan; the other four boroughs are separate counties.
  const NYC_COUNTIES = new Set(['36061', '36047', '36005', '36081', '36085']);
  if (NYC_COUNTIES.has(county.fips)) return 'NYC';
  if (county.fips === '42101') return 'PHL'; // Philadelphia County is coterminous with the city
  return null;
}

/* --------------------------------------------------------------- render */

function renderMasthead(countyZori, countyAcs) {
  const month = new Date(`${state.rents.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  $('#freshness').innerHTML =
    `<span class="dot"></span> ${state.counties.size.toLocaleString()} counties · ` +
    `Zillow rents <strong>${month}</strong> · Census ACS ${countyAcs.vintage} · ` +
    `MIT living wage, ${countyZori.countyCount.toLocaleString()} counties on both`;

  $('#tax-year-badge').textContent = TAX_YEAR;
  $('#location-caveat').textContent = state.profiles.locationCaveat;
}

function renderPresets() {
  const mount = $('#presets');
  mount.replaceChildren();

  const chip = (id, text, title, className = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = id;
    b.textContent = text;
    if (title) b.title = title;
    if (className) b.className = className;
    b.addEventListener('click', () => {
      selectProfile(id);
      syncPresets();
      renderAll();
    });
    mount.appendChild(b);
  };

  for (const p of state.profiles.profiles) chip(p.id, `${p.company} ${p.short}`, p.title);

  const sep = document.createElement('span');
  sep.className = 'preset-sep';
  sep.setAttribute('aria-hidden', 'true');
  mount.appendChild(sep);

  chip(
    CUSTOM_ID,
    'Other',
    'Your own numbers, starting from whatever is currently in the fields',
    'preset-custom',
  );

  syncPresets();
}

const monthLabel = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

/** Light up the active chip and say, in one line, what it means. */
function syncPresets() {
  document.querySelectorAll('.presets button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.id === state.activeProfileId));
  });

  const note = $('#preset-note');
  if (state.activeProfileId === CUSTOM_ID) {
    note.textContent = `Your own numbers — nothing here is sourced. ${state.offer.vestingNote}`;
    return;
  }

  const p = state.profiles.profiles.find((x) => x.id === state.activeProfileId);
  const src = state.profiles.source;
  note.textContent =
    `${p.title} · US national median, Levels.fyi, ${monthLabel(src.asOf)}. ` +
    `Overwrite any field — or pick Other — to make it your own.`;
}

/** Unit size only exists on the Census basis; Zillow publishes no bedroom split. */
function syncUnitSizeControl() {
  const select = $('#unit-size');
  const supported = basis().hasBedrooms;

  select.disabled = !supported;
  $('#unit-size-hint').textContent = supported
    ? 'A single adult is priced against a one-bedroom by default.'
    : 'Zillow publishes no bedroom breakdown — all unit sizes together.';
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

function renderCountyPicker() {
  const list = $('#county-options');
  list.replaceChildren();
  for (const county of state.countyList) {
    const o = document.createElement('option');
    o.value = county.label;
    list.appendChild(o);
  }
  $('#county-picker').value = selectedCounty()?.label ?? '';
}

function renderCityPicker() {
  const sel = $('#city-picker');
  sel.replaceChildren();
  for (const hub of [...state.rents.hubs].sort((a, b) => a.city.localeCompare(b.city))) {
    const o = document.createElement('option');
    o.value = hub.id;
    o.textContent = hub.city;
    if (hub.id === state.focusCity) o.selected = true;
    sel.appendChild(o);
  }
}

/* ------------------------------------------------------- county panel */

function renderCountyPanel() {
  const county = selectedCounty();
  if (!county) return;

  $('#rent-basis-hint').textContent = basis().hint;
  $('#county-picker').value = county.label;

  const { rent, unit, fellBack } = rentInfo(county);
  const local = localCodeFor(county);

  $('#county-hint').textContent =
    `${STATES[county.state].name}${local ? ` · ${LOCAL[local].name}` : ''}` +
    `${county.metro ? ` · ${county.metro}` : ''}`;

  // A county can have a budget but no rent on the chosen basis.
  if (rent === null) {
    const other = state.rentBasis === 'acs' ? 'zori' : 'acs';
    const hasOther = county[RENT_BASIS[other].key] !== null;

    $('#verdict').className = 'verdict';
    $('#verdict').style.setProperty('--band', 'var(--map-nodata)');
    $('#verdict').innerHTML =
      `<span class="verdict-chip">No data</span>` +
      `<div class="verdict-text">No ${basis().short} rent figure is published for ${county.name}.` +
      (hasOther ? ` Switch the rent basis to ${RENT_BASIS[other].short} to see it.` : '') +
      `</div>`;
    $('#county-stats').replaceChildren();
    $('#ladder').replaceChildren();
    $('#breakdown').replaceChildren();
    $('#breakdown-table').innerHTML = '';
    $('#tax-table').innerHTML = '';
    $('#local-tax-warning').hidden = true;
    return;
  }

  const location = { state: county.state, local, rent, nonHousingMonthly: county.nonHousingMonthly };

  const bands = salaryBands(location);
  const tax = totalTax(state.offer.baseSalary, { state: county.state, local });
  const net = tax.net / 12;
  const needs = bands.monthlyNeeds;
  const band = classify(net, needs);
  const surplus = net - needs;

  const verdict = $('#verdict');
  verdict.className = `verdict band-${band.id}`;
  // The band colour rides an inset rule down the edge and a dot on the chip, so
  // the verdict reads as an answer rather than as one more paragraph. The chip
  // carries the band's name in words, which is what survives colourblindness.
  verdict.style.setProperty('--band', `var(${BAND_STEP[band.id]})`);
  verdict.innerHTML =
    `<span class="verdict-chip">${band.label}</span>` +
    `<div class="verdict-text">in ${county.name} on ${money(state.offer.baseSalary)} base. ` +
    `${band.description}</div>`;

  const unitLabel = UNIT_SIZES.find((u) => u.key === unit)?.label;
  const rentNote =
    state.rentBasis === 'acs'
      ? fellBack
        ? `${unitLabel} — no separate figure published for this size here`
        : `Census ACS · ${unitLabel}`
      : county.zoriYoy === null
        ? 'Zillow ZORI · all sizes'
        : `Zillow ZORI · all sizes · ${(county.zoriYoy * 100).toFixed(1)}% YoY`;

  const tiles = [
    { label: 'Take-home', value: `${money(net)}/mo`, note: `after ${pct(tax.effectiveRate, 1)} total tax` },
    { label: 'Rent', value: `${money(rent)}/mo`, note: rentNote },
    { label: 'Everything else', value: `${money(county.nonHousingMonthly)}/mo`, note: 'food, medical, transport, other' },
    {
      label: surplus >= 0 ? 'Left over' : 'Short by',
      value: `${money(Math.abs(surplus))}/mo`,
      note: surplus >= 0 ? `${pct(needs / net, 0)} of pay goes to necessities` : 'necessities exceed take-home',
      // Only this tile changes meaning rather than magnitude, so only this one
      // takes a rail. The label states the case; the colour repeats it.
      rail: surplus >= 0 ? 'is-good' : 'is-short',
    },
  ];

  $('#county-stats').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = t.rail ? `stat ${t.rail}` : 'stat';
      d.innerHTML =
        `<div class="label">${t.label}</div><div class="value">${t.value}</div><div class="note">${t.note}</div>`;
      return d;
    }),
  );

  const colors = Object.fromEntries(
    Object.entries(BAND_STEP).map(([id, token]) => [id, `var(${token})`]),
  );
  salaryLadder($('#ladder'), {
    bands,
    salary: state.offer.baseSalary,
    colors,
    bandLabel: band.label,
  });

  renderBreakdown(county, rent, needs);

  const warning = $('#local-tax-warning');
  const unmodelled = UNMODELLED_LOCAL_TAX[county.state];
  if (unmodelled && !local) {
    warning.hidden = false;
    warning.textContent =
      `Heads up: ${unmodelled.note} Typically ${unmodelled.typical}, and it is NOT included above — ` +
      `your real take-home here will be lower.`;
  } else {
    warning.hidden = true;
  }

  renderTaxTable(tax, county, local);
}

/**
 * The monthly cost of living, split into its parts.
 *
 * Rent is one measured figure; the six others come from MIT's county budget.
 * They are shown together because "rent is $1,800" is only half an answer — the
 * other $2,200 is what turns a plausible-looking salary into a tight one.
 */
function renderBreakdown(county, rent, needs) {
  const RAMP = ['--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];

  const segments = [{ label: 'Rent', value: rent, color: 'var(--accent)' }];

  if (county.expenses) {
    CATEGORY_ORDER.forEach((key, i) => {
      segments.push({
        label: CATEGORY_LABELS[key] ?? key,
        value: county.expenses[i],
        color: `var(${RAMP[i]})`,
      });
    });
  } else {
    segments.push({
      label: 'Everything else',
      value: county.nonHousingMonthly,
      color: 'var(--seq-4)',
    });
  }

  stackedBar($('#breakdown'), segments);

  const rows = segments
    .map(
      (s) => `
      <tr>
        <td><span class="swatch" style="background:${s.color}"></span>${s.label}</td>
        <td>${money(s.value)}</td>
        <td>${pct(s.value / needs, 1)}</td>
        <td>${money(s.value * 12)}</td>
      </tr>`,
    )
    .join('');

  $('#breakdown-table').innerHTML = `
    <thead><tr><th>Category</th><th>Per month</th><th>Share</th><th>Per year</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td><strong>Total to live here</strong></td>
      <td><strong>${money(needs)}</strong></td>
      <td><strong>100%</strong></td>
      <td><strong>${money(needs * 12)}</strong></td>
    </tr></tfoot>`;
}

function renderTaxTable(tax, county, local) {
  const rows = [
    ['Gross base salary', tax.gross],
    ['Federal income tax', -tax.federal],
    ['FICA (Social Security + Medicare)', -tax.fica],
    [`${STATES[county.state].name} income tax`, -tax.stateIncome],
    ...tax.statePayrollDetail.map((d) => [d.label, -d.amount]),
    ...(local ? [[LOCAL[local].name, -tax.local]] : []),
  ];

  const body = rows
    .map(
      ([label, value]) => `
      <tr>
        <td>${label}</td>
        <td>${value < 0 ? '−' : ''}${money(Math.abs(value))}</td>
        <td>${tax.gross > 0 ? pct(Math.abs(value) / tax.gross, 1) : '—'}</td>
      </tr>`,
    )
    .join('');

  $('#tax-table').innerHTML = `
    <thead><tr><th>Item</th><th>Per year</th><th>Of gross</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr>
      <td><strong>Take-home</strong></td>
      <td><strong>${money(tax.net)}</strong></td>
      <td><strong>${pct(1 - tax.effectiveRate, 1)}</strong></td>
    </tr></tfoot>`;
}

/* ------------------------------------------------------------------ map */

function buildMap() {
  state.map = countyMap($('#map'), {
    basemap: state.basemap,
    onSelect: (fips) => {
      if (!state.counties.has(fips)) return;
      state.selectedCounty = fips;
      renderCountyPanel();
      paintMap();
    },
    onHover: (fips, event) => {
      if (!fips) return hideTooltip();
      showCountyTooltip(fips, event);
    },
    // The map owns the zoom; the app owns which county is selected.
    onLocate: () => state.selectedCounty,
  });
}

/**
 * The no-data wording depends on which source is silent, so the legend is
 * rebuilt when the basis changes — and only then, because painting the map runs
 * on every keystroke in the salary field.
 */
let legendBasis = null;
function syncMapLegend() {
  if (legendBasis === state.rentBasis) return;
  legendBasis = state.rentBasis;
  rampLegendFor(
    $('#map-legend'),
    NEEDS_SHARE_CLASSES,
    `${basis().short} publishes no rent figure for this county.`,
  );
}

let tooltipEl;
function tooltipNode() {
  if (!tooltipEl) {
    tooltipEl = document.getElementById('tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = 'tooltip';
      tooltipEl.setAttribute('role', 'status');
      document.body.appendChild(tooltipEl);
    }
  }
  return tooltipEl;
}

const hideTooltip = () => tooltipNode().classList.remove('on');

function showCountyTooltip(fips, event) {
  const county = state.counties.get(fips);
  const tip = tooltipNode();
  const rent = county ? rentOf(county) : null;

  if (!county || rent === null) {
    tip.innerHTML =
      `<div class="t-title">${county?.label ?? 'This county'}</div>` +
      `<div class="t-row">No ${basis().short} rent figure published</div>`;
  } else {
    const local = localCodeFor(county);
    const net = totalTax(state.offer.baseSalary, { state: county.state, local }).net / 12;
    const needs = monthlyNeeds(rent, county.nonHousingMonthly);
    const band = classify(net, needs);

    tip.innerHTML =
      `<div class="t-title">${county.label}</div>` +
      `<div class="t-row"><strong>${band.label}</strong> — necessities take ${pct(needs / net, 0)} of pay</div>` +
      `<div class="t-row">Rent ${money(rent)}/mo</div>` +
      `<div class="t-row">Everything else ${money(county.nonHousingMonthly)}/mo</div>` +
      `<div class="t-row">Take-home ${money(net)}/mo</div>`;
  }

  tip.classList.add('on');
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function paintMap() {
  const { steps, bandCounts, withRent } = paintDataForCounties();
  state.map.paint(steps, state.selectedCounty);
  syncMapLegend();

  const comfortable = bandCounts.comfortable ?? 0;
  const strained = (bandCounts.survival ?? 0) + (bandCounts['below-survival'] ?? 0);

  $('#map-intro').textContent =
    `Every US county, shaded by what share of take-home rent and necessities consume. ` +
    `Click any county to select it; scroll, pinch or use the controls to zoom into a ` +
    `region. Rent here is ${basis().label}` +
    (basis().hasBedrooms
      ? `, ${UNIT_SIZES.find((u) => u.key === state.unitSize).label.toLowerCase()}`
      : '') +
    (state.rentBasis === 'acs'
      ? ', which covers essentially the whole country.'
      : ', so counties Zillow does not index are left unshaded.');

  $('#map-caption').textContent =
    `On ${money(state.offer.baseSalary)} base, necessities stay under half of take-home in ` +
    `${comfortable.toLocaleString()} of ${withRent.toLocaleString()} counties measured on this basis ` +
    `(${pct(comfortable / withRent, 0)}), and take 70% or more in ${strained.toLocaleString()}. ` +
    `Darker counties are the expensive ones.`;
}

/* ------------------------------------------------------------ hub charts */

function renderBars() {
  const rows = locationsFor(state.offer)
    .filter((r) => r.result.baseRatio !== null)
    .sort((a, b) => a.result.baseRatio - b.result.baseRatio)
    .map(({ hub, result }) => ({
      label: hub.city,
      value: result.baseRatio,
      tooltip: `
        <div class="t-title">${hub.city}</div>
        <div class="t-row">Rent ${money(hub.rent)}/mo</div>
        <div class="t-row">Take-home ${money(result.baseMonthlyNet)}/mo</div>
        <div class="t-row">Rent takes ${pct(result.baseRatio, 1)}</div>
        <div class="t-row">${jurisdictionLabel(hub)}</div>`,
    }));

  rankedBarChart($('#bars'), rows, {
    threshold: COST_BURDENED_THRESHOLD,
    thresholdLabel: '30% — cost-burdened (HUD)',
  });

  $('#bars-caption').textContent =
    `${state.offer.label} · base salary ${money(state.offer.baseSalary)}`;
}

function renderHeatmap() {
  const profiles = comparableProfiles();

  const ordered = locationsFor(state.offer)
    .sort((a, b) => (a.result.baseRatio ?? 1) - (b.result.baseRatio ?? 1))
    .map((r) => r.hub);

  const cells = ordered.map((hub) =>
    profiles.map((p) => {
      const res = affordability(p, { state: hub.state, local: hub.local, rent: hub.rent });
      const y1 = res.years[0];
      return {
        value: y1.ratio,
        tooltip: `
          <div class="t-title">${hub.city} · ${p.company}</div>
          <div class="t-row">Year-1 gross ${money(y1.gross)}</div>
          <div class="t-row">Take-home ${money(y1.monthlyNet)}/mo</div>
          <div class="t-row">Rent ${money(hub.rent)}/mo — ${pct(y1.ratio, 1)}</div>`,
      };
    }),
  );

  heatmap($('#heatmap'), {
    rowLabels: ordered.map((h) => h.city),
    colLabels: profiles.map((p) => ({ title: p.company, subtitle: p.short })),
    cells,
  });

  rampLegend($('#heatmap-legend'), 'smaller share of pay', 'larger share');
}

function renderMultiples() {
  const hub = state.rents.hubs.find((h) => h.id === state.focusCity);
  const mount = $('#multiples');
  mount.replaceChildren();

  const results = comparableProfiles().map((p) => ({
    profile: p,
    res: affordability(p, { state: hub.state, local: hub.local, rent: hub.rent }),
  }));

  // One shared vertical scale across all panels, so the shapes are genuinely
  // comparable rather than each rescaled to its own range.
  const allRatios = results.flatMap(({ res }) => res.years.map((y) => y.ratio)).filter((r) => r !== null);
  const span = Math.max(...allRatios) - Math.min(...allRatios);
  const pad = span === 0 ? 0.01 : span * 0.18;
  const domain = [Math.min(...allRatios) - pad, Math.max(...allRatios) + pad];

  for (const { profile: p, res } of results) {
    const panel = document.createElement('div');
    panel.className = 'multiple';

    const h3 = document.createElement('h3');
    h3.textContent = p.company;

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = p.vestingNote;

    const chart = document.createElement('div');
    chart.className = 'plot';

    panel.append(h3, meta, chart);
    mount.appendChild(panel);

    sparkline(
      chart,
      res.years.map((y) => ({ ...y, value: y.ratio })),
      {
        threshold: COST_BURDENED_THRESHOLD,
        domain,
        formatPoint: (pt) => `
          <div class="t-title">${p.company} · year ${pt.year}</div>
          <div class="t-row">Gross ${money(pt.gross)}</div>
          <div class="t-row">Take-home ${money(pt.monthlyNet)}/mo</div>
          <div class="t-row">Rent takes ${pct(pt.value, 1)}</div>`,
      },
    );
  }

  const thresholdVisible =
    COST_BURDENED_THRESHOLD >= domain[0] && COST_BURDENED_THRESHOLD <= domain[1];

  $('#multiples-caption').textContent =
    `${hub.city} · rent ${money(hub.rent)}/mo · all panels share one vertical scale` +
    (thresholdVisible
      ? ' · dashed line marks the 30% threshold'
      : ' · every offer here stays under the 30% threshold, which sits outside this range');
}

function renderTable() {
  const rows = locationsFor(state.offer)
    .filter((r) => r.result.baseRatio !== null)
    .sort((a, b) => a.result.baseRatio - b.result.baseRatio);

  const head = `
    <thead><tr>
      <th>Metro</th><th>Tax jurisdiction</th><th>Rent /mo</th><th>YoY</th>
      <th>Take-home /mo</th><th>Rent share</th><th>Yr-1 share</th>
    </tr></thead>`;

  const body = rows
    .map(
      ({ hub, result }) => `
      <tr>
        <td>${hub.city}</td>
        <td>${jurisdictionLabel(hub)}</td>
        <td>${money(hub.rent)}</td>
        <td>${hub.yoy === null ? '—' : `${(hub.yoy * 100).toFixed(1)}%`}</td>
        <td>${money(result.baseMonthlyNet)}</td>
        <td>${pct(result.baseRatio, 1)}</td>
        <td>${pct(result.years[0].ratio, 1)}</td>
      </tr>`,
    )
    .join('');

  $('#table').innerHTML = `${head}<tbody>${body}</tbody>`;
}

function renderAll() {
  renderCountyPanel();
  paintMap();
  renderBars();
  renderHeatmap();
  renderMultiples();
  renderTable();
}

load().catch((err) => {
  $('#loading').innerHTML =
    `<strong>Could not load data.</strong> ${err.message}. If you opened this file directly, ` +
    `serve it over HTTP instead — ES modules and fetch do not work from <code>file://</code>. ` +
    `Run <code>npm run serve</code>.`;
});
