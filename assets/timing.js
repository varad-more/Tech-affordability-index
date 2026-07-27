/**
 * The "when to move" page.
 *
 * The rest of the site answers *where*. This answers *when*, from the same ZORI
 * file — the affordability model reads two of its 138 monthly columns, and the
 * other 136 are a decade of history that can say how rent moves through a year.
 */

import * as engine from './engine.js';
import {
  timeSeries, divergingBars, rankedBarChart, pct, money,
} from './charts.js';
import { countyPicker, indexCounty } from './county-picker.js';
import { initTheme } from './theme.js';
import { initFooter } from './footer.js';
import { dataUrl } from './data.js';

const $ = (sel) => document.querySelector(sel);

/** San Francisco County, CA. Somewhere most readers have an intuition about. */
const DEFAULT_COUNTY = '06075';

const state = {
  data: null,
  counties: null,
  countyList: null,
  picker: null,
  selected: DEFAULT_COUNTY,
};

/**
 * Calendar labels and the amplitude floor, from /api/meta at boot.
 *
 * The 1.5% floor is a modelling judgement, not a label: below it a swing is
 * indistinguishable from noise in a smoothed index. It belongs with the model
 * that produced the amplitude, not next to the sentence that reports it.
 */
let MONTH_NAMES = [];
let MONTH_SHORT = [];
let MEANINGFUL_AMPLITUDE = 0.015;

/** The saving for the selected county, refreshed whenever the selection moves. */
let saving = { monthly: 0, annual: 0 };

async function load() {
  const meta = await engine.boot();
  ({
    monthNames: MONTH_NAMES,
    monthShort: MONTH_SHORT,
    meaningfulAmplitude: MEANINGFUL_AMPLITUDE,
  } = meta);

  const data = await fetch(dataUrl('rent-history.json')).then((r) => r.json());

  state.data = data;
  // `state` is the postal code everywhere else on the site; the history file
  // calls it `st`. Renaming it here keeps the picker working on one shape.
  state.counties = new Map(
    data.counties.map((c) => [c.fips, indexCounty({ ...c, state: c.st })]),
  );
  state.countyList = [...state.counties.values()].sort((a, b) => a.label.localeCompare(b.label));

  // Land on a county that actually has a pattern to show.
  if (!state.counties.get(state.selected)?.season) {
    state.selected = state.countyList.find((c) => c.meaningful)?.fips ?? state.countyList[0].fips;
  }

  renderMasthead();
  buildCountyPicker();
  initTheme();
  initFooter();

  // Reveal first: both charts here size themselves to their container, and a
  // hidden container measures zero.
  $('#loading').hidden = true;
  $('#app').hidden = false;

  await renderAll();

  let last = window.innerWidth;
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === last) return;
      last = window.innerWidth;
      renderSeasonal();
      renderHistory();
    }, 140);
  });
}

const selected = () => state.counties.get(state.selected);

