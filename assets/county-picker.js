/**
 * The county picker, shared by the two pages that have one.
 *
 * Both pages ask the same question of the same 3,000-odd counties, so the
 * ranking, the state filter, the placeholder arithmetic and the escape hatch out
 * of an empty filter all live here once. What differs is only the number a row
 * shows on its right, which each page supplies as `meta`.
 *
 * This owns the filter state. Nothing outside reads it, so there is exactly one
 * copy of the answer to "which counties can be offered right now".
 */

import { STATES } from '../src/tax-data.js';
import { combobox, highlight } from './combobox.js';

/**
 * Add the derived fields the ranking reads.
 *
 * Lowercased once at load rather than on every keystroke: the picker scores
 * every county per character typed, and case-folding four strings each time is
 * the whole cost of that loop.
 *
 * @param {{name: string, state: string, metro?: string|null}} county mutated in place
 */
export function indexCounty(county) {
  county.label = `${county.name}, ${county.state}`;
  county.nameLower = county.name.toLowerCase();
  county.searchLower = [county.name, county.state, STATES[county.state].name, county.metro ?? '']
    .join(' ')
    .toLowerCase();
  return county;
}

/**
 * How well a county answers a query, higher being better; 0 is no match.
 *
 * The ordering exists because a plain substring test buries the obvious answer.
 * Typing "king" against a national list matches King County WA, Kings County NY,
 * Kingfisher County OK and every county in a metro whose name contains "king",
 * all equally, so the one you meant is wherever the alphabet puts it. Ranking a
 * name that *starts* with the query above one that merely contains it puts the
 * obvious answer first, which is the difference between a search and a filter.
 */
export function scoreCounty(county, q) {
  if (county.nameLower.startsWith(q)) return 100;

  // A word start inside the name: "san" should reach "Santa Clara" as strongly
  // as it reaches "San Diego", but not as strongly as an exact leading match.
  if (county.nameLower.includes(` ${q}`)) return 80;

  if (county.nameLower.includes(q)) return 60;

  // "king county, wa", the label as it appears in the box, so the text a
  // previous selection left behind still finds its own county.
  if (county.label.toLowerCase().includes(q)) return 55;

  // State name or postal code: "washington" and "wa" both list the state.
  const stateName = STATES[county.state].name.toLowerCase();
  if (stateName.startsWith(q) || county.state.toLowerCase() === q) return 50;

  // Metro last: "seattle" finding King County is useful, but only after every
  // county actually called Seattle-something has had its turn.
  if (county.searchLower.includes(q)) return 30;

  return 0;
}

/**
 * @param {object} opts
 * @param {Array}  opts.counties      every offerable county, sorted by label
 * @param {HTMLInputElement} opts.input
 * @param {HTMLElement} opts.listbox
 * @param {HTMLElement} [opts.toggle]      button that drops the list open
 * @param {HTMLElement} [opts.status]      live region for the match count
 * @param {HTMLSelectElement} opts.stateSelect
 * @param {HTMLElement} opts.stateHint
 * @param {Function} opts.selected         () => the committed county
 * @param {Function} opts.onSelect         (fips) => void
 * @param {Function} [opts.meta]           (county) => {text, muted} for the row's right side
 * @param {Function} [opts.onStateFilter]  (code) => void, for anything outside that follows the filter
 * @param {string}   [opts.idleHint]       state hint shown when no state is chosen
 */
