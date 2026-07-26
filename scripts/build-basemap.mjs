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
 * Project and simplify one arc, memoised across every geometry that uses it.
 *
 * Simplification has to happen per ARC, and never per assembled ring. Two
 * neighbouring counties share the arc that runs along their common border.
 * Simplify each finished ring instead and that one border gets approximated
 * twice, from different vertex neighbourhoods, so the two polygons stop
 * agreeing on where it runs. At 1x the disagreement is sub-pixel and invisible.
 * Zoom in and it opens into a white sliver between every pair of counties —
 * which is precisely the failure TopoJSON's shared-arc encoding exists to
 * prevent, thrown away at the last step.
 *
 * The cache is keyed by panel and tolerance as well as by index, because Alaska
 * and Hawaii project through their own panels and the state layer is simplified
 * more coarsely than the county layer.
 */
function projectedArc(index, arcs, panel, panelKey, tolerance, cache) {
  const key = `${panelKey}|${tolerance}|${index}`;
  let out = cache.get(key);
  if (!out) {
    out = simplify(arcs[index].map((c) => panel(c)), tolerance);
    cache.set(key, out);
  }
  return out;
}

/**
 * Stitch a ring's arc references into one projected, simplified coordinate list.
 *
 * A negative index means "traverse this arc backwards". The arc is always
 * simplified in its stored direction and the result reversed afterwards, so the
 * two polygons sharing it are guaranteed the identical vertex list rather than
 * merely a very similar one.
 *
 * The shared endpoint is dropped so the seam between two arcs is not a
 * duplicated vertex.
 */
function ringCoordinates(arcIndices, arcs, panel, panelKey, tolerance, cache) {
  const out = [];

  for (const index of arcIndices) {
    const forward = projectedArc(
      index < 0 ? ~index : index, arcs, panel, panelKey, tolerance, cache,
    );
    const arc = index < 0 ? [...forward].reverse() : forward;
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

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Bounding box of every drawn county, read back off the emitted path strings.
 *
 * Reading the paths rather than the ring arrays keeps this honest: it measures
 * exactly what ships, so a rounding or serialisation change cannot leave the
 * crop describing geometry that is no longer there.
 */
function countyBounds(counties) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const county of counties) {
    for (const pair of county.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
      const x = Number(pair[1]);
      const y = Number(pair[2]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
    throw new Error('Could not measure the drawn extent of the county layer');
  }
  return { minX, minY, maxX, maxY };
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
function buildPath(geometry, arcs, panel, panelKey, tolerance, minArea, cache) {
  const ringIndices = geometryRings(geometry);

  // Arcs are projected and simplified on the way in, so the tolerance is in the
  // pixels the reader actually sees rather than in degrees, which vary in size
  // with latitude.
  const allRings = ringIndices.map((indices) =>
    ringCoordinates(indices, arcs, panel, panelKey, tolerance, cache),
  );

  const before = ringIndices.reduce(
    (n, indices) => n + indices.reduce((m, i) => m + arcs[i < 0 ? ~i : i].length, 0),
    0,
  );

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

  // Fewer than three vertices is not a polygon. Simplifying per arc means a
  // shape small enough to sit inside the tolerance can collapse, and a collapsed
  // ring renders as nothing at all — a hole in the map rather than a small county.
  const degenerate = kept.filter((ring) => ring.length < 3).length;

  return {
    d: ringsToPath(kept),
    rings: kept.length,
    before,
    after: kept.reduce((n, r) => n + r.length, 0),
    dropped,
    degenerate,
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

  // Shared between the county and state passes: an arc projected once is an arc
  // that cannot disagree with itself later.
  const arcCache = new Map();

  const vertexCount = { before: 0, after: 0 };
  let droppedRings = 0;

  /* ---- counties: the data layer ---- */

  const counties = [];
  for (const geometry of topology.objects.counties.geometries) {
    const fips = String(geometry.id).padStart(5, '0');
    if (TERRITORIES.has(fips.slice(0, 2))) continue;

    const panelKey = PANEL_BY_FIPS[fips.slice(0, 2)] ?? 'lower48';
    const built = buildPath(
      geometry, arcs, PANELS[panelKey], panelKey, SIMPLIFY_TOLERANCE, MIN_RING_AREA, arcCache,
    );

    vertexCount.before += built.before;
    vertexCount.after += built.after;
    droppedRings += built.dropped;

    // A county reduced to nothing is a bug, not a small county — every US county
    // is far larger than the ring threshold at this scale.
    if (!built.rings) {
      throw new Error(`${geometry.properties.name} (${fips}) has no rings left after filtering`);
    }
    if (built.degenerate) {
      throw new Error(
        `${geometry.properties.name} (${fips}) collapsed to ${built.degenerate} ring(s) of ` +
          `fewer than 3 vertices — the simplify tolerance is too coarse for it`,
      );
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

    const panelKey = PANEL_BY_FIPS[fips] ?? 'lower48';
    // State outlines are a stroked overlay, so they can carry a coarser
    // tolerance than the county fills without any visible difference.
    const built = buildPath(
      geometry, arcs, PANELS[panelKey], panelKey,
      SIMPLIFY_TOLERANCE * 1.6, MIN_RING_AREA * 2, arcCache,
    );

    states.push({ id: fips, name: geometry.properties.name, d: built.d });
  }

  if (states.length !== 51) throw new Error(`Expected 51 states + DC, built ${states.length}`);

  // The projection's nominal 960x600 frame is generous: the drawn country leaves
  // roughly a fifth of it empty, mostly below Hawaii. Cropping to what was
  // actually drawn makes the map that much larger at every width for free, and
  // matters most on a phone where the whole frame is only a few hundred pixels.
  const bounds = countyBounds(counties);
  const pad = 4;
  const contentBox = [
    round2(bounds.minX - pad),
    round2(bounds.minY - pad),
    round2(bounds.maxX - bounds.minX + pad * 2),
    round2(bounds.maxY - bounds.minY + pad * 2),
  ];

  const payload = {
    source: SOURCE,
    projection: 'Albers USA (equal-area), scale 1070, translate [480, 250]',
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    contentBox: contentBox.join(' '),
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
