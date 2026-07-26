import * as engine from './engine.js';
import {
  rankedBarChart, heatmap, rampLegend, sparkline, salaryLadder, stackedBar,
  pct, money,
} from './charts.js';
import { countyMap, rampLegendFor, BAND_STEP } from './map.js';
import { countyPicker, indexCounty } from './county-picker.js';
import { initTheme } from './theme.js';
import { initFooter } from './footer.js';
import { dataUrl } from './data.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Model constants, fetched from /api/meta at boot.
 *
 * These were imported from src/tax-data.js and src/bands.js until the engine
 * moved to Python. They are `let` rather than `const` because they arrive over
 * the network, and they are read — never written — everywhere below, so every
 * existing call site works unchanged. Nothing reads them before `load()` has
 * awaited `engine.boot()`.
 */
let STATES = {};
let LOCAL = {};
let TAX_YEAR = 0;
let UNMODELLED_LOCAL_TAX = {};
let CATEGORY_ORDER = [];
let CATEGORY_LABELS = {};
let NEEDS_SHARE_CLASSES = [];
let COST_BURDENED_THRESHOLD = 0.3;

/**
 * Everything the server computed for the current offer, basis and selection.
 *
 * Refreshed by `syncEngine()` and then read synchronously by every renderer, so
 * that painting 3,142 counties and hovering one cost nothing — which is what
 * they cost before the maths moved, and what they have to keep costing.
 */
const computed = {
  snapshot: null,
  rankAll: null,
  rows: null,
  assessment: null,
};

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
  picker: null,
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
  // The model constants have to land before any renderer runs; everything else
  // below is geometry and labels, which the client still owns.
  const meta = await engine.boot();
  ({
    states: STATES,
    categoryOrder: CATEGORY_ORDER,
    categoryLabels: CATEGORY_LABELS,
    needsShareClasses: NEEDS_SHARE_CLASSES,
    taxYear: TAX_YEAR,
    unmodelledLocalTax: UNMODELLED_LOCAL_TAX,
    costBurdenedThreshold: COST_BURDENED_THRESHOLD,
  } = meta);
  LOCAL = Object.fromEntries(
    Object.entries(meta.modelledLocalTax).map(([code, name]) => [code, { name }]),
  );

  const [rents, profiles, countyZori, countyAcs, countyWage, basemap] = await Promise.all([
    fetch(dataUrl('rents.json')).then((r) => r.json()),
    fetch(dataUrl('profiles.json')).then((r) => r.json()),
    fetch(dataUrl('county-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-acs-rents.json')).then((r) => r.json()),
    fetch(dataUrl('county-living-wage.json')).then((r) => r.json()),
    fetch(dataUrl('us-basemap.json')).then((r) => r.json()),
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

    state.counties.set(wage.fips, indexCounty({
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
    }));
  }

  state.countyList = [...state.counties.values()].sort((a, b) => a.label.localeCompare(b.label));

  selectProfile(state.activeProfileId);
  renderMasthead(countyZori, countyAcs);
  renderPresets();
  buildCountyPicker();
  renderUnitSizePicker();
  renderCityPicker();
  buildMap();
  bindInputs();
  initTheme(() => {
    // The heatmap picks its label ink from the resolved surface, so it must redraw.
    renderHeatmap();
  });
  initFooter();

  // Reveal before the first render, not after: the heatmap sizes its cells to the
  // width actually available, and a hidden container measures zero.
  $('#loading').hidden = true;
  $('#app').hidden = false;

  await renderAll();
  bindResize();
}

/**
 * Redraw after the typing settles.
 *
 * Every keystroke in the salary field used to be a free recomputation; it is a
 * request now. Without this, holding a key down queues a fetch per character
 * and the page renders a salary the reader has already typed past. 140ms is the
 * same settle the resize handler uses, and is below the threshold where an
 * input stops feeling live.
 */
