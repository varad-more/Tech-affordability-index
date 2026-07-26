/**
 * County choropleth of the United States, with zoom and pan.
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
 * Zoom is a single transform on one wrapper group, never a re-render. At 3,142
 * counties, anything that touches per-path geometry on a wheel event is a
 * slideshow. Strokes carry `vector-effect: non-scaling-stroke`, so county
 * hairlines and state borders stay one pixel wide at 30× instead of swelling
 * into slabs that swallow the fills they are meant to separate.
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

/** Counties with no rent figure on the active basis. Deliberately not a ramp step. */
const NO_DATA_FILL = 'var(--map-nodata)';

const ZOOM_MIN = 1;
const ZOOM_MAX = 32;

/** One click of the +/− buttons. About two clicks per doubling. */
const ZOOM_STEP = 1.55;

/** A zoomed-to county should fill roughly this share of the frame's short side. */
const FIT_SHARE = 0.3;

/** Below this, "zoom to county" would barely move — jump somewhere useful instead. */
const FIT_MIN_SCALE = 4;

/** Arrow-key pan, as a share of the visible width. */
const KEY_PAN = 0.12;

const ICONS = {
  in: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  out: '<path d="M3.2 8h9.6"/>',
  locate:
    '<circle cx="8" cy="8" r="3.1"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/>',
  reset: '<path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10"/>',
};

function iconButton(action, label, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `map-btn ${extraClass}`.trim();
  b.dataset.act = action;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML =
    `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[action]}</svg>`;
  return b;
}

/**
 * Draw the map.
 *
 * @param {HTMLElement} mount
 * @param {object}   basemap    parsed data/us-basemap.json
 * @param {Function} onSelect   called with a county FIPS when one is clicked
 * @param {Function} onHover    called with a county FIPS (or null) on hover
 * @param {Function} onSelectState called with a postal code when a state is
 *   clicked, in state mode only
 * @param {Function} onHoverState  called with a postal code (or null) on hover,
 *   in state mode only
 * @param {Function} onLocate   called when the locate button is pressed. Return
 *   a 5-digit county FIPS to frame a county, or a 2-letter postal code to frame
 *   a whole state; the two never collide, so no flag is needed to tell them apart
 * @param {string}   locateLabel button title, for pages whose locate target is
 *   not a county
 * @param {string}   label       the SVG's accessible name
 * @returns {{ paint: Function, paintStates: Function, setStateMode: Function,
 *            outlineState: Function, svg: SVGElement, zoomToCounty: Function,
 *            zoomToState: Function, revealCounty: Function, reset: Function }}
 */
