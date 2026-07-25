#!/usr/bin/env node
/**
 * Build the US state outlines the map draws, as pre-projected SVG paths.
 *
 * Runs at build time, not in the browser: the deployed site ships flat files and
 * loads no CDN, so the TopoJSON is decoded, projected through Albers USA and
 * flattened to path strings here. The committed `data/us-basemap.json` is then
 * the only thing the page needs, and it costs the browser no maths at all.
 *
 * Fails loudly on HTTP error, an unexpected topology, or a state going missing —
 * the same rule the rent ingest follows. A basemap that silently lost Texas
 * would render as a plausible-looking map with a hole in it.
 *
 *   node scripts/build-basemap.mjs
 */

import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { PANELS, ringsToPath, VIEW_WIDTH, VIEW_HEIGHT } from '../src/projection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'us-basemap.json');

const SOURCE = {
  name: 'us-atlas (US Census Bureau cartographic boundaries, 1:10m)',
  url: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
  homepage: 'https://github.com/topojson/us-atlas',
};

/**
 * The Census gazetteer supplies the official county name and its state.
 *
 * us-atlas carries a bare name — "King", "Orleans" — which is ambiguous and
 * reads oddly. The gazetteer has the full legal name, which matters because the
 * suffix is not always "County": Louisiana has parishes, Alaska has boroughs and
 * census areas, and Virginia has independent cities. Deriving the suffix from the
 * state would get all three wrong.
 *
 * It is also the authoritative FIPS-to-state mapping, so the basemap becomes the
 * single source of geographic truth for the whole project.
 */
const GAZETTEER = {
  name: 'US Census Bureau county gazetteer',
  url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_counties_national.zip',
};

/**
 * County-equivalents the boundary file still carries but the 2023 gazetteer has
 * retired. Named here rather than papered over, because each is a real
 * administrative change and silently falling back to a bare label would hide it.
 *
 *   Connecticut  replaced its eight counties with nine planning regions in 2022.
 *                The old counties remain the geography Zillow reports on, so the
 *                map keeps drawing them.
 *   Alaska       Valdez-Cordova Census Area was split into Chugach and Copper
 *                River in 2019.
 */
const RETIRED_GEOGRAPHIES = {
  '09001': { name: 'Fairfield County', st: 'CT' },
  '09003': { name: 'Hartford County', st: 'CT' },
  '09005': { name: 'Litchfield County', st: 'CT' },
  '09007': { name: 'Middlesex County', st: 'CT' },
  '09009': { name: 'New Haven County', st: 'CT' },
  '09011': { name: 'New London County', st: 'CT' },
  '09013': { name: 'Tolland County', st: 'CT' },
  '09015': { name: 'Windham County', st: 'CT' },
  '02261': { name: 'Valdez-Cordova Census Area', st: 'AK' },
};

/** Alaska and Hawaii are drawn as insets, so they get their own panel. */
const PANEL_BY_FIPS = { '02': 'alaska', '15': 'hawaii' };

/**
 * Territories are dropped. None of the 21 metros sits in one, and Albers USA has
 * no panel for them — they would land in the Pacific or be clipped away.
 */
const TERRITORIES = new Set(['60', '66', '69', '72', '78']);

/**
 * Islands smaller than this (in projected px^2) are dropped. At the map's drawn
 * size they are sub-pixel specks that cost bytes and render as dirt. The
 * threshold is deliberately low enough to keep every Hawaiian island and the
 * populated barrier islands.
 */
const MIN_RING_AREA = 0.6;

/**
 * Douglas-Peucker tolerance, in projected pixels.
 *
 * The map draws into a 960px-wide viewBox, so vertices that sit within a third
 * of a pixel of the line between their neighbours cannot be seen at any
 * realistic display size — they are pure payload. Dropping them roughly halves
 * the committed file.
 */
const SIMPLIFY_TOLERANCE = 0.35;

/* --------------------------------------------------------------- topojson */

/** Perpendicular distance from `p` to the segment `a`-`b`. */
function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;

  // Degenerate segment: fall back to point-to-point.
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker line simplification, iterative to stay safe on long coastlines
 * where a recursive implementation can blow the stack.
 */
