/**
 * Hand-rolled SVG chart renderers. No dependencies, no CDN, no build step —
 * which is what keeps this hostable as flat files on GitHub Pages.
 */

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

/* ---------------------------------------------------------------- tooltip */

let tooltipNode;

function tooltip() {
  if (!tooltipNode) {
    tooltipNode = document.createElement('div');
    tooltipNode.id = 'tooltip';
    tooltipNode.setAttribute('role', 'status');
    document.body.appendChild(tooltipNode);
  }
  return tooltipNode;
}

/**
 * Clear a chart's mount, and dismiss any tooltip with it.
 *
 * A tooltip is anchored to a mark. Redrawing the chart destroys that mark, but
 * the tooltip lives on `document.body` and survived — so hovering a bar and then
 * editing the salary left a tooltip describing a bar that no longer existed,
 * floating over the page until the next hover. `mouseleave` never fires for a
 * node that is removed out from under the cursor.
 */
function clearMount(mount) {
  mount.replaceChildren();
  tooltipNode?.classList.remove('on');
}

/**
 * Attach a hover tooltip. The dataviz guidance treats this as default, not a
 * nicety: an HTML chart is interactive, so every mark should be interrogable.
 */
function attachTooltip(target, html) {
  const show = (event) => {
    const tip = tooltip();
    tip.innerHTML = html;
    tip.classList.add('on');
    move(event);
  };
  const move = (event) => {
    const tip = tooltip();
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };
  const hide = () => tooltip().classList.remove('on');

  target.addEventListener('mouseenter', show);
  target.addEventListener('mousemove', move);
  target.addEventListener('mouseleave', hide);
  target.addEventListener('focus', show);
  target.addEventListener('blur', hide);
}

/**
 * The drawing width for a chart that should fill the column it sits in.
 *
 * These charts were all authored at a fixed 880px. Panels are wider than that, so
 * every one of them left a ragged strip of empty surface down its right-hand
 * side; below 880 the SVG scaled down instead, shrinking the type with it.
 * Measuring the mount fixes both ends — the plot uses the room it has, and the
 * labels stay at the size they were designed at.
 *
 * The floor sits below a phone's column on purpose. These forms all still work at
 * ~330px — the bar chart keeps a 116px name gutter and still has 158px of plot —
 * so drawing them at the container's true width leaves the labels at their design
 * size. Holding a wider floor would only hand them back to `max-width: 100%` to
 * scale down, which is how 11px axis text ended up rendering at 6.5px.
 *
 * A mount with no layout yet (hidden, or not in the document) measures zero, and
 * falls back to the original width.
 */
function frameWidth(mount, { min = 300, max = 1180, fallback = 880 } = {}) {
  const avail = mount?.clientWidth ?? 0;
  if (!avail) return fallback;
  return Math.round(Math.max(min, Math.min(max, avail)));
}

/* ------------------------------------------------------------ time series */

/**
 * Monthly rent over time.
 *
 * A line, because the x-axis is continuous time and the reader's question is
 * about shape — is this climbing, flattening, falling? Bars would imply
 * discrete, independent periods.
 *
 * The y-axis deliberately does NOT start at zero. For an index that has never
 * been near zero, a zero baseline compresses years of movement into a flat strip
 * at the top of the plot and hides the thing the chart exists to show. The axis
 * is labelled so the truncation is visible rather than sneaky.
 *
 * @param {Array<{ month: string, value: number|null }>} points
 */
