/**
 * Counties, rolled up to states, without inventing a state-level number.
 *
 * The map page argues that shading a whole state is dishonest, and that is
 * still true: Texas holds both Loving County and Travis County, and no single
 * fill can stand for both. What is honest is to say which county sits in the
 * middle, name the two ends, and show how far apart they are. Every figure this
 * module produces therefore belongs to a real, named county rather than to an
 * average of places nobody lives.
 *
 * The median is over counties, unweighted, because no population figure ships
 * with this project. A state's median county is its 50th-most-expensive county,
 * not the county half its residents live below. Pages using this must say so.
 */

/**
 * The element at the 50th percentile of `list` by `valueOf`.
 *
 * Returns an actual element, never an interpolated midpoint between two, so the
 * caller can name it. With an even count this is the upper of the two middles,
 * which is the conventional choice when the answer has to be a real member.
 */
export function medianBy(list, valueOf) {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => valueOf(a) - valueOf(b));
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * @param {Array} counties every county in one state that has a rent figure on
 *   the basis currently selected. Each needs `{ needs }`, the monthly total.
 * @returns {{n: number, median: object, cheapest: object, dearest: object, spread: number}|null}
 */
export function rollUpState(counties) {
  if (counties.length === 0) return null;

  const sorted = [...counties].sort((a, b) => a.needs - b.needs);
  const cheapest = sorted[0];
  const dearest = sorted.at(-1);

  return {
    n: counties.length,
    median: sorted[Math.floor(sorted.length / 2)],
    cheapest,
    dearest,
    // How much dearer the dearest county is than the cheapest. This is the
    // number that says whether one figure for the state means anything: near 1
    // the state is uniform, at 2 the state is two different countries.
    spread: cheapest.needs > 0 ? dearest.needs / cheapest.needs : null,
  };
}

/**
 * @param {Array} counties every county with a rent figure, across all states
 * @returns {Map<string, object>} postal code to rollup, states with none omitted
 */
export function rollUpStates(counties) {
  const buckets = new Map();
  for (const county of counties) {
    const bucket = buckets.get(county.state);
    if (bucket) bucket.push(county);
    else buckets.set(county.state, [county]);
  }

  const out = new Map();
  for (const [code, list] of buckets) out.set(code, rollUpState(list));
  return out;
}