function simplify(points, tolerance) {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = 0;
    let index = 0;

    for (let i = first + 1; i < last; i++) {
      const distance = pointSegmentDistance(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }

    if (maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Decode TopoJSON's delta-encoded, quantised arcs back into coordinates.
 *
 * TopoJSON stores each arc as a starting point followed by successive deltas in
 * integer quantised space; `transform` scales them back to lon/lat.
 */
function decodeArcs(topology) {
  const { scale: [sx, sy], translate: [tx, ty] } = topology.transform;

  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/**
 * Stitch a ring's arc references into one coordinate list.
 *
 * A negative index means "traverse this arc backwards"; the shared endpoint is
 * dropped so the seam between two arcs is not a duplicated vertex.
 */
function ringCoordinates(arcIndices, arcs) {
  const out = [];

  for (const index of arcIndices) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    out.push(...(out.length ? arc.slice(1) : arc));
  }
  return out;
}

/** Rings of a Polygon or MultiPolygon geometry, as arc-index arrays. */
function geometryRings(geometry) {
  if (geometry.type === 'Polygon') return geometry.arcs;
  if (geometry.type === 'MultiPolygon') return geometry.arcs.flat();
  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}

/** Absolute area of a projected ring, via the shoelace formula. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/* ------------------------------------------------------------------- main */

async function fetchTopology() {
  // A local copy short-circuits the network, so a rebuild during development
  // does not depend on jsdelivr being reachable.
  const cached = process.env.BASEMAP_CACHE;
  if (cached) {
    console.log(`  using cached topology: ${cached}`);
    return JSON.parse(await readFile(cached, 'utf8'));
  }

  console.log(`  fetching ${SOURCE.url}`);
  const res = await fetch(SOURCE.url);
  if (!res.ok) throw new Error(`${SOURCE.url} returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Project and flatten one TopoJSON geometry to an SVG path.
 *
 * @returns {{ d: string, before: number, after: number, dropped: number }}
 */
function buildPath(geometry, arcs, panel, tolerance, minArea) {
  const ringsIn = geometryRings(geometry).map((indices) => ringCoordinates(indices, arcs));
  const before = ringsIn.reduce((n, r) => n + r.length, 0);

  const allRings = ringsIn.map((ring) => ring.map((c) => panel(c)));

  let dropped = 0;
  let kept = allRings.filter((ring) => {
    if (ringArea(ring) >= minArea) return true;
    dropped++;
    return false;
  });

  // Some county-equivalents really are smaller than the threshold — Virginia has
  // 38 independent cities, and Emporia covers seven square miles. Dropping them
  // would punch holes in the map, so the largest ring always survives.
  if (!kept.length && allRings.length) {
    kept = [allRings.reduce((a, b) => (ringArea(a) >= ringArea(b) ? a : b))];
    dropped -= 1;
  }

  const projected = kept
    // Simplify after projecting, so the tolerance is in the pixels the reader
    // actually sees rather than in degrees, which vary in size with latitude.
    .map((ring) => simplify(ring, tolerance));

  return {
    d: ringsToPath(projected),
    rings: projected.length,
    before,
    after: projected.reduce((n, r) => n + r.length, 0),
    dropped,
  };
}

/**
 * Read the gazetteer, which ships as a single tab-separated file inside a zip.
 *
 * Unzipped with the system `unzip` rather than a dependency — this is a
 * build-time script and the deployed site has no dependencies to spend.
 */
async function fetchGazetteer() {
  const cached = process.env.GAZETTEER_CACHE;
  let text;

  if (cached) {
    console.log(`  using cached gazetteer: ${cached}`);
    text = await readFile(cached, 'utf8');
  } else {
    console.log(`  fetching ${GAZETTEER.url}`);
    const res = await fetch(GAZETTEER.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${GAZETTEER.url} returned HTTP ${res.status}`);

    const tmp = join(tmpdir(), `gaz-${process.pid}`);
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'gaz.zip'), Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-o', '-q', 'gaz.zip'], { cwd: tmp });

    const [file] = (await readdir(tmp)).filter((f) => f.endsWith('.txt'));
    if (!file) throw new Error('no .txt file inside the gazetteer archive');
    text = await readFile(join(tmp, file), 'utf8');
    await rm(tmp, { recursive: true, force: true });
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split('\t').map((h) => h.trim());
  const iUsps = header.indexOf('USPS');
  const iGeoid = header.indexOf('GEOID');
  const iName = header.indexOf('NAME');

  if (iUsps < 0 || iGeoid < 0 || iName < 0) {
    throw new Error(`unexpected gazetteer columns: ${header.join(', ')}`);
  }

  const byFips = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    byFips.set(cells[iGeoid].trim(), {
      name: cells[iName].trim(),
      st: cells[iUsps].trim(),
    });
  }
  return byFips;
}

async function main() {
  const topology = await fetchTopology();
  const gazetteer = await fetchGazetteer();

  if (topology.type !== 'Topology' || !topology.objects?.counties || !topology.objects?.states) {
    throw new Error('Unexpected topology: expected objects.counties and objects.states');
  }

  const arcs = decodeArcs(topology);

  const vertexCount = { before: 0, after: 0 };
  let droppedRings = 0;

  /* ---- counties: the data layer ---- */

  const counties = [];
  for (const geometry of topology.objects.counties.geometries) {
    const fips = String(geometry.id).padStart(5, '0');
    if (TERRITORIES.has(fips.slice(0, 2))) continue;

    const panel = PANELS[PANEL_BY_FIPS[fips.slice(0, 2)] ?? 'lower48'];
    const built = buildPath(geometry, arcs, panel, SIMPLIFY_TOLERANCE, MIN_RING_AREA);

    vertexCount.before += built.before;
    vertexCount.after += built.after;
    droppedRings += built.dropped;

    // A county reduced to nothing is a bug, not a small county — every US county
    // is far larger than the ring threshold at this scale.
    if (!built.rings) {
      throw new Error(`${geometry.properties.name} (${fips}) has no rings left after filtering`);
    }

    // Prefer the gazetteer's official name and state; fall back to us-atlas so a
    // county is never dropped for want of a label.
    const gaz = gazetteer.get(fips) ?? RETIRED_GEOGRAPHIES[fips];
    counties.push({
      id: fips,
      name: gaz?.name ?? geometry.properties.name,
      st: gaz?.st ?? null,
      d: built.d,
    });
  }

  if (counties.length < 3100 || counties.length > 3200) {
    throw new Error(`Expected roughly 3,143 counties, built ${counties.length}`);
  }

  const unnamed = counties.filter((c) => !c.st);
  if (unnamed.length) {
    throw new Error(
      `${unnamed.length} counties missing from the gazetteer, e.g. ` +
        unnamed.slice(0, 5).map((c) => `${c.id} ${c.name}`).join(', '),
    );
  }

  /* ---- states: drawn only as boundary lines over the counties ---- */

  const states = [];
  for (const geometry of topology.objects.states.geometries) {
    const fips = String(geometry.id).padStart(2, '0');
    if (TERRITORIES.has(fips)) continue;

    const panel = PANELS[PANEL_BY_FIPS[fips] ?? 'lower48'];
    // State outlines are a stroked overlay, so they can carry a coarser
    // tolerance than the county fills without any visible difference.
    const built = buildPath(geometry, arcs, panel, SIMPLIFY_TOLERANCE * 1.6, MIN_RING_AREA * 2);

    states.push({ id: fips, name: geometry.properties.name, d: built.d });
  }

  if (states.length !== 51) throw new Error(`Expected 51 states + DC, built ${states.length}`);

  const payload = {
    source: SOURCE,
    projection: 'Albers USA (equal-area), scale 1070, translate [480, 250]',
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    countyCount: counties.length,
    stateCount: states.length,
    counties: counties.sort((a, b) => a.id.localeCompare(b.id)),
    states: states.sort((a, b) => a.id.localeCompare(b.id)),
  };

  const json = `${JSON.stringify(payload, null, 0)}\n`;
  await writeFile(OUT, json);

  const kept = ((vertexCount.after / vertexCount.before) * 100).toFixed(0);

  console.log(`  counties    : ${counties.length} (${counties.length - unnamed.length} named from the gazetteer)`);
  console.log(`  states      : ${states.length}`);
  console.log(`  tiny rings  : ${droppedRings} dropped (< ${MIN_RING_AREA}px²)`);
  console.log(`  vertices    : ${vertexCount.before} -> ${vertexCount.after} (${kept}% kept)`);
  console.log(`  wrote       : data/us-basemap.json (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(`\nbuild-basemap failed: ${err.message}`);
  process.exit(1);
});