export function timeSeries(mount, points, { valueFormat = money } = {}) {
  clearMount(mount);

  const W = frameWidth(mount);
  const H = 260;
  const padL = 58;
  const padR = 14;
  const padT = 14;
  const padB = 30;

  const real = points.filter((p) => p.value !== null);
  if (real.length < 2) return;

  const values = real.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const yLo = lo - span * 0.12;
  const yHi = hi + span * 0.12;

  const x = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = (v) => H - padB - ((v - yLo) / (yHi - yLo)) * (H - padT - padB);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': `Monthly rent from ${points[0].month} to ${points.at(-1).month}`,
  });

  // Horizontal gridlines with value labels.
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = yLo + ((yHi - yLo) * t) / ticks;
    const gy = y(v);
    svg.appendChild(el('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, class: 'tick-line' }));
    svg.appendChild(
      el('text', { x: padL - 8, y: gy + 4, class: 'axis-label', 'text-anchor': 'end' }, valueFormat(v)),
    );
  }

  // Year labels along the bottom, at each January only. Matching on the MONTH
  // component specifically: every value here carries a day of 01, so a looser
  // test labels all seventy-two months and smears them into one illegible line.
  points.forEach((p, i) => {
    if (!/^\d{4}-01-\d{2}$/.test(p.month)) return;
    const year = p.month.slice(0, 4);
    svg.appendChild(
      el('text', { x: x(i), y: H - 8, class: 'axis-label', 'text-anchor': 'middle' }, year),
    );
  });

  // Break the path at gaps rather than drawing a straight line across missing
  // months, which would invent data.
  let d = '';
  let pen = 'M';
  points.forEach((p, i) => {
    if (p.value === null) {
      pen = 'M';
      return;
    }
    d += `${pen}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
    pen = 'L';
  });

  svg.appendChild(
    el('path', { d, class: 'spark-line', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
  );

  // One hit target per point, wide enough to be usable, invisible until hovered.
  const step = (W - padL - padR) / (points.length - 1);
  points.forEach((p, i) => {
    if (p.value === null) return;
    const g = el('g', { class: 'ts-point', tabindex: '0' });
    g.appendChild(
      el('rect', {
        x: x(i) - step / 2, y: padT, width: Math.max(step, 3), height: H - padT - padB,
        fill: 'transparent',
      }),
    );
    g.appendChild(el('circle', { cx: x(i), cy: y(p.value), r: 3.5, class: 'ts-dot' }));

    attachTooltip(
      g,
      `<div class="t-title">${p.label ?? p.month}</div>` +
        `<div class="t-row">${valueFormat(p.value)}/mo</div>`,
    );
    svg.appendChild(g);
  });

  svg.appendChild(el('line', { x1: padL, y1: padT, x2: padL, y2: H - padB, class: 'baseline' }));
  mount.appendChild(svg);
}

/* --------------------------------------------------------- diverging bars */

/**
 * Deviation from a baseline, above and below zero.
 *
 * This is a diverging encoding, not a sequential one: the value has a meaningful
 * midpoint (the annual average) and a direction either side of it. So it gets two
 * hues and a neutral middle, never a single ramp — a ramp would imply that
 * "below average" and "above average" are the same kind of thing, only more so.
 *
 * @param {Array<{ label: string, value: number, tooltip?: string }>} bars
 *        values are signed fractions, e.g. -0.019 for 1.9% below average
 */
export function divergingBars(mount, bars, { format = (v) => pct(v, 1), highlight } = {}) {
  clearMount(mount);

  const W = frameWidth(mount);
  const gap = 10;
  const midY = 96;
  const maxBar = 62;
  const H = 200;

  // Twelve fixed-width bars centred in a wider frame would only push the margins
  // out; widening the bars instead spends the extra room on the data. The cap
  // stops a wide viewport from turning twelve months into twelve slabs.
  const sideMargin = 16;
  const span = W - sideMargin * 2 - (bars.length - 1) * gap;
  const barW = Math.round(Math.max(24, Math.min(72, span / bars.length)));

  const peak = Math.max(...bars.map((b) => Math.abs(b.value)), 0.001);
  const scale = (v) => (Math.abs(v) / peak) * maxBar;

  const totalW = bars.length * barW + (bars.length - 1) * gap;
  const startX = (W - totalW) / 2;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': 'Rent by calendar month, as a deviation from the annual average',
  });

  // Zero line: the reference the whole chart is read against.
  svg.appendChild(el('line', { x1: 16, y1: midY, x2: W - 16, y2: midY, class: 'baseline' }));

  bars.forEach((bar, i) => {
    const x = startX + i * (barW + gap);
    const height = scale(bar.value);
    const above = bar.value > 0;
    const y = above ? midY - height : midY;

    const g = el('g', { class: 'div-bar', tabindex: '0' });
    g.appendChild(
      el('rect', {
        x, y, width: barW, height: Math.max(height, 1), rx: 3,
        fill: above ? 'var(--div-warm)' : 'var(--div-cool)',
        opacity: highlight && !highlight.includes(i) ? 0.42 : 1,
      }),
    );

    // Month label always on the outside of the bar, so it never sits on the fill.
    g.appendChild(
      el(
        'text',
        { x: x + barW / 2, y: above ? midY + 16 : midY - 7, class: 'cat-label', 'text-anchor': 'middle' },
        bar.label,
      ),
    );
    g.appendChild(
      el(
        'text',
        {
          x: x + barW / 2,
          y: above ? y - 6 : y + height + 14,
          class: 'value-label',
          'text-anchor': 'middle',
          'font-weight': '600',
        },
        format(bar.value),
      ),
    );

    attachTooltip(g, bar.tooltip ?? `<div class="t-row">${format(bar.value)}</div>`);
    svg.appendChild(g);
  });

  mount.appendChild(svg);
}

/* ------------------------------------------------------------ stacked bar */

/**
 * One stacked bar: what a month costs, split into its parts.
 *
 * A single stacked bar rather than a pie or a column chart — the question is
 * part-to-whole for one total, and a stacked bar keeps the parts on a common
 * baseline so their widths stay directly comparable.
 *
 * Segments are separated by a 2px gap in the surface colour so adjacent fills
 * never appear to merge into one block.
 *
 * @param {Array} segments { label, value, color }
 */
export function stackedBar(mount, segments, { total } = {}) {
  clearMount(mount);

  const W = frameWidth(mount);
  const H = 116;
  const barY = 8;
  const barH = 42;
  const GAP = 2;

  const sum = total ?? segments.reduce((n, s) => n + s.value, 0);
  if (!(sum > 0)) return;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': `Monthly cost of living of ${money(sum)}, split by category`,
  });

  let x = 0;
  segments.forEach((segment, i) => {
    const raw = (segment.value / sum) * W;
    const isLast = i === segments.length - 1;
    const width = Math.max(0, isLast ? W - x : raw - GAP);
    if (width <= 0) return;

    const g = el('g', { tabindex: '0' });
    g.appendChild(
      el('rect', { x, y: barY, width, height: barH, rx: 2, fill: segment.color }),
    );

    // Direct-label only the segments with room, never every one.
    if (width > 54) {
      g.appendChild(
        el(
          'text',
          {
            x: x + width / 2,
            y: barY + barH + 16,
            class: 'axis-label',
            'text-anchor': 'middle',
          },
          segment.label,
        ),
      );
      g.appendChild(
        el(
          'text',
          {
            x: x + width / 2,
            y: barY + barH + 30,
            class: 'value-label',
            'text-anchor': 'middle',
            'font-weight': '600',
          },
          money(segment.value),
        ),
      );
    }

    attachTooltip(
      g,
      `<div class="t-title">${segment.label}</div>` +
        `<div class="t-row">${money(segment.value)}/mo</div>` +
        `<div class="t-row">${pct(segment.value / sum, 1)} of the total</div>`,
    );
    svg.appendChild(g);
    x += raw;
  });

  mount.appendChild(svg);
}

/* ---------------------------------------------------------- salary ladder */

/**
 * Where one salary lands against a metro's thresholds — a bullet chart, the
 * standard form for a single measure read against qualitative ranges.
 *
 * A bar chart would compare the four numbers to each other, which is not the
 * question. The question is which range this salary falls in, so the ranges
 * become the background and the salary becomes the mark.
 *
 * @param {object} bands   { survival, gettingBy, comfortable } gross salaries
 * @param {number} salary  the salary being placed
 * @param {object} colors  band id -> CSS colour value
 */
export function salaryLadder(mount, { bands, salary, colors, bandLabel }) {
  clearMount(mount);

  const W = frameWidth(mount);
  const H = 104;
  const padL = 8;
  const padR = 8;
  const barY = 30;
  const barH = 26;

  const plotW = W - padL - padR;
  // Leave headroom past the comfortable line so the top band is visibly a range
  // and not a hard ceiling, and never let the marker sit on the edge.
  const max = Math.max(bands.comfortable * 1.3, salary * 1.12);
  const x = (v) => padL + Math.max(0, Math.min(1, v / max)) * plotW;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': `Salary of ${money(salary)} shown against this metro's survival, getting by and comfortable thresholds`,
  });

  const regions = [
    { from: 0, to: bands.survival, id: 'below-survival' },
    { from: bands.survival, to: bands.gettingBy, id: 'survival' },
    { from: bands.gettingBy, to: bands.comfortable, id: 'getting-by' },
    { from: bands.comfortable, to: max, id: 'comfortable' },
  ];

  for (const region of regions) {
    const x0 = x(region.from);
    const width = x(region.to) - x0;
    if (width <= 0) continue;
    svg.appendChild(
      el('rect', { x: x0, y: barY, width, height: barH, fill: colors[region.id], rx: 2 }),
    );
  }

  // Threshold ticks, labelled beneath the strip.
  const ticks = [
    { value: bands.survival, label: 'Survival' },
    { value: bands.gettingBy, label: 'Getting by' },
    { value: bands.comfortable, label: 'Comfortable' },
  ];

  for (const tick of ticks) {
    const tx = x(tick.value);
    svg.appendChild(
      el('line', { x1: tx, y1: barY, x2: tx, y2: barY + barH + 5, class: 'ladder-tick' }),
    );
    svg.appendChild(
      el('text', { x: tx, y: barY + barH + 19, class: 'axis-label', 'text-anchor': 'middle' }, tick.label),
    );
    svg.appendChild(
      el(
        'text',
        { x: tx, y: barY + barH + 32, class: 'value-label', 'text-anchor': 'middle', 'font-weight': '600' },
        money(tick.value),
      ),
    );
  }

  // The salary marker, drawn last and in text ink so it reads against any band.
  const sx = x(salary);
  svg.appendChild(
    el('line', { x1: sx, y1: barY - 12, x2: sx, y2: barY + barH + 2, class: 'ladder-marker' }),
  );

  // Keep the marker's label inside the plate at both extremes.
  const anchor = sx > W - 120 ? 'end' : sx < 120 ? 'start' : 'middle';
  svg.appendChild(
    el(
      'text',
      { x: sx, y: barY - 17, class: 'ladder-marker-label', 'text-anchor': anchor },
      `${money(salary)} · ${bandLabel}`,
    ),
  );

  mount.appendChild(svg);
}