export function countyMap(mount, {
  basemap,
  onSelect,
  onHover,
  onSelectState,
  onHoverState,
  onLocate,
  locateLabel = 'Zoom to the selected county',
  label =
    'County-level map of the United States, shaded by the share of take-home pay that ' +
    'rent and necessities consume. Zoom with the plus and minus keys, pan with the arrow keys.',
}) {
  mount.replaceChildren();
  mount.classList.add('map-frame');

  // `contentBox` is the projection frame cropped to the country actually drawn,
  // which is about a fifth smaller than the nominal 960x600. Falling back to
  // `viewBox` keeps this working against a basemap built before the crop existed.
  const box = basemap.contentBox ?? basemap.viewBox;
  const [VIEW_X, VIEW_Y, VIEW_W, VIEW_H] = box.split(/[\s,]+/).map(Number);
  const MID_X = VIEW_X + VIEW_W / 2;
  const MID_Y = VIEW_Y + VIEW_H / 2;

  const svg = el('svg', {
    viewBox: box,
    class: 'map-svg',
    role: 'group',
    tabindex: '0',
    'aria-label': label,
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

  // The basemap names states by FIPS prefix and counties by postal code, so the
  // crosswalk is already in the data and does not need a second table.
  const codeByPrefix = new Map();
  for (const county of basemap.counties) {
    const prefix = county.id.slice(0, 2);
    if (county.st && !codeByPrefix.has(prefix)) codeByPrefix.set(prefix, county.st);
  }

  // State outlines on top of the fills. Normally a stroked overlay only — they
  // give the eye something to navigate by, since 3,142 county borders alone read
  // as noise — but this is also the layer that takes a fill when a caller shades
  // whole states rather than counties.
  //
  // The nodes are kept because they are also the only geometry that knows where
  // a *state* is: narrowing the picker to Washington zooms the map there, and
  // that needs the state's own bounding box, not the union of its counties'.
  const stateLayer = el('g', { class: 'map-states' });
  const stateNodes = new Map();
  const stateNodeByCode = new Map();
  for (const state of basemap.states) {
    const code = codeByPrefix.get(state.id) ?? null;
    const path = el('path', { d: state.d, class: 'map-state', 'data-state': code });
    stateNodes.set(state.id, path);
    if (code) stateNodeByCode.set(code, path);
    stateLayer.appendChild(path);
  }

  // The selection outline is a single path that moves, rather than a class
  // toggled across thousands of nodes.
  const selection = el('path', { class: 'map-selected', d: '' });

  // Everything zoomable lives under one group, so panning is one attribute write
  // rather than 3,142.
  const view = el('g', { class: 'map-view' });
  view.append(countyLayer, stateLayer, selection);
  svg.appendChild(view);
  mount.appendChild(svg);

  /* ------------------------------------------------------------- controls */

  const controls = document.createElement('div');
  controls.className = 'map-controls';

  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'map-btn-group';
  const btnIn = iconButton('in', 'Zoom in');
  const btnOut = iconButton('out', 'Zoom out');
  zoomGroup.append(btnIn, btnOut);

  const btnLocate = iconButton('locate', locateLabel);
  const btnReset = iconButton('reset', 'Reset the view to the whole country');

  controls.append(zoomGroup, btnLocate, btnReset);
  mount.appendChild(controls);

  const status = document.createElement('div');
  status.className = 'map-status';
  const level = document.createElement('span');
  level.className = 'map-zoom-level';
  const hint = document.createElement('span');
  hint.className = 'map-hint';
  hint.textContent = 'scroll to zoom · drag to pan';
  status.append(level, hint);
  mount.appendChild(status);

  /* ----------------------------------------------------------- transform */

  let k = 1;
  let tx = 0;
  let ty = 0;

  const clampK = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

  function apply() {
    // Keep the frame full: the content may never be dragged far enough for the
    // page background to show through the side of the map. A local point p is
    // drawn at k*p + t, so requiring the visible window to stay inside the
    // content box gives t ∈ [(min + size)(1 − k), min(1 − k)] on each axis.
    tx = Math.min(VIEW_X * (1 - k), Math.max((VIEW_X + VIEW_W) * (1 - k), tx));
    ty = Math.min(VIEW_Y * (1 - k), Math.max((VIEW_Y + VIEW_H) * (1 - k), ty));

    view.setAttribute(
      'transform',
      `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(4)})`,
    );

    const zoomed = k > ZOOM_MIN + 1e-6;
    level.textContent = `${k.toFixed(1)}×`;
    hint.textContent = zoomed ? 'drag to pan · reset to zoom out' : 'scroll to zoom · drag to pan';
    btnIn.disabled = k >= ZOOM_MAX - 1e-6;
    btnOut.disabled = !zoomed;
    btnReset.disabled = !zoomed;
    mount.classList.toggle('is-zoomed', zoomed);
  }

  /** Zoom while holding one viewBox point still under the cursor. */
  function zoomAround(nextK, px, py) {
    const k2 = clampK(nextK);
    if (Math.abs(k2 - k) < 1e-9) return;
    tx = px - ((px - tx) * k2) / k;
    ty = py - ((py - ty) * k2) / k;
    k = k2;
    apply();
  }

  const zoomCentre = (factor) => zoomAround(k * factor, MID_X, MID_Y);

  function reset() {
    k = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  /**
   * The viewBox is the element's own coordinate space and `height: auto` keeps
   * the aspect ratio exact, so there is no letterboxing to correct for: a client
   * point maps to viewBox units by simple proportion.
   */
  function toView(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return [
      VIEW_X + ((clientX - r.left) / r.width) * VIEW_W,
      VIEW_Y + ((clientY - r.top) / r.height) * VIEW_H,
    ];
  }

  /**
   * The county's own bounding box in untransformed coordinates.
   *
   * `getBBox` reports local geometry and ignores the zoom transform above it,
   * which is exactly what is wanted here — and it throws in browsers when the
   * element has never been laid out.
   */
  function boxOf(node) {
    if (!node) return null;
    try {
      const bbox = node.getBBox();
      return bbox.width > 0 || bbox.height > 0 ? bbox : null;
    } catch {
      return null;
    }
  }

  const localBox = (fips) => boxOf(nodes.get(fips));

  /** Centre the map on one county, zoomed in far enough to read it. */
  function zoomToCounty(fips) {
    const bbox = localBox(fips);
    if (!bbox) return;

    const fit = Math.min(
      VIEW_W / Math.max(bbox.width, 1e-6),
      VIEW_H / Math.max(bbox.height, 1e-6),
    );
    k = clampK(Math.max(FIT_MIN_SCALE, fit * FIT_SHARE));
    tx = MID_X - (bbox.x + bbox.width / 2) * k;
    ty = MID_Y - (bbox.y + bbox.height / 2) * k;
    apply();
  }

  /**
   * Frame one state, the whole state and no more.
   *
   * Unlike `zoomToCounty` this has no minimum: Texas already fills the frame at
   * 1×, and forcing it past that would push its own edges off-screen. The fit is
   * capped at 92% of the frame so the state does not touch the sides.
   */
  function zoomToState(code) {
    const bbox = boxOf(stateNodeByCode.get(code));
    if (!bbox) return;

    const fit = Math.min(
      VIEW_W / Math.max(bbox.width, 1e-6),
      VIEW_H / Math.max(bbox.height, 1e-6),
    );
    k = clampK(fit * 0.92);
    tx = MID_X - (bbox.x + bbox.width / 2) * k;
    ty = MID_Y - (bbox.y + bbox.height / 2) * k;
    apply();
  }

  /**
   * Bring a county into view without changing the zoom level.
   *
   * Picking a county from the dropdown while zoomed into another part of the
   * country would otherwise highlight something off-screen, which reads as the
   * selection having failed.
   */
  function revealCounty(fips) {
    if (k <= ZOOM_MIN + 1e-6) return;
    const bbox = localBox(fips);
    if (!bbox) return;

    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;

    // Visible window in untransformed coordinates, inset so a county sitting
    // just inside the edge still counts as needing a recentre.
    const pad = 0.12;
    const left = (VIEW_X + VIEW_W * pad - tx) / k;
    const right = (VIEW_X + VIEW_W * (1 - pad) - tx) / k;
    const top = (VIEW_Y + VIEW_H * pad - ty) / k;
    const bottom = (VIEW_Y + VIEW_H * (1 - pad) - ty) / k;

    if (cx >= left && cx <= right && cy >= top && cy <= bottom) return;

    tx = MID_X - cx * k;
    ty = MID_Y - cy * k;
    apply();
  }

  /* -------------------------------------------------------- interactions */

  const fipsFromEvent = (event) => event.target?.getAttribute?.('data-fips') ?? null;
  const stateFromEvent = (event) => event.target?.getAttribute?.('data-state') ?? null;

  /**
   * Which layer is the data layer.
   *
   * In county mode the state paths are an unfilled overlay that ignores the
   * pointer, exactly as before. In state mode they take the fill and the hover,
   * and the counties beneath them step out of the way. Only the CSS class and
   * this flag change; the geometry, the zoom and the pan are shared.
   */
  let stateMode = false;

  // Pointers currently down, in client coordinates. One is a pan, two a pinch.
  const pointers = new Map();
  let pinchFrom = null;
  let panned = false;

  const hoverOut = () => (stateMode ? onHoverState?.(null) : onHover?.(null));

  svg.addEventListener('mousemove', (event) => {
    if (pointers.size) return; // mid-drag: a tooltip chasing the cursor is noise
    if (stateMode) onHoverState?.(stateFromEvent(event), event);
    else onHover?.(fipsFromEvent(event), event);
  });
  svg.addEventListener('mouseleave', hoverOut);

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      // Trackpads emit many small pixel deltas, mice a few large line deltas.
      // Normalising to pixels first keeps one gesture feeling the same on both.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const [px, py] = toView(event.clientX, event.clientY);
      zoomAround(k * Math.exp((-event.deltaY * unit) / 420), px, py);
      hoverOut();
    },
    { passive: false },
  );

  svg.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      panned = false;
      hoverOut();
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchFrom = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k };
    }
  });

  svg.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const before = `${tx},${ty},${k}`;
    const rect = svg.getBoundingClientRect();

    if (pointers.size >= 2 && pinchFrom) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const [mx, my] = toView((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAround(pinchFrom.k * (dist / pinchFrom.dist), mx, my);
    } else {
      tx += ((event.clientX - prev.x) / rect.width) * VIEW_W;
      ty += ((event.clientY - prev.y) / rect.height) * VIEW_H;
      apply();
    }

    // Only a drag that actually moved the map suppresses the click that follows.
    // At 1× the clamp pins the transform, so a sloppy click still selects.
    if (`${tx},${ty},${k}` !== before) {
      panned = true;
      mount.classList.add('is-panning');
      // Capture is taken here rather than on pointerdown, and only once the map
      // has genuinely moved. Capturing up front retargets the compatibility
      // mouse events — including the `click` — to the SVG itself, so
      // `event.target` stops being the county under the cursor and every click
      // silently selects nothing.
      if (!svg.hasPointerCapture(event.pointerId)) svg.setPointerCapture(event.pointerId);
    }
  });

  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchFrom = null;
    if (pointers.size === 0) mount.classList.remove('is-panning');
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  svg.addEventListener('click', (event) => {
    if (panned) {
      panned = false;
      return;
    }
    if (stateMode) {
      const code = stateFromEvent(event);
      if (code) onSelectState?.(code);
      return;
    }
    const fips = fipsFromEvent(event);
    if (fips) onSelect?.(fips);
  });

  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const [px, py] = toView(event.clientX, event.clientY);
    zoomAround(k * ZOOM_STEP * ZOOM_STEP, px, py);
  });

  svg.addEventListener('keydown', (event) => {
    const step = (VIEW_W * KEY_PAN) / 1;
    const actions = {
      '+': () => zoomCentre(ZOOM_STEP),
      '=': () => zoomCentre(ZOOM_STEP),
      '-': () => zoomCentre(1 / ZOOM_STEP),
      _: () => zoomCentre(1 / ZOOM_STEP),
      0: reset,
      ArrowLeft: () => { tx += step; apply(); },
      ArrowRight: () => { tx -= step; apply(); },
      ArrowUp: () => { ty += step; apply(); },
      ArrowDown: () => { ty -= step; apply(); },
    };
    const run = actions[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  });

  controls.addEventListener('click', (event) => {
    const act = event.target.closest('button')?.dataset.act;
    if (act === 'in') zoomCentre(ZOOM_STEP);
    else if (act === 'out') zoomCentre(1 / ZOOM_STEP);
    else if (act === 'reset') reset();
    else if (act === 'locate') {
      // A county FIPS is five digits and a postal code is two letters, so the
      // target says for itself which geometry to frame.
      const target = onLocate?.();
      if (!target) return;
      if (stateNodeByCode.has(target)) zoomToState(target);
      else zoomToCounty(target);
    }
  });

  /**
   * Repaint fills.
   *
   * @param {Map<string,number>} stepByFips  county FIPS -> ramp class 0..6
   * @param {string|null} selectedFips
   */
  function paint(stepByFips, selectedFips) {
    // The fills used to be computed in the same tick the map was built in.
    // They arrive over the network now, so between building and painting there
    // is a real window where every county is drawn no-data. This marks the end
    // of that window — for the tests, and for anyone styling a loading state.
    mount.dataset.painted = stepByFips.size > 0 ? 'true' : 'false';

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

  /**
   * Fill whole states from the same ramp.
   *
   * Only legitimate when the quantity genuinely belongs to the whole state
   * rather than to the places inside it — this file's opening comment is about
   * why shading a state by what it *costs* is a lie, and that has not changed.
   *
   * The fill goes on the inline style, not on a `fill` attribute: the
   * stylesheet's `.map-state { fill: none }` is what keeps this an outline layer
   * everywhere else, and a presentation attribute loses to a stylesheet rule.
   *
   * @param {Map<string,number|null>} stepByCode postal code -> ramp class 0..6
   */
  function paintStates(stepByCode) {
    for (const [code, node] of stateNodeByCode) {
      const step = stepByCode.get(code);
      node.style.fill =
        step === undefined || step === null ? NO_DATA_FILL : `var(${RAMP[step]})`;
    }
  }

  /** Swap which layer carries the data. Leaving state mode clears the fills. */
  function setStateMode(on) {
    stateMode = !!on;
    mount.classList.toggle('is-state-mode', stateMode);
    if (!stateMode) for (const node of stateNodeByCode.values()) node.style.fill = '';
  }

  /**
   * Outline one whole state, reusing the single selection path.
   *
   * Call it after `paint`, which resets that path to whichever county was passed
   * to it, or to nothing.
   */
  function outlineState(code) {
    const node = code ? stateNodeByCode.get(code) : null;
    selection.setAttribute('d', node ? node.getAttribute('d') : '');
  }

  apply();
  return {
    paint, paintStates, setStateMode, outlineState,
    svg, zoomToCounty, zoomToState, revealCounty, reset,
  };
}

/**
 * Legend for the map ramp, plus the no-data class.
 *
 * Colour is the only encoding on the map, so this is required rather than
 * decorative. The no-data entry is part of the legend, not a footnote: on the
 * Zillow basis more than half of US counties carry it, and a reader must be able
 * to tell "cheap" from "unmeasured" at a glance.
 *
 * @param {Array} classes NEEDS_SHARE_CLASSES from src/bands.js, or any list of
 *   `{ label, note? }` in ramp order, lightest first
 * @param {object} opts
 * @param {string} opts.caption what the shading encodes
 * @param {string} opts.noDataNote which source is silent here — it differs by basis
 * @param {string} opts.noDataLabel the no-data entry's own text
 */
export function rampLegendFor(mount, classes, {
  caption: captionText = 'Share of take-home pay that rent and necessities consume',
  noDataNote = 'No rent figure is published for this county.',
  noDataLabel = 'no data',
} = {}) {
  mount.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'map-legend';

  const caption = document.createElement('div');
  caption.className = 'map-legend-caption';
  caption.textContent = captionText;
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
  text.textContent = noDataLabel;
  nodata.append(swatch, text);
  nodata.title = noDataNote;
  scale.appendChild(nodata);

  wrap.appendChild(scale);
  mount.appendChild(wrap);
}
