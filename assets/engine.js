/**
 * The computation engine, as seen from the browser.
 *
 * Every figure on this site is now computed in Python and fetched. That is the
 * whole point of the Flask migration, but it creates a problem this module
 * exists to solve: the pages render and hover synchronously, and the network is
 * not synchronous.
 *
 * The answer is that nothing here computes on demand. `refresh()` pulls the
 * entire page state for one salary and one rent basis in a single response, and
 * every accessor below reads that snapshot out of memory. Painting 3,142
 * counties and hovering one are both instant, exactly as they were; only moving
 * the salary or switching the basis touches the network.
 *
 * What is deliberately NOT here: any arithmetic on tax, bands or class breaks.
 * A `needsShareStep` reimplemented in JavaScript "just for the map" is how a map
 * and a verdict start disagreeing, and it would put the model back in two
 * languages — the exact thing the migration removed.
 */

/** Populated by `boot()`. Reading these before it resolves is a bug. */
export let META = null;

let snapshot = null;
let inFlight = null;

const json = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${url} returned ${res.status}`);
  }
  return res.json();
};

/**
 * Fetch the definitions the pages describe themselves with.
 *
 * These are model, not presentation — the map's class breaks and the verdict's
 * thresholds have to be the same numbers, so both come from the server rather
 * than one being retyped next to the other.
 */
export async function boot() {
  META = await json('/api/meta');
  return META;
}

/**
 * Load the page state for a salary and rent basis.
 *
 * Concurrent calls collapse onto one request. Dragging a salary control fires
 * change events faster than a round trip completes, and without this the map
 * would repaint from whichever response happened to land last rather than from
 * the one the reader is actually looking at.
 */
export async function refresh(salary, basis = 'zori', unit = 'all') {
  const url =
    `/api/snapshot?salary=${encodeURIComponent(salary)}&basis=${encodeURIComponent(basis)}` +
    `&unit=${encodeURIComponent(unit)}`;
  const request = json(url).then((data) => {
    // Only the newest request may install its result. An earlier one resolving
    // late must not overwrite a newer one that already landed.
    if (inFlight === request) {
      snapshot = data;
      inFlight = null;
    }
    return data;
  });
  inFlight = request;
  return request;
}

export const ready = () => snapshot !== null;

const row = (fips) => snapshot?.counties?.[fips] ?? null;

/** Which needs-share class a county falls in: 0 (easiest) to 6 (hardest). */
export const stepFor = (fips) => row(fips)?.[0] ?? null;

/** Monthly cost of everything a single adult needs there. */
export const needsFor = (fips) => row(fips)?.[1] ?? null;

/** Share of monthly take-home those needs consume. */
export const shareFor = (fips) => row(fips)?.[2] ?? null;

/** The verdict band for a county, as an object from `META.bands`. */
export function bandFor(fips) {
  const index = row(fips)?.[3];
  return index === undefined || index === null ? null : snapshot.bands[index];
}

/** Monthly take-home in a state, at the current salary. */
export const netFor = (stateCode) => snapshot?.netByState?.[stateCode] ?? null;

/** How many counties fell into each band, for the summary line. */
export const bandCounts = () => snapshot?.bandCounts ?? {};

/** How many counties carry a rent figure on the current basis. */
export const withRent = () => snapshot?.withRent ?? 0;

/** Every county priced on the current basis. */
export const pricedFips = () => Object.keys(snapshot?.counties ?? {});

/**
 * The full picture for one county: the salary ladder, the tax breakdown, and
 * the cost breakdown behind the needs figure.
 *
 * Separate from the snapshot because it is per-selection rather than
 * per-county, and carrying a ladder for 1,351 counties in every repaint would
 * cost far more than the one request a selection costs.
 */
export function assessCounty(fips, salary, basis = 'zori', unit = 'all') {
  return json(
    `/api/assess?fips=${encodeURIComponent(fips)}&salary=${encodeURIComponent(salary)}` +
      `&basis=${encodeURIComponent(basis)}&unit=${encodeURIComponent(unit)}`,
  );
}

/** Per-state rollups: cheapest, median and dearest county, and the spread. */
export function stateRollups(basis = 'zori', unit = 'all') {
  return json(
    `/api/states?basis=${encodeURIComponent(basis)}&unit=${encodeURIComponent(unit)}`,
  );
}

/**
 * Everything about one state: its rollup, ladder, tax, and what "comfortable"
 * costs in each of its counties.
 *
 * That last part is a bisection per county, which is why the By-state page asks
 * for it once per selection rather than once per row it draws.
 */
export function stateDetail(code, salary, basis = 'zori', unit = 'all') {
  return json(
    `/api/state/${encodeURIComponent(code)}?salary=${encodeURIComponent(salary)}` +
      `&basis=${encodeURIComponent(basis)}&unit=${encodeURIComponent(unit)}`,
  );
}

/**
 * Every sourced offer against every tracked hub, in one response.
 *
 * The heatmap needs 7 x 21 and the ranked bars need one row of it, so asking
 * per profile would put six avoidable round trips in front of the page settling.
 */
export function rankAll() {
  return json('/api/rank');
}

/**
 * One offer against the tracked hubs, cheapest burden first.
 *
 * `overrides` carries the four editable fields. They are applied server-side on
 * top of the named preset rather than posted as a whole profile, which keeps
 * the vesting schedule and the equity haircut authoritative there instead of
 * being round-tripped through the browser where they could drift.
 */
export function rank(profileId, overrides = {}) {
  const params = new URLSearchParams({ profile: profileId });
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== undefined) params.set(key, value);
  }
  return json(`/api/rank?${params}`);
}

/**
 * Rent history and seasonal index for one county.
 *
 * `rent` prices the seasonal swing in money. It defaults server-side to the
 * county's own latest observation, so passing it is an override rather than a
 * requirement.
 */
export function timing(fips, rent) {
  const query = rent ? `?rent=${encodeURIComponent(rent)}` : '';
  return json(`/api/timing/${encodeURIComponent(fips)}${query}`);
}
