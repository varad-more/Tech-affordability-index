/**
 * Albers USA — a composite equal-area projection of the United States.
 *
 * Why hand-rolled: the deployed site has zero runtime dependencies and loads no
 * CDN, so d3-geo is not available at runtime. The maths here is a direct
 * implementation of the standard Albers conic equal-area projection plus the
 * conventional Alaska/Hawaii insets, at the same constants d3-geo uses, so the
 * output is interchangeable with it. `test/projection.test.mjs` pins that claim
 * with fixtures generated from d3-geo itself.
 *
 * Equal-area matters here: the map compares metros, and a Mercator-style
 * projection would inflate the northern states enough to distort the comparison.
 *
 * Coordinates in, degrees [longitude, latitude]. Coordinates out, pixels in a
 * 960x600 viewBox.
 */

const RADIANS = Math.PI / 180;

export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 600;

const SCALE = 1070;
const TRANSLATE_X = 480;
const TRANSLATE_Y = 250;

/**
 * One Albers conic equal-area projection.
 *
 * `rotate` shifts the central meridian before projecting — for Alaska this is
 * what carries the Aleutians across the antimeridian without tearing the
 * outline in two.
 */
function conicEqualArea({ parallels, rotate, center, scale, translate }) {
  const [phi0, phi1] = parallels.map((d) => d * RADIANS);
  const sinPhi0 = Math.sin(phi0);
  const n = (sinPhi0 + Math.sin(phi1)) / 2;

  const c = 1 + sinPhi0 * (2 * n - sinPhi0);
  const r0 = Math.sqrt(c) / n;

  // Raw projection, operating in the rotated frame.
  const raw = (lambda, phi) => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    const theta = lambda * n;
    return [r * Math.sin(theta), r0 - r * Math.cos(theta)];
  };

  const deltaLambda = rotate[0] * RADIANS;

  // `center` is expressed in the rotated frame, and fixes which ground point
  // lands on `translate`.
  const [cx, cy] = raw(center[0] * RADIANS, center[1] * RADIANS);
  const dx = translate[0] - scale * cx;
  const dy = translate[1] + scale * cy;

  return ([lon, lat]) => {
    // Rotate longitude, wrapped back into [-180, 180] so the antimeridian is
    // continuous rather than a discontinuity in the middle of a polygon.
    let lambda = lon * RADIANS + deltaLambda;
    if (lambda > Math.PI) lambda -= 2 * Math.PI;
    else if (lambda < -Math.PI) lambda += 2 * Math.PI;

    const [px, py] = raw(lambda, lat * RADIANS);
    return [dx + scale * px, dy - scale * py];
  };
}

const lower48 = conicEqualArea({
  parallels: [29.5, 45.5],
  rotate: [96, 0],
  center: [-0.6, 38.7],
  scale: SCALE,
  translate: [TRANSLATE_X, TRANSLATE_Y],
});

const alaska = conicEqualArea({
  parallels: [55, 65],
  rotate: [154, 0],
  center: [-2, 58.5],
  // Alaska is drawn at roughly a third scale, the long-standing convention for
  // an inset that would otherwise dominate the plate.
  scale: SCALE * 0.35,
  translate: [TRANSLATE_X - 0.307 * SCALE, TRANSLATE_Y + 0.201 * SCALE],
});

const hawaii = conicEqualArea({
  parallels: [8, 18],
  rotate: [157, 0],
  center: [-3, 19.9],
  scale: SCALE,
  translate: [TRANSLATE_X - 0.205 * SCALE, TRANSLATE_Y + 0.212 * SCALE],
});

/**
 * The box each sub-projection is allowed to draw into. A point is assigned to
 * the first projection whose box it lands inside — the same dispatch d3-geo
 * uses, so Alaska and Hawaii cannot bleed over the lower 48.
 */
const EXTENTS = [
  { project: lower48, box: [-0.455, -0.238, 0.455, 0.238] },
  { project: alaska, box: [-0.425, 0.120, -0.214, 0.234] },
  { project: hawaii, box: [-0.214, 0.166, -0.115, 0.234] },
];

const inside = ([x, y], [x0, y0, x1, y1]) =>
  x >= TRANSLATE_X + x0 * SCALE &&
  x <= TRANSLATE_X + x1 * SCALE &&
  y >= TRANSLATE_Y + y0 * SCALE &&
  y <= TRANSLATE_Y + y1 * SCALE;

/**
 * Project one [lon, lat] pair.
 *
 * @returns {[number, number] | null} pixels, or null for a coordinate that
 *   falls outside every panel (mid-Pacific, say) — callers must handle null
 *   rather than silently plotting it at the origin.
 */
export function albersUsa(coordinates) {
  for (const { project, box } of EXTENTS) {
    const point = project(coordinates);
    if (inside(point, box)) return point;
  }
  return null;
}

/**
 * Project by named panel, bypassing the box test.
 *
 * Drawing a state outline needs this: dispatching *per vertex* would split a
 * polygon across panels wherever it strayed a pixel over a boundary. The
 * basemap builder picks one panel per state from its FIPS code and projects the
 * whole geometry with it.
 */
export const PANELS = { lower48, alaska, hawaii };

/** Round to `dp` decimals, dropping a trailing `.0` — keeps path data small. */
const round = (n, dp) => Number(n.toFixed(dp));

/**
 * Turn projected rings into an SVG path.
 *
 * @param {Array<Array<[number, number]>>} rings
 */
export function ringsToPath(rings, dp = 1) {
  return rings
    .map((ring) => {
      if (ring.length < 3) return '';
      const pts = ring.map(([x, y]) => `${round(x, dp)},${round(y, dp)}`);
      return `M${pts.join('L')}Z`;
    })
    .filter(Boolean)
    .join('');
}
