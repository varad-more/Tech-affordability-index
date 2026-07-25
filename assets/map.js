/**
 * County choropleth of the United States.
 *
 * A choropleth is the right form here and was not, at metro level: the value is
 * one figure per bounded area, which is exactly what a shaded region encodes. An
 * earlier draft shaded whole states, which cannot work — Texas holds both Austin
 * and Dallas, California holds four metros that disagree with each other, and
 * any state fill would have had to invent a number none of them supports.
 *
 * The basemap is pre-projected at build time (`scripts/build-basemap.mjs`), so
 * this file does no projection maths at all; it draws committed path strings and
 * repaints their fills.
 *
 * Built once, then repainted. Three thousand paths are too many to rebuild on
 * every keystroke in the salary field, so `render` constructs the DOM and hands
 * back a `paint` function that only touches fill attributes.
 */

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * Four evenly-spaced steps of the sequential ramp, darkest for the worst band.
 * Used by the verdict swatch and the salary ladder, where there really are only
 * four states to show.
 */
export const BAND_STEP = {
  comfortable: '--seq-1',
  'getting-by': '--seq-3',
  survival: '--seq-5',
  'below-survival': '--seq-7',
};

/**
 * The map's ramp: one token per class break, light (easiest) to dark (hardest).
 * The tokens invert under dark mode, which keeps "worse" reading as higher
 * contrast against whichever surface is behind it.
 */
const RAMP = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];

/** Counties Zillow does not publish an index for. Deliberately not a ramp step. */
const NO_DATA_FILL = 'var(--map-nodata)';

/**
 * Draw the map.
 *
 * @param {HTMLElement} mount
 * @param {object}   basemap    parsed data/us-basemap.json
 * @param {Function} onSelect   called with a county FIPS when one is clicked
 * @param {Function} onHover    called with a county FIPS (or null) on hover
 * @returns {{ paint: Function, svg: SVGElement }}
 */
export function countyMap(mount, { basemap, onSelect, onHover }) {
  mount.replaceChildren();

  const svg = el('svg', {
    viewBox: basemap.viewBox,
    class: 'map-svg',
    role: 'img',
    'aria-label':
      'County-level map of the United States, shaded by whether the selected salary is comfortable, getting by, survival, or below survival',
  });

  const countyLayer = el('g', { class: 'map-counties' });
  const nodes = new Map();

  for (const county of basemap.counties) {
    const path = el('path', {
      d: county.d,
      class: 'map-county',
      fill: NO_DATA_FILL,
      'data-fips': county.id,
    });
    nodes.set(county.id, path);
    countyLayer.appendChild(path);
  }
  svg.appendChild(countyLayer);

  // State outlines on top of the fills, as a stroked overlay only. They give the
  // eye something to navigate by; 3,142 county borders alone read as noise.
  const stateLayer = el('g', { class: 'map-states' });
  for (const state of basemap.states) {
    stateLayer.appendChild(el('path', { d: state.d, class: 'map-state' }));
  }
  svg.appendChild(stateLayer);

  // The selection outline is a single path that moves, rather than a class
  // toggled across thousands of nodes.
  const selection = el('path', { class: 'map-selected', d: '' });
  svg.appendChild(selection);

  /**
   * One delegated listener rather than 3,142. Attaching handlers per county
   * costs more memory than the geometry itself and makes teardown a chore.
   */
  const fipsFromEvent = (event) => event.target?.getAttribute?.('data-fips') ?? null;

  svg.addEventListener('mousemove', (event) => onHover?.(fipsFromEvent(event), event));
  svg.addEventListener('mouseleave', () => onHover?.(null));
  svg.addEventListener('click', (event) => {
    const fips = fipsFromEvent(event);
    if (fips) onSelect?.(fips);
  });

  /**
   * Repaint fills.
   *
   * @param {Map<string,number>} stepByFips  county FIPS -> ramp class 0..6
   * @param {string|null} selectedFips
   */
  function paint(stepByFips, selectedFips) {
    for (const [fips, node] of nodes) {
      const step = stepByFips.get(fips);
      node.setAttribute(
        'fill',
        step === undefined || step === null ? NO_DATA_FILL : `var(${RAMP[step]})`,
      );
    }

    const chosen = selectedFips ? nodes.get(selectedFips) : null;
    selection.setAttribute('d', chosen ? chosen.getAttribute('d') : '');
  }

  mount.appendChild(svg);
  return { paint, svg };
}

/**
 * Legend for the map ramp, plus the no-data class.
 *
 * Colour is the only encoding on the map, so this is required rather than
 * decorative. The no-data entry is part of the legend, not a footnote: more than
 * half of US counties carry it, and a reader must be able to tell "cheap" from
 * "unmeasured" at a glance.
 *
 * @param {Array} classes NEEDS_SHARE_CLASSES from src/bands.js
 */
export function rampLegendFor(mount, classes) {
  mount.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'map-legend';

  const caption = document.createElement('div');
  caption.className = 'map-legend-caption';
  caption.textContent = 'Share of take-home pay that rent and necessities consume';
  wrap.appendChild(caption);

  const scale = document.createElement('div');
  scale.className = 'map-legend-scale';

  classes.forEach((cls, i) => {
    const item = document.createElement('span');
    item.className = 'map-legend-item';

    const swatch = document.createElement('i');
    swatch.style.background = `var(${RAMP[i]})`;

    const text = document.createElement('span');
    text.textContent = cls.label;

    item.append(swatch, text);
    if (cls.note) item.title = cls.note;
    scale.appendChild(item);
  });

  const nodata = document.createElement('span');
  nodata.className = 'map-legend-item';
  const swatch = document.createElement('i');
  swatch.style.background = NO_DATA_FILL;
  const text = document.createElement('span');
  text.textContent = 'no data';
  nodata.append(swatch, text);
  nodata.title = 'Zillow publishes no rent index for this county.';
  scale.appendChild(nodata);

  wrap.appendChild(scale);
  mount.appendChild(wrap);
}