export function countyPicker(opts) {
  const {
    counties, input, listbox, toggle, status, stateSelect, stateHint,
    selected, onSelect, meta, onStateFilter,
  } = opts;
  const idleHint = opts.idleHint ?? 'Narrow the county list, or search the whole country.';

  /** Postal code the list is narrowed to, or '' for the whole country. */
  let filter = '';

  const byState = new Map();
  for (const county of counties) {
    const bucket = byState.get(county.state);
    if (bucket) bucket.push(county);
    else byState.set(county.state, [county]);
  }

  /** The counties the picker may currently offer, before any query. */
  const pool = () => (filter ? (byState.get(filter) ?? []) : counties);

  function search(query) {
    const list = pool();
    const q = query.trim().toLowerCase();
    if (!q) return list;

    const hits = [];
    for (const county of list) {
      const score = scoreCounty(county, q);
      if (score > 0) hits.push({ score, county });
    }
    hits.sort((a, b) => b.score - a.score || a.county.label.localeCompare(b.county.label));
    const found = hits.map((h) => h.county);

    // A state filter plus a query is the one combination that can look broken:
    // "Travis" inside Washington is empty, and nothing on screen says the filter
    // is why. Offering the national result as a row makes the cause visible and
    // fixes it in one keystroke, instead of requiring the filter be found and
    // cleared first.
    if (filter && found.length === 0) {
      const national = counties.filter((c) => scoreCounty(c, q) > 0).length;
      if (national > 0) return [{ escape: true, count: national, query }];
    }

    return found;
  }

  function row(item, query) {
    const frag = document.createDocumentFragment();

    const main = document.createElement('span');
    main.className = 'combo-main';

    if (item.escape) {
      const name = document.createElement('span');
      name.className = 'combo-name';
      name.textContent = 'Search all states instead';
      const where = document.createElement('span');
      where.className = 'combo-where';
      where.textContent =
        `${item.count.toLocaleString()} ${item.count === 1 ? 'county' : 'counties'} ` +
        `outside ${STATES[filter].name} match “${item.query.trim()}”`;
      main.append(name, where);
      frag.appendChild(main);
      return frag;
    }

    const name = document.createElement('span');
    name.className = 'combo-name';
    name.appendChild(highlight(item.name, query.trim()));
    const st = document.createElement('span');
    st.className = 'combo-st';
    st.textContent = item.state;
    name.appendChild(st);

    const where = document.createElement('span');
    where.className = 'combo-where';
    where.textContent = item.metro
      ? `${STATES[item.state].name} · ${item.metro}`
      : STATES[item.state].name;

    main.append(name, where);
    frag.appendChild(main);

    // The number the page is about to be computed from, shown before the county
    // is chosen rather than after. A county with nothing published is visible as
    // such in the list; the old picker let you select your way into an empty panel.
    const detail = meta?.(item);
    if (detail) {
      const value = document.createElement('span');
      value.className = detail.muted ? 'combo-rent none' : 'combo-rent';
      value.textContent = detail.text;
      frag.appendChild(value);
    }

    return frag;
  }

  const box = combobox(input, {
    listbox,
    status,
    source: search,
    renderRow: row,
    labelOf: (county) => county.label,
    selected,
    emptyMessage: (query) => `No county matches “${query.trim()}”.`,
    onCommit: (item) => {
      if (item.escape) {
        setStateFilter('');
        box.open(item.query);
        return;
      }
      onSelect(item.fips);
    },
  });

  /** Placeholder and value, both of which depend on the filter and the selection. */
  function sync() {
    const n = pool().length;

    input.placeholder = filter
      ? `Search ${n.toLocaleString()} ${STATES[filter].name} ${n === 1 ? 'county' : 'counties'}…`
      : `Search ${n.toLocaleString()} counties…`;

    input.value = selected()?.label ?? '';
  }

  function syncStateHint() {
    const n = pool().length;
    stateHint.textContent = filter
      ? `${n.toLocaleString()} ${STATES[filter].name} ${n === 1 ? 'county' : 'counties'} with data.`
      : idleHint;
  }

  /**
   * Narrow the picker to one state.
   *
   * The state is a filter on the list, not a selection in its own right: nothing
   * in the data ranks the counties of a state, so there is no honest way to pick
   * one on the user's behalf. What it does instead is put the county list in
   * front of them already narrowed, and move whatever else follows the filter so
   * the choice visibly did something.
   */
  function setStateFilter(code, { openList = false } = {}) {
    filter = code;
    stateSelect.value = code;
    syncStateHint();
    sync();

    onStateFilter?.(code);

    if (openList) box.open('');
    else box.refresh();
  }

  /* ------------------------------------------------------------- wiring */

  stateSelect.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All states';
  stateSelect.appendChild(all);

  // Built from what actually has data. A state with no county in the dataset
  // must not be offerable, because choosing it would empty the picker with no
  // way to tell why.
  const codes = [...byState.keys()].sort((a, b) => STATES[a].name.localeCompare(STATES[b].name));
  for (const code of codes) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = STATES[code].name;
    stateSelect.appendChild(o);
  }
  stateSelect.value = '';

  stateSelect.addEventListener('change', (e) => setStateFilter(e.target.value, { openList: true }));

  toggle?.addEventListener('click', () => {
    if (box.isOpen()) box.close();
    else box.open('');
  });

  // Kept from the datalist this replaced: setting the value and firing `change`
  // still selects a county by its exact label, which is how the browser tests
  // drive the picker and how a password manager or autofill would.
  input.addEventListener('change', () => {
    const match = counties.find((c) => c.label === input.value);
    if (match) onSelect(match.fips);
  });

  syncStateHint();
  sync();

  return {
    sync,
    setStateFilter,
    /** Redraw the open list in place, for when what a row shows has changed. */
    refresh: () => box.refresh(),
  };
}
