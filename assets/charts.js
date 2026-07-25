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
export function rankedBarChart(mount, rows, { threshold, thresholdLabel } = {}) {
  mount.replaceChildren();

  const W = 880;
  const gutterL = 116;
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
    'aria-label': 'Share of monthly take-home pay spent on rent, by metro, ranked lowest to highest',
  });

  // Gridlines every 10%, drawn behind the marks.
  for (let v = 0; v <= maxValue; v += 0.1) {
    const gx = gutterL + x(v);
    svg.appendChild(el('line', { x1: gx, y1: top - 8, x2: gx, y2: H - 16, class: 'tick-line' }));
    svg.appendChild(el('text', { x: gx, y: top - 14, class: 'axis-label', 'text-anchor': 'middle' }, pct(v)));
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
 * Heatmap — the named form for magnitude across a grid. Color is the ONLY
 * encoding here, so the ramp is sequential and every cell prints its value
 * (the relief rule for ramp steps that sit under 3:1 against the surface).
 */
export function heatmap(mount, { rowLabels, colLabels, cells }) {
  mount.replaceChildren();

  const gutterL = 116;
  const cellW = 150;
  const cellH = 26;
  const gap = 2;
  const top = 40;

  const W = gutterL + colLabels.length * (cellW + gap);
  const H = top + rowLabels.length * (cellH + gap) + 8;

  const flat = cells.flat().filter((c) => c?.value !== null && c?.value !== undefined).map((c) => c.value);
  const min = Math.min(...flat);
  const max = Math.max(...flat);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': 'Share of take-home pay spent on rent, by metro and offer',
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
      const g = el('g', { tabindex: '0' });

      const step =
        cell.value === null || cell.value === undefined ? null : rampStep(cell.value, min, max);

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
            pct(cell.value, 1),
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
  mount.replaceChildren();
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
export function sparkline(mount, points, { threshold, formatPoint } = {}) {
  mount.replaceChildren();

  const W = 220;
  const H = 96;
  const padX = 16;
  const padY = 14;

  const values = points.map((p) => p.value).filter((v) => v !== null);
  if (!values.length) return;

  const lo = Math.min(...values, threshold ?? Infinity) * 0.9;
  const hi = Math.max(...values, threshold ?? -Infinity) * 1.1;

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

export { pct, money };