/** Bar with only its data end rounded, so the mark stays anchored to the baseline. */
function barPath(x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w));
  if (w <= 0) return `M${x},${y}`;
  return [
    `M${x},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h - radius}`,
    `Q${x + w},${y + h} ${x + w - radius},${y + h}`,
    `H${x}`,
    'Z',
  ].join(' ');
}

/* ------------------------------------------------------- ranked bar chart */

/**
 * Ranked horizontal bars — the default form for comparing magnitude across many
 * long-named categories. Bar length carries the value, so the fill stays a
 * single hue rather than redundantly re-encoding it.
 */
export function rankedBarChart(mount, rows, { threshold, thresholdLabel, gutter, label } = {}) {
  clearMount(mount);

  const W = frameWidth(mount);
  // Metro names fit in 116px; "Barnstable County, MA" does not, and a clipped
  // label is worse than a slightly shorter bar.
  const gutterL = gutter ?? 116;
  const gutterR = 56;
  const rowH = 26;
  const barH = 14;
  const top = 26;
  const H = top + rows.length * rowH + 16;

  const plotW = W - gutterL - gutterR;
  const maxValue = Math.max(...rows.map((r) => r.value), threshold ?? 0) * 1.08;
  const x = (v) => (v / maxValue) * plotW;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    // Three pages draw this chart from three different quantities, so the name
    // has to come from the caller. It said "rent, by metro" everywhere,
    // including on the seasonal leaderboard, where that was simply false.
    'aria-label':
      label ?? 'Share of monthly take-home pay spent on rent, by metro, ranked lowest to highest',
  });

  // Gridlines behind the marks, at a step chosen from the range rather than
  // fixed at 10%.
  //
  // A fixed step is only safe while the range is. Rent as a share of take-home
  // is normally under 50%, but take-home is the denominator: a salary of $1 —
  // which is what the field holds for one keystroke while someone types
  // "150000" — makes the ratio astronomical, and `v += 0.1` up to it queued
  // millions of gridlines. The page froze for eleven seconds building a DOM
  // nobody would ever see. This keeps the count bounded whatever the data does.
  const TARGET_TICKS = 8;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(maxValue, 1e-6) / TARGET_TICKS));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => maxValue / s <= TARGET_TICKS) ??
    magnitude * 10;

  for (let i = 0; i * step <= maxValue; i++) {
    const v = i * step;
    const gx = gutterL + x(v);
    svg.appendChild(el('line', { x1: gx, y1: top - 8, x2: gx, y2: H - 16, class: 'tick-line' }));
    svg.appendChild(
      el('text', { x: gx, y: top - 14, class: 'axis-label', 'text-anchor': 'middle' },
        pct(v, step < 0.01 ? 1 : 0)),
    );
  }

  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const g = el('g', { class: 'bar-row', tabindex: '0', role: 'listitem' });

    g.appendChild(
      el('text', { x: gutterL - 10, y: y + barH - 1, class: 'cat-label', 'text-anchor': 'end' }, row.label),
    );
    g.appendChild(
      el('path', { d: barPath(gutterL, y, x(row.value), barH, 4), class: 'bar' }),
    );
    g.appendChild(
      el(
        'text',
        { x: gutterL + x(row.value) + 8, y: y + barH - 1, class: 'value-label' },
        pct(row.value, 1),
      ),
    );

    attachTooltip(g, row.tooltip ?? `<div class="t-title">${row.label}</div>`);
    svg.appendChild(g);
  });

  // Reference line last, so it reads on top of the bars.
  if (threshold !== undefined) {
    const tx = gutterL + x(threshold);
    svg.appendChild(el('line', { x1: tx, y1: top - 8, x2: tx, y2: H - 16, class: 'threshold-line' }));
    svg.appendChild(
      el('text', { x: tx + 6, y: H - 4, class: 'threshold-label' }, thresholdLabel ?? pct(threshold)),
    );
  }

  svg.appendChild(el('line', { x1: gutterL, y1: top - 8, x2: gutterL, y2: H - 16, class: 'baseline' }));
  mount.appendChild(svg);
}