let redrawTimer;
function scheduleRedraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    renderAll().catch(showError);
  }, 140);
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
    label: `${p.company} · ${p.title}`,
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
  // A number input happily accepts `1.7976931348623157e308`. That is finite, so
  // it cleared the old guard, but multiplying it by twelve months is not — the
  // Infinity propagated into ratios as NaN and Chrome started refusing rect
  // widths. A billion is past every real salary and keeps the arithmetic finite.
  const MAX_MONEY = 1e9;

  const num = (sel, fallback = 0) => {
    const v = Number($(sel).value);
    return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_MONEY) : fallback;
  };

  // An empty box is someone midway through retyping, not someone earning zero.
  // `Number('')` is 0, so reading it literally turned the moment between
  // selecting "156000" and typing the first new digit into a $0 world: take-home
  // zero, every ratio undefined, and every chart on the page emptied out. It
  // came back on the next keystroke, but a page that guts itself while you type
  // reads as a crash, and that is what it was reported as.
  //
  // Only the base salary holds its old value, because it is the only field where
  // zero is not a real answer. An equity grant, a bonus and a haircut of nothing
  // are all things people actually have, so those still read 0 when cleared.
  const keepIfBlank = (sel, current) => ($(sel).value.trim() === '' ? current : num(sel));

  state.offer = {
    ...state.offer,
    baseSalary: keepIfBlank('#base', state.offer.baseSalary),
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
      scheduleRedraw();
    });
  }

  $('#rent-basis').addEventListener('change', async (e) => {
    state.rentBasis = e.target.value;
    syncUnitSizeControl();
    await syncEngine();
    renderCountyPanel();
    paintMap();
  });

  $('#unit-size').addEventListener('change', async (e) => {
    state.unitSize = e.target.value;
    await syncEngine();
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

/**
 * Pull everything the server computes for the current offer, basis and county.
 *
 * One await, four parallel requests, and then every renderer below runs
 * synchronously off `computed`. The salary inputs fire faster than a round trip
 * completes, so `engine.refresh` collapses concurrent calls and only the newest
 * result is installed — otherwise the map would settle on whichever response
 * happened to land last rather than the one the reader is looking at.
 */
async function syncEngine() {
  const salary = state.offer.baseSalary;
  const rentBasis = state.rentBasis;
  const custom = state.activeProfileId === CUSTOM_ID;

  // The unit size is part of what "rent here" means on the ACS basis, so it
  // travels with every request that prices a county. Leaving it out was worth
  // 222 dollars a month on King County: the page asked for a one-bedroom and
  // the server answered with the all-bedroom median.
  const unit = state.unitSize;

  const [snapshot, rankAll, rows, assessment] = await Promise.all([
    engine.refresh(salary, rentBasis, unit),
    computed.rankAll ?? engine.rankAll(),
    engine.rank(custom ? state.offer.baseProfileId ?? 'google-l3' : state.activeProfileId, {
      baseSalary: state.offer.baseSalary,
      rsuGrant: state.offer.rsuGrant,
      equityHaircut: state.offer.equityHaircut,
      bonus0: state.offer.bonuses?.[0],
    }),
    state.selectedCounty
      ? engine.assessCounty(state.selectedCounty, salary, rentBasis, unit).catch(() => null)
      : null,
  ]);

  computed.snapshot = snapshot;
  computed.rankAll = rankAll;
  computed.rows = rows.rows;
  computed.assessment = assessment;
}

/** The ranking rows for one sourced profile, from the bulk response. */
const rowsForProfile = (id) =>
  id === CUSTOM_ID ? computed.rows ?? [] : computed.rankAll?.profiles?.[id] ?? [];

/** One profile against one hub. */
const rowFor = (profileId, hubId) =>
  rowsForProfile(profileId).find((r) => r.hub.id === hubId) ?? null;

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

/**
 * The active offer against every tracked hub.
 *
 * Shaped like the old `affordability()` return so the chart code below did not
 * have to change: the server ranks, this maps the response onto the field names
 * the renderers already read.
 */
function locationsFor() {
  const byHub = new Map((computed.rows ?? []).map((r) => [r.hub.id, r]));
  return state.rents.hubs.map((hub) => {
    const row = byHub.get(hub.id);
    return {
      hub,
      result: {
        baseRatio: row?.baseRatio ?? null,
        baseMonthlyNet: row?.baseMonthlyNet ?? 0,
        years: row?.years ?? [],
      },
    };
  });
}

function jurisdictionLabel(hub) {
  const st = STATES[hub.state]?.name ?? hub.state;
  return hub.local ? `${st} + ${LOCAL[hub.local].name}` : st;
}

/**
 * The map's fill, read straight out of the snapshot.
 *
 * This used to classify ~3,100 counties on every keystroke. The classification
 * now happens once on the server and arrives as one integer per county, so the
 * per-county work here is a Map insertion — and, more importantly, the class
 * breaks live in exactly one place instead of being reimplemented next to the
 * renderer that draws them.
 */
function paintDataForCounties() {
  const steps = new Map();
  for (const [fips, step] of Object.entries(computed.snapshot?.counties ?? {})) {
    steps.set(fips, step[0]);
  }
  return {
    steps,
    bandCounts: computed.snapshot?.bandCounts ?? {},
    withRent: computed.snapshot?.withRent ?? 0,
  };
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
      renderAll().catch(showError);
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
    note.textContent = `Your own numbers, so nothing here is sourced. ${state.offer.vestingNote}`;
    return;
  }

  const p = state.profiles.profiles.find((x) => x.id === state.activeProfileId);
  const src = state.profiles.source;
  note.textContent =
    `${p.title} · US national median, Levels.fyi, ${monthLabel(src.asOf)}. ` +
    `Overwrite any field, or pick Other, to make it your own.`;
}

/** Unit size only exists on the Census basis; Zillow publishes no bedroom split. */
function syncUnitSizeControl() {
  const select = $('#unit-size');
  const supported = basis().hasBedrooms;

  select.disabled = !supported;
  $('#unit-size-hint').textContent = supported
    ? 'A single adult is priced against a one-bedroom by default.'
    : 'Zillow publishes no bedroom breakdown, so all unit sizes are pooled together.';
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

/* ------------------------------------------------------ county picker */

/**
 * The picker itself lives in county-picker.js, shared with the timing page.
 * What is local to this page is the number a row shows on its right and the
 * fact that the state filter also moves the map.
 */
function buildCountyPicker() {
  state.picker = countyPicker({
    counties: state.countyList,
    input: $('#county-picker'),
    listbox: $('#county-listbox'),
    toggle: $('#county-toggle'),
    status: $('#county-status'),
    stateSelect: $('#state-picker'),
    stateHint: $('#state-hint'),
    selected: () => selectedCounty(),
    onSelect: (fips) => selectCounty(fips),
    // The rent on the *current* basis, which is what the rest of the page is
    // about to be computed from.
    meta: (county) => {
      const { rent } = rentInfo(county);
      return rent === null ? { text: 'no data', muted: true } : { text: money(rent) };
    },
    onStateFilter: (code) => {
      if (code) state.map?.zoomToState(code);
      else state.map?.reset();
    },
  });
}

/** The one path into a county selection, whatever triggered it. */
async function selectCounty(fips, { reveal = true } = {}) {
  if (!state.counties.has(fips) || fips === state.selectedCounty) {
    // Even a no-op has to put the label back: the box may be holding a query.
    state.picker.sync();
    return;
  }

  state.selectedCounty = fips;
  await syncEngine();
  renderCountyPanel();
  paintMap();

  // Picking a county while zoomed into another part of the country would
  // otherwise outline something off-screen, which reads as a failed click.
  if (reveal) state.map?.revealCounty(fips);
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
  state.picker.sync();

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

  // The ladder, the tax breakdown and the verdict all come from one server
  // assessment rather than three separate computations that could disagree.
  const assessment = computed.assessment;
  if (!assessment?.available) return;

  const bands = assessment.bands;
  const tax = assessment.tax;
  const net = assessment.monthlyNet;
  const needs = assessment.monthlyNeeds;
  const band = assessment.band;
  const surplus = assessment.monthlySurplus;

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
        ? `${unitLabel}: no separate figure published for this size here`
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
      `Heads up: ${unmodelled.note} Typically ${unmodelled.typical}, and it is NOT included above, so ` +
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
        <td>${tax.gross > 0 ? pct(Math.abs(value) / tax.gross, 1) : '–'}</td>
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
    // Clicking the map is already looking at the county, so it needs no
    // recentring — that is the one caller that passes `reveal: false`.
    onSelect: (fips) => selectCounty(fips, { reveal: false }),
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
  rampLegendFor($('#map-legend'), NEEDS_SHARE_CLASSES, {
    noDataNote: `${basis().short} publishes no rent figure for this county.`,
  });
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
    // Straight out of the snapshot: hovering cannot afford a round trip, and
    // recomputing here in JavaScript is what used to make the tooltip and the
    // fill disagree over the five New York boroughs and Philadelphia.
    const row = computed.snapshot?.counties?.[county.fips];
    const net = row?.[4] ?? 0;
    const needs = row?.[1] ?? rent + county.nonHousingMonthly;
    const band = row ? computed.snapshot.bands[row[3]] : null;

    tip.innerHTML =
      `<div class="t-title">${county.label}</div>` +
      `<div class="t-row"><strong>${band?.label ?? 'Not measured'}</strong>: necessities take ${pct(needs / net, 0)} of pay</div>` +
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
  const rows = locationsFor()
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

  if (!rows.length) {
    emptyChart(
      $('#bars'),
      'Rent as a share of take-home needs a take-home to divide by. Enter a base ' +
        'salary above and every metro comes back.',
    );
    $('#bars-caption').textContent = '';
    return;
  }

  rankedBarChart($('#bars'), rows, {
    threshold: COST_BURDENED_THRESHOLD,
    thresholdLabel: '30% cost-burdened (HUD)',
  });

  $('#bars-caption').textContent =
    `${state.offer.label} · base salary ${money(state.offer.baseSalary)}`;
}

/**
 * What a chart shows when it has nothing to draw.
 *
 * A zero or negative salary makes every ratio undefined, and the charts used to
 * respond by rendering an empty box — no marks, no axis, no explanation, which
 * looks exactly like a chart that failed to load. Saying why is both kinder and
 * more honest than a blank rectangle.
 */
function emptyChart(mount, message) {
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = message;
  mount.replaceChildren(p);
}

function renderHeatmap() {
  const profiles = comparableProfiles();

  const ordered = locationsFor()
    .sort((a, b) => (a.result.baseRatio ?? 1) - (b.result.baseRatio ?? 1))
    .map((r) => r.hub);

  const cells = ordered.map((hub) =>
    profiles.map((p) => {
      const y1 = rowFor(p.id, hub.id)?.years?.[0] ?? { gross: 0, monthlyNet: 0, ratio: null };
      return {
        value: y1.ratio,
        tooltip: `
          <div class="t-title">${hub.city} · ${p.company}</div>
          <div class="t-row">Year-1 gross ${money(y1.gross)}</div>
          <div class="t-row">Take-home ${money(y1.monthlyNet)}/mo</div>
          <div class="t-row">Rent ${money(hub.rent)}/mo, ${pct(y1.ratio, 1)}</div>`,
      };
    }),
  );

  if (!cells.flat().some((c) => c.value !== null && c.value !== undefined)) {
    emptyChart($('#heatmap'), 'No offer here has a positive take-home to measure rent against.');
    $('#heatmap-legend').replaceChildren();
    return;
  }

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
    res: { years: rowFor(p.id, hub.id)?.years ?? [] },
  }));

  // One shared vertical scale across all panels, so the shapes are genuinely
  // comparable rather than each rescaled to its own range.
  const allRatios = results.flatMap(({ res }) => res.years.map((y) => y.ratio)).filter((r) => r !== null);

  // With nothing to scale, `Math.max(...[])` is -Infinity and `Math.min(...[])`
  // is +Infinity, so the domain inverts and every plotted point becomes NaN.
  // Nothing threw — the paths just silently drew nowhere.
  if (!allRatios.length) {
    emptyChart(mount, 'Vesting only has a shape once there is a positive take-home to plot it against.');
    $('#multiples-caption').textContent = '';
    return;
  }

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
  const rows = locationsFor()
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
        <td>${hub.yoy === null ? '–' : `${(hub.yoy * 100).toFixed(1)}%`}</td>
        <td>${money(result.baseMonthlyNet)}</td>
        <td>${pct(result.baseRatio, 1)}</td>
        <td>${pct(result.years[0].ratio, 1)}</td>
      </tr>`,
    )
    .join('');

  $('#table').innerHTML = `${head}<tbody>${body}</tbody>`;
}

/**
 * Fetch once, then draw everything from what came back.
 *
 * The await is the only place the network enters a render. Every function it
 * calls reads `computed` synchronously, so the page still paints in one frame
 * once the data is in hand.
 */
async function renderAll() {
  await syncEngine();
  renderCountyPanel();
  paintMap();
  renderBars();
  renderHeatmap();
  renderMultiples();
  renderTable();
}

/**
 * Surface a failure where the reader is looking.
 *
 * Every figure on this page is now fetched, so a request that fails has to say
 * so rather than leave the last good numbers on screen under a new salary —
 * which would be a page quietly lying about what it is showing.
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
    `<strong>Could not reach the server.</strong> ${err.message}. ` +
    `The figures below may be out of date; reload to try again.`;
}

load().catch((err) => {
  $('#loading').hidden = false;
  $('#loading').innerHTML =
    `<strong>Could not load data.</strong> ${err.message}. ` +
    `The site needs its server running — start it with <code>npm run serve</code>.`;
});