function renderMasthead() {
  const { lastMonth, countyCount, meaningfulCount, source } = state.data;
  const month = new Date(`${lastMonth}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  $('#freshness').innerHTML =
    `<span class="dot"></span> ${countyCount.toLocaleString()} counties · ` +
    `through <strong>${month}</strong> · ${meaningfulCount.toLocaleString()} with a swing ` +
    `worth planning around · ${source.name.split(',')[0]}`;
}

/**
 * The picker is the one in county-picker.js, the same control the explore page
 * uses. What is local here is the number on a row: this page is about the size
 * of the seasonal swing, so that is what a county is worth previewing by.
 * Counties with too little history say so in the list rather than after they
 * have been chosen.
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
    idleHint: 'Narrow the list, or search every county with history.',
    selected: () => selected(),
    onSelect: (fips) => selectCounty(fips),
    meta: (county) =>
      county.season
        ? { text: pct(county.amplitude, 1) }
        : { text: 'no pattern', muted: true },
  });
}

async function refreshSaving() {
  const county = state.counties.get(state.selected);
  if (!county?.season) {
    saving = { monthly: 0, annual: 0 };
    return;
  }
  // The saving is priced against the county's own latest observation, which the
  // engine already knows — it is precomputed per county rather than solved here.
  const res = await engine.timing(state.selected).catch(() => null);
  saving = res?.saving ?? { monthly: 0, annual: 0 };
}

function selectCounty(fips) {
  if (!state.counties.has(fips) || fips === state.selected) {
    // Even a no-op has to put the label back: the box may be holding a query.
    state.picker.sync();
    return;
  }
  state.selected = fips;
  renderAll().catch(() => {});
}

/* ---------------------------------------------------------------- render */

function renderVerdict() {
  const county = selected();
  const verdict = $('#verdict');

  $('#county-hint').textContent = county.metro ? `${county.metro} metro` : '';
  state.picker.sync();

  if (!county.season) {
    verdict.className = 'verdict';
    verdict.style.setProperty('--band', 'var(--map-nodata)');
    verdict.innerHTML =
      `<span class="verdict-chip">No pattern</span>` +
      `<div class="verdict-text">Not enough history for ${county.name} to separate a seasonal ` +
      `pattern from noise. The trend below is still real; the calendar pattern is not shown ` +
      `rather than guessed.</div>`;
    $('#timing-stats').replaceChildren();
    return;
  }

  const strong = county.amplitude >= MEANINGFUL_AMPLITUDE;

  verdict.className = 'verdict';
  verdict.style.setProperty('--band', `var(${strong ? '--div-cool' : '--map-nodata'})`);
  verdict.innerHTML =
    `<span class="verdict-chip">${strong ? 'Worth timing' : 'Barely seasonal'}</span>` +
    `<div class="verdict-text">${
      strong
        ? `In ${county.name}, <strong>${MONTH_NAMES[county.cheapest]}</strong> is typically the ` +
          `cheapest month to sign and <strong>${MONTH_NAMES[county.dearest]}</strong> the dearest, ` +
          `a swing of ${pct(county.amplitude, 1)}, or about ${money(saving.monthly)} a month.`
        : `${county.name} has almost no seasonal pattern: only ${pct(county.amplitude, 1)} between ` +
          `its cheapest and dearest months, which is too small to plan around.`
    }</div>`;

  const tiles = [
    { label: 'Cheapest month', value: MONTH_NAMES[county.cheapest], note: `${pct(1 - county.season[county.cheapest], 1)} below the yearly average` },
    { label: 'Dearest month', value: MONTH_NAMES[county.dearest], note: `${pct(county.season[county.dearest] - 1, 1)} above it` },
    { label: 'Swing', value: pct(county.amplitude, 1), note: 'peak to trough' },
    {
      label: 'Worth about',
      value: `${money(saving.monthly)}/mo`,
      note: `${money(saving.annual)} over a 12-month lease`,
    },
  ];

  $('#timing-stats').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML =
        `<div class="label">${t.label}</div><div class="value">${t.value}</div><div class="note">${t.note}</div>`;
      return d;
    }),
  );
}

function renderSeasonal() {
  const county = selected();
  const mount = $('#seasonal');

  if (!county.season) {
    mount.replaceChildren();
    $('#seasonal-table').innerHTML = '';
    $('#seasonal-caption').textContent =
      'No seasonal index: this county has too few years of observations for a stable average.';
    return;
  }

  const latest = [...county.history].reverse().find((v) => v !== null);

  const bars = county.season.map((v, m) => ({
    label: MONTH_SHORT[m],
    value: v - 1,
    tooltip:
      `<div class="t-title">${MONTH_NAMES[m]}</div>` +
      `<div class="t-row">${pct(Math.abs(v - 1), 1)} ${v >= 1 ? 'above' : 'below'} the annual average</div>` +
      `<div class="t-row">about ${money(Math.abs(latest * (v - 1)))}/mo on today's rent</div>`,
  }));

  divergingBars(mount, bars, { highlight: [county.cheapest, county.dearest] });

  $('#seasonal-caption').textContent =
    `${county.name} · the two highlighted bars are the cheapest and dearest months · ` +
    `computed from ${state.data.source.metric.toLowerCase()} since 2015`;

  const rows = county.season
    .map(
      (v, m) => `
      <tr>
        <td>${MONTH_NAMES[m]}</td>
        <td>${v >= 1 ? '+' : '−'}${pct(Math.abs(v - 1), 1)}</td>
        <td>${v >= 1 ? '+' : '−'}${money(Math.abs(latest * (v - 1)))}</td>
      </tr>`,
    )
    .join('');

  $('#seasonal-table').innerHTML = `
    <thead><tr><th>Month</th><th>vs annual average</th><th>On today's rent</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderHistory() {
  const county = selected();
  const { lastMonth, historyMonths } = state.data;

  // Rebuild month labels by counting back from the last observation.
  const end = new Date(`${lastMonth}T00:00:00Z`);
  const points = county.history.map((value, i) => {
    const offset = county.history.length - 1 - i;
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - offset, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    return {
      month,
      value,
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    };
  });

  timeSeries($('#history'), points);

  const real = points.filter((p) => p.value !== null);
  if (real.length > 1) {
    const first = real[0];
    const last = real.at(-1);
    const change = (last.value - first.value) / first.value;

    $('#history-caption').textContent =
      `${county.name} · ${money(first.value)} in ${first.label} to ${money(last.value)} in ` +
      `${last.label}, ${change >= 0 ? 'up' : 'down'} ${pct(Math.abs(change), 1)} over ` +
      `${Math.round(historyMonths / 12)} years, against a seasonal swing of ` +
      `${county.season ? pct(county.amplitude, 1) : 'n/a'}.`;
  }
}

function renderLeaderboard() {
  const top = state.countyList
    .filter((c) => c.meaningful)
    .sort((a, b) => b.amplitude - a.amplitude)
    .slice(0, 15)
    .reverse();

  const rows = top.map((c) => ({
    label: `${c.name}, ${c.st}`,
    value: c.amplitude,
    tooltip:
      `<div class="t-title">${c.name}, ${c.st}</div>` +
      `<div class="t-row">Swing ${pct(c.amplitude, 1)}</div>` +
      `<div class="t-row">Cheapest ${MONTH_NAMES[c.cheapest]}, dearest ${MONTH_NAMES[c.dearest]}</div>`,
  }));

  // County labels are far longer than the metro names this chart usually holds.
  rankedBarChart($('#leaderboard'), rows, {
    gutter: 190,
    label: 'Peak-to-trough seasonal swing in rent, by county, largest last',
  });
}

async function renderAll() {
  await refreshSaving();
  renderVerdict();
  renderSeasonal();
  renderHistory();
  renderLeaderboard();
}

load().catch((err) => {
  // Un-hide first. The reveal happens before the last render, so a failure
  // after that point was writing this message into a container that had
  // already been hidden — the page looked fine and was half-drawn.
  $('#loading').hidden = false;
  $('#app').hidden = true;
  $('#loading').innerHTML =
    `<strong>Could not load rent history.</strong> ${err.message}. ` +
    `The site needs its server running — start it with <code>npm run serve</code>.`;
});