/* ---------------------------------------------------------------- heatmap */

const RAMP = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];

/** Which ramp step a value lands on. */
function rampStep(value, min, max) {
  const t = max === min ? 0.5 : (value - min) / (max - min);
  return Math.min(RAMP.length - 1, Math.max(0, Math.round(t * (RAMP.length - 1))));
}

function rampColor(step) {
  return step === null ? 'transparent' : `var(${RAMP[step]})`;
}

function isDarkMode() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Ink that stays legible on the chosen ramp step.
 *
 * Keyed to the STEP INDEX, not the raw value: the fill is quantised to seven
 * steps, so deciding ink from the unquantised fraction lets the two disagree
 * near a boundary and puts white text on a mid-tone cell.
 *
 * The ramp inverts between modes — darkening with magnitude on a light surface,
 * brightening on a dark one — so the light-ink range flips with it.
 */
function inkFor(step) {
  const needsLightInk = isDarkMode() ? step <= 2 : step >= 4;
  return needsLightInk ? '#ffffff' : '#0b0b0b';
}

/**
 * Heatmap: the named form for magnitude across a grid. Color is the ONLY
 * encoding here, so the ramp is sequential and every cell prints its value
 * (the relief rule for ramp steps that sit under 3:1 against the surface).
 *
 * @param {object} opts
 * @param {string[]} opts.rowLabels
 * @param {Array} opts.colLabels   {title, subtitle}
 * @param {Array} opts.cells       [row][col] => {value, tooltip}
 * @param {Function} [opts.format] how a cell prints its own value
 * @param {'grid'|'column'} [opts.scale]
 * @param {number} [opts.gutter]   width reserved for row labels
 * @param {number} [opts.rowHeight]
 * @param {string} [opts.label]    accessible name for the whole grid
 * @param {boolean} [opts.focusable] whether each cell is its own tab stop
 */
