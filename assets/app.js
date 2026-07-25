import { affordability, COST_BURDENED_THRESHOLD } from '../src/affordability.js';
import { STATES, LOCAL, TAX_YEAR } from '../src/tax-data.js';
import { rankedBarChart, heatmap, rampLegend, sparkline, pct, money } from './charts.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  rents: null,
  profiles: null,
  activeProfileId: 'google-l4',
  offer: null,
  focusCity: 'sea',
};

/* ------------------------------------------------------------------ load */

async function load() {
  const [rents, profiles] = await Promise.all([
    fetch('data/rents.json').then((r) => r.json()),
    fetch('data/profiles.json').then((r) => r.json()),
  ]);

  state.rents = rents;
  state.profiles = profiles;

  selectProfile('google-l4');
  renderMasthead();
  renderPresets();
  renderCityPicker();
  bindInputs();
  renderAll();
}

/* --------------------------------------------------------------- profile */

function selectProfile(id) {
  const p = state.profiles.profiles.find((x) => x.id === id);
  state.activeProfileId = id;
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

  $('#city-picker').addEventListener('change', (e) => {
    state.focusCity = e.target.value;
    renderMultiples();
  });

  $('#theme-toggle').addEventListener('click', toggleTheme);
}

function markCustom() {
  state.activeProfileId = 'custom';
  state.offer.label = 'Your offer';
  document.querySelectorAll('.presets button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.id === 'custom'));
  });
}

/* ----------------------------------------------------------------- model */

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

/* --------------------------------------------------------------- render */

function renderMasthead() {
  const { asOf, source, hubs } = state.rents;
  const month = new Date(`${asOf}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  $('#freshness').innerHTML =
    `<span class="dot"></span> Rent data: <strong>${month}</strong> · ${hubs.length} metros · ${source.name}`;
  $('#tax-year').textContent = TAX_YEAR;
}

function renderPresets() {
  const mount = $('#presets');
  mount.replaceChildren();

  for (const p of state.profiles.profiles) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = p.id;
    b.textContent = `${p.company} ${p.title.split(' ')[0]}`;
    b.setAttribute('aria-pressed', String(p.id === state.activeProfileId));
    b.addEventListener('click', () => {
      selectProfile(p.id);
      document.querySelectorAll('.presets button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x.dataset.id === p.id));
      });
      renderAll();
    });
    mount.appendChild(b);
  }
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

function renderStats() {
  const rows = locationsFor(state.offer)
    .filter((r) => r.result.baseRatio !== null)
    .sort((a, b) => a.result.baseRatio - b.result.baseRatio);

  if (!rows.length) return;

  const best = rows[0];
  const worst = rows.at(-1);
  const under = rows.filter((r) => r.result.baseRatio < COST_BURDENED_THRESHOLD).length;

  const nets = rows.map((r) => r.result.baseMonthlyNet);
  const spread = Math.max(...nets) - Math.min(...nets);

  const tiles = [
    { label: 'Easiest metro', value: pct(best.result.baseRatio, 1), note: best.hub.city },
    { label: 'Toughest metro', value: pct(worst.result.baseRatio, 1), note: worst.hub.city },
    {
      label: 'Under the 30% line',
      value: `${under} of ${rows.length}`,
      note: 'metros where rent stays affordable',
    },
    {
      label: 'Take-home spread',
      value: `${money(spread)}/mo`,
      note: 'same salary, different state tax',
    },
  ];

  $('#stats').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML =
        `<div class="label">${t.label}</div><div class="value">${t.value}</div><div class="note">${t.note}</div>`;
      return d;
    }),
  );
}

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
  const profiles = state.profiles.profiles;
  const hubs = state.rents.hubs;

  // Order rows by the current offer so the grid stays comparable with the bars.
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
    colLabels: profiles.map((p) => ({ title: p.company, subtitle: p.title.split(' ')[0] })),
    cells,
  });

  rampLegend($('#heatmap-legend'), 'smaller share of pay', 'larger share');
}

function renderMultiples() {
  const hub = state.rents.hubs.find((h) => h.id === state.focusCity);
  const mount = $('#multiples');
  mount.replaceChildren();

  for (const p of state.profiles.profiles) {
    const res = affordability(p, { state: hub.state, local: hub.local, rent: hub.rent });

    const panel = document.createElement('div');
    panel.className = 'multiple';

    const h3 = document.createElement('h3');
    h3.textContent = p.company;

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = p.vestingNote;

    const chart = document.createElement('div');

    panel.append(h3, meta, chart);
    mount.appendChild(panel);

    sparkline(
      chart,
      res.years.map((y) => ({ ...y, value: y.ratio })),
      {
        threshold: COST_BURDENED_THRESHOLD,
        formatPoint: (pt) => `
          <div class="t-title">${p.company} · year ${pt.year}</div>
          <div class="t-row">Gross ${money(pt.gross)}</div>
          <div class="t-row">Take-home ${money(pt.monthlyNet)}/mo</div>
          <div class="t-row">Rent takes ${pct(pt.value, 1)}</div>`,
      },
    );
  }

  $('#multiples-caption').textContent =
    `${hub.city} · rent ${money(hub.rent)}/mo · dashed line marks the 30% threshold`;
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
  renderStats();
  renderBars();
  renderHeatmap();
  renderMultiples();
  renderTable();
}

/* ----------------------------------------------------------------- theme */

function toggleTheme() {
  const root = document.documentElement;
  const current =
    root.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';

  root.dataset.theme = next;
  $('#theme-toggle').textContent = next === 'dark' ? 'Light' : 'Dark';

  // The heatmap picks its label ink from the resolved surface, so it must redraw.
  renderHeatmap();
}

load().catch((err) => {
  document.querySelector('.wrap').insertAdjacentHTML(
    'afterbegin',
    `<section class="panel"><h2>Could not load data</h2>
     <p class="sub">${err.message}. If you opened this file directly, serve it over HTTP instead —
     ES modules and fetch do not work from <code>file://</code>. Run <code>npm run serve</code>.</p></section>`,
  );
});