export function heatmap(mount, { rowLabels, colLabels, cells, ...opts }) {
  clearMount(mount);

  const format = opts.format ?? ((v) => pct(v, 1));
  /**
   * `column` shades each column against its own range.
   *
   * A grid whose columns are different quantities has no shared scale to shade
   * against: rent near $1,800 beside a $95 phone bill puts every non-rent column
   * on the palest step, and the map reads as one dark stripe and six blanks. Per
   * column, the colour answers "high or low *for this line of the budget*",
   * which is the comparison the grid is arranged to support. The cells still
   * print absolute values, so nothing about the magnitude is hidden.
   */
  const perColumn = opts.scale === 'column';
  const focusable = opts.focusable ?? true;

  const gutterL = opts.gutter ?? 116;
  const cellH = opts.rowHeight ?? 26;
  const gap = 2;
  const top = 40;

  // Cell width follows the space actually available. Left to `max-width: 100%`
  // the whole SVG scaled down — 10.5px labels landed at 8.6px — and, because the
  // height attribute did not shrink with it, 113px of dead band was left above
  // and below.
  //
  // Unlike the other charts this one cannot be made to fit a phone: seven columns
  // of "13.2%" need roughly 700px however they are arranged. So it is the one
  // chart that opts out of `max-width` (via `.chart-wide`) and overflows into its
  // scroller, where the reader pans a legible grid instead of squinting at a
  // scaled one. The floor is the width below which a cell stops holding a label.
  const MIN_CELL = 74;
  const MAX_CELL = 150;
  const avail = mount.clientWidth || 0;
  const fitted = avail > 0 ? (avail - gutterL) / colLabels.length - gap : MAX_CELL;
  const cellW = Math.round(Math.max(MIN_CELL, Math.min(MAX_CELL, fitted)));

  const W = gutterL + colLabels.length * (cellW + gap);
  const H = top + rowLabels.length * (cellH + gap) + 8;

  const real = (list) =>
    list.filter((c) => c?.value !== null && c?.value !== undefined).map((c) => c.value);

  // One domain for the whole grid, or one per column. Either way it is an array
  // indexed by column, so the cell loop below reads the same in both cases.
  const domains = colLabels.map((_, c) => {
    const values = real(perColumn ? cells.map((row) => row[c]) : cells.flat());
    return { min: Math.min(...values), max: Math.max(...values) };
  });

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    class: 'chart-wide',
    role: 'img',
    'aria-label': opts.label ?? 'Share of take-home pay spent on rent, by metro and offer',
  });

  colLabels.forEach((label, c) => {
    const cx = gutterL + c * (cellW + gap) + cellW / 2;
    svg.appendChild(
      el('text', { x: cx, y: top - 22, class: 'cat-label', 'text-anchor': 'middle', 'font-weight': '600' }, label.title),
    );
    svg.appendChild(
      el('text', { x: cx, y: top - 8, class: 'axis-label', 'text-anchor': 'middle' }, label.subtitle ?? ''),
    );
  });

  rowLabels.forEach((rowLabel, r) => {
    const y = top + r * (cellH + gap);
    svg.appendChild(
      el('text', { x: gutterL - 10, y: y + cellH / 2 + 4, class: 'cat-label', 'text-anchor': 'end' }, rowLabel),
    );

    colLabels.forEach((_, c) => {
      const cell = cells[r][c];
      const x = gutterL + c * (cellW + gap);
      // A grid of 400 cells is 400 tab stops between one section and the next.
      // Where the row label, the column header and the printed value already say
      // everything the tooltip would, the cells are not focusable and the
      // tooltip is left as mouse enrichment rather than as the only route to a
      // fact. Callers whose tooltips carry something extra opt back in.
      const g = el('g', focusable ? { tabindex: '0' } : {});

      const step =
        cell.value === null || cell.value === undefined
          ? null
          : rampStep(cell.value, domains[c].min, domains[c].max);

      g.appendChild(
        el('rect', { x, y, width: cellW, height: cellH, rx: 3, fill: rampColor(step) }),
      );

      if (step !== null) {
        g.appendChild(
          el(
            'text',
            {
              x: x + cellW / 2, y: y + cellH / 2 + 4,
              class: 'cell-value', 'text-anchor': 'middle',
              fill: inkFor(step),
            },
            format(cell.value),
          ),
        );
      }

      attachTooltip(g, cell.tooltip ?? '');
      svg.appendChild(g);
    });
  });

  mount.appendChild(svg);
}

/** Legend strip for the heatmap ramp. */
export function rampLegend(mount, minLabel, maxLabel) {
  clearMount(mount);
  const wrap = document.createElement('div');
  wrap.className = 'legend';

  const lo = document.createElement('span');
  lo.textContent = minLabel;

  const ramp = document.createElement('span');
  ramp.className = 'ramp';
  for (const token of RAMP) {
    const swatch = document.createElement('i');
    swatch.style.background = `var(${token})`;
    ramp.appendChild(swatch);
  }

  const hi = document.createElement('span');
  hi.textContent = maxLabel;

  wrap.append(lo, ramp, hi);
  mount.appendChild(wrap);
}

/* -------------------------------------------------------- small multiples */

/**
 * One mini line chart per offer. Small multiples rather than four overlaid
 * series: four categorical hues would put yellow beside orange, and the shapes
 * are easier to compare side by side anyway.
 */
export function sparkline(mount, points, { threshold, domain, formatPoint } = {}) {
  clearMount(mount);

  const W = 220;
  const H = 96;
  const padX = 16;
  const padY = 14;

  const values = points.map((p) => p.value).filter((v) => v !== null);
  if (!values.length) return;

  // The caller supplies one domain shared by every panel. Letting each panel
  // scale to its own values would make four different vertical scales look
  // directly comparable, which is the classic small-multiples failure.
  //
  // The threshold is deliberately NOT folded into the domain: when every offer
  // sits far below 30%, including it flattens the lines into the bottom of the
  // plot and hides the vesting shape these panels exist to show.
  const [lo, hi] = domain ?? [Math.min(...values) * 0.92, Math.max(...values) * 1.08];

  const x = (i) => padX + (i / Math.max(1, points.length - 1)) * (W - padX * 2);
  const y = (v) => H - padY - ((v - lo) / (hi - lo || 1)) * (H - padY * 2);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });

  if (threshold !== undefined && threshold >= lo && threshold <= hi) {
    svg.appendChild(
      el('line', { x1: padX, y1: y(threshold), x2: W - padX, y2: y(threshold), class: 'threshold-line' }),
    );
  }

  svg.appendChild(
    el('path', {
      d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' '),
      class: 'spark-line',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  points.forEach((p, i) => {
    const g = el('g', { tabindex: '0' });
    // Ring in the surface color so overlapping marks stay separable.
    g.appendChild(el('circle', { cx: x(i), cy: y(p.value), r: 5.5, fill: 'var(--surface-1)' }));
    g.appendChild(el('circle', { cx: x(i), cy: y(p.value), r: 3.5, class: 'spark-dot' }));
    attachTooltip(g, formatPoint ? formatPoint(p) : `<div class="t-row">${pct(p.value, 1)}</div>`);
    svg.appendChild(g);
  });

  // Direct-label the endpoints only — never a number on every point.
  svg.appendChild(el('text', { x: padX, y: H - 2, class: 'axis-label' }, 'Y1'));
  svg.appendChild(
    el('text', { x: W - padX, y: H - 2, class: 'axis-label', 'text-anchor': 'end' }, `Y${points.length}`),
  );

  mount.appendChild(svg);
}

export { pct, money, attachTooltip };
