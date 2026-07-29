/**
 * The computation engine, as seen from the browser.
 *
 * The site is published as static files, so no server computes anything while
 * someone is reading. That would normally mean reimplementing the tax engine
 * here — fifty states of bracket tables in a second language, drifting from the
 * first — which is precisely what the Python port existed to avoid.
 *
 * It is avoidable because of a property the tax code happens to have: every
 * component of the liability is *piecewise linear* in gross wages, and every
 * kink is a known constant. So Python publishes the curves as knot points (see
 * `app/net_curve.py`), and this module evaluates them by linear interpolation.
 * That is exact, not an approximation — between two adjacent knots the function
 * genuinely is a straight line.
 *
 * What that buys, concretely:
 *
 *   - No bracket, rate, deduction or threshold exists in JavaScript. Roll the
 *     tax year in `app/tax_data.py` and this file does not change.
 *   - Any salary works, not a rounded grid of them. A snapshot per salary would
 *     have meant either snapping input to $1,000 steps or shipping hundreds of
 *     megabytes.
 *   - Moving the salary costs no network at all. Under the API it cost 178 KB.
 *
 * What this file DOES hold is arithmetic with no judgement in it: interpolate,
 * divide, and compare against thresholds Python published. Every constant those
 * comparisons use — the class breaks, the band ceilings, the burden thresholds —
 * arrives in `META`. Where a threshold appears below it is read, never typed.
 *
 * `tests/test_derivation_parity.py` generates the expected answers from Python
 * and the browser suite asserts this module reproduces them, so the agreement
 * is demonstrated rather than reviewed.
 */

const bundleUrl = (name) => new URL(`../bundle/${name}.json`, import.meta.url);
const dataUrl = (name) => new URL(`../data/${name}`, import.meta.url);

/** Populated by `boot()`. Reading these before it resolves is a bug. */
export let META = null;

let places = null;
let snapshot = null;
let inFlight = null;

/**
 * Fetch and parse once per URL.
 *
 * Several of these files are also fetched by the page modules, and a couple are
 * megabyte-scale. Memoising on the URL keeps a second caller from re-parsing
 * what is already in memory, and collapses concurrent callers onto one request.
 */
const cache = new Map();
function json(url) {
  const key = String(url);
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(`${key} returned ${res.status}`);
        return res.json();
      }),
    );
  }
  return cache.get(key);
}

// --- curve evaluation ----------------------------------------------------
//
// These two mirror `interpolate` and `invert` in app/net_curve.py step for step,
// including the order of the arithmetic. Floating-point addition is not
// associative, so "the same formula" written in a different order agrees to the
// cent and disagrees in the last bit — and the last bit is what the parity tests
// check. Change one side, change the other.

/** Evaluate a published curve at any wage. */
function interpolate(curve, gross) {
  const { knots, values } = curve;
  if (gross <= knots[0]) return values[0];

  let lo = 0;
  let hi = knots.length - 1;
  if (gross >= knots[hi]) {
    // Past the sentinel knot the function is still affine, with the slope of
    // the final segment. Extrapolating along it is exact.
    lo = hi - 1;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid] <= gross) lo = mid;
      else hi = mid;
    }
  }

  const ga = knots[lo];
  const gb = knots[lo + 1];
  const va = values[lo];
  const vb = values[lo + 1];
  return va + ((gross - ga) * (vb - va)) / (gb - ga);
}

/** The wage at which a strictly increasing curve reaches `target`. */
function invert(curve, target) {
  const { knots, values } = curve;
  if (target <= values[0]) return knots[0];

  const last = values.length - 1;
  let lo;
  if (target >= values[last]) {
    lo = last - 1;
    if (values[last] <= values[lo]) return null;
  } else {
    lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (values[mid] <= target) lo = mid;
      else hi = mid;
    }
  }

  const va = values[lo];
  const vb = values[lo + 1];
  if (vb === va) return knots[lo];
  return knots[lo] + ((target - va) * (knots[lo + 1] - knots[lo])) / (vb - va);
}

/**
 * The full liability at one wage in one jurisdiction.
 *
 * Shaped exactly like the `TaxBreakdown` the pages already read, because they
 * itemise every line of it in the tax panel.
 */
export function liability(gross, stateCode, local = null) {
  const curves = META.curves;
  const jurisdiction = curves.states[stateCode];
  if (!jurisdiction) throw new Error(`Unknown state: ${stateCode}`);

  const federal = interpolate(curves.federal, gross);
  const fica = interpolate(curves.fica, gross);
  const stateIncome = interpolate(jurisdiction.income, gross);

  // No wage, no levies — matching app/tax.py, which returns an empty breakdown
  // rather than a list of zeroes. A row reading "State Disability Insurance $0"
  // is noise, not detail.
  const detail =
    gross > 0
      ? jurisdiction.payroll.map((levy) => ({
          label: levy.label,
          amount: interpolate(levy, gross),
        }))
      : [];

  let statePayroll = 0;
  for (const item of detail) statePayroll += item.amount;

  const localAmount = local ? interpolate(curves.local[local], gross) : 0;
  const total = federal + fica + (stateIncome + statePayroll) + localAmount;

  return {
    gross,
    federal,
    fica,
    stateIncome,
    statePayroll,
    statePayrollDetail: detail,
    local: localAmount,
    total,
    net: gross - total,
    effectiveRate: gross > 0 ? total / gross : 0,
  };
}

/**
 * Take-home against gross for one jurisdiction, built from the component curves.
 *
 * The knots are the union of every component's, because that is where the total
 * kinks. Built the same way Python builds it, from the same published numbers,
 * which is what lets both sides land on identical doubles rather than merely
 * close ones.
 */
const netCurves = new Map();
function netCurve(stateCode, local = null) {
  const key = local ? `${stateCode}:${local}` : stateCode;
  let curve = netCurves.get(key);
  if (curve) return curve;

  const curves = META.curves;
  const jurisdiction = curves.states[stateCode];
  const merged = new Set([...curves.federal.knots, ...curves.fica.knots, ...jurisdiction.income.knots]);
  for (const levy of jurisdiction.payroll) for (const k of levy.knots) merged.add(k);
  if (local) for (const k of curves.local[local].knots) merged.add(k);

  const knots = [...merged].sort((a, b) => a - b);
  curve = { knots, values: knots.map((k) => liability(k, stateCode, local).net) };
  netCurves.set(key, curve);
  return curve;
}

/** Smallest gross salary whose take-home reaches `targetAnnualNet`. */
export function grossForNet(targetAnnualNet, stateCode, local = null) {
  if (targetAnnualNet === null || !(targetAnnualNet > 0)) return 0;
  return invert(netCurve(stateCode, local), targetAnnualNet);
}

// --- model derivations ---------------------------------------------------
//
// Each of these is a comparison against a threshold Python published in META.
// None of them chooses a number.

/** Which needs-share class a share falls in: 0 (easiest) to 6 (hardest). */
export function needsShareStep(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return null;
  const breaks = META.needsShareBreaks;
  for (let i = 0; i < breaks.length; i += 1) if (share <= breaks[i]) return i;
  return breaks.length;
}

/** The darkest class, for a county whose take-home covers nothing at all. */
const lastStep = () => META.needsShareBreaks.length;

/** `maxNeedsShare` arrives as null for the open-ended band — JSON has no Infinity. */
const ceiling = (band) => (band.maxNeedsShare === null ? Infinity : band.maxNeedsShare);

/** Where a take-home figure lands on the ladder. Bands are ordered hardest first. */
export function classify(monthlyNet, needs) {
  const bands = META.bands;
  if (!(monthlyNet > 0)) return bands[0];
  const share = needs / monthlyNet;
  let match = bands[0];
  for (const band of bands) if (share <= ceiling(band)) match = band;
  return match;
}

/** The salary ladder for one place: what each named standard costs there. */
export function salaryBands(rent, nonHousingMonthly, stateCode, local = null) {
  const needs = rent + nonHousingMonthly;
  const at = (share) => grossForNet((needs * 12) / share, stateCode, local);
  return {
    rent,
    nonHousingMonthly,
    monthlyNeeds: needs,
    annualNeeds: needs * 12,
    survival: at(1.0),
    gettingBy: at(0.7),
    comfortable: at(0.5),
  };
}

/** Which modelled city tax applies in a county, if any. */
export const localFor = (fips) => META.localByFips[fips] ?? null;

// --- the relocation solve -------------------------------------------------
//
// "I earn this here; what is the same life worth there?" needs no tax code of
// its own — it is `salaryBands` solved at the share you already have rather than
// at one of the three named standards. Mirrors app/bands.py:equivalent_salary
// operation for operation, for the reason given above `interpolate`.
//
// Split into two halves so the map cannot disagree with the headline. The origin
// is evaluated once and the destination once per county, which is what makes
// shading 3,000 counties cheap; more importantly it means the number under the
// cursor and the number in the verdict come from the same expression rather than
// from two that were written to match.

/** What the reader's life currently looks like, in monthly terms. */
function standing(salary, origin) {
  const monthlyNet = liability(salary, origin.state, origin.local).net / 12;
  const monthlyNeeds = origin.rent + origin.nonHousingMonthly;
  return {
    salary,
    monthlyNet,
    monthlyNeeds,
    // No take-home, no standard of living to hold constant.
    needsShare: monthlyNet > 0 ? monthlyNeeds / monthlyNet : null,
    monthlySurplus: monthlyNet - monthlyNeeds,
  };
}

/**
 * The two salaries that reproduce a standing somewhere else.
 *
 * `sameShare` keeps necessities at the same fraction of take-home and is the
 * headline, because it is what the rest of the site cuts on. `sameSurplus`
 * keeps the same dollars alive each month. They bracket the honest answer:
 * the first assumes discretionary spending scales with the destination, the
 * second that none of it does.
 */
function matchIn(here, destination) {
  const toMonthlyNeeds = destination.rent + destination.nonHousingMonthly;
  if (here.needsShare === null) return { toMonthlyNeeds, sameShare: null, sameSurplus: null };

  return {
    toMonthlyNeeds,
    sameShare: grossForNet(
      (toMonthlyNeeds * 12) / here.needsShare, destination.state, destination.local,
    ),
    // A destination cheap enough that even earning nothing there beats being
    // short here lands on a non-positive target, and `grossForNet` answers 0.
    // That is the right answer, not an edge case: no salary is required.
    sameSurplus: grossForNet(
      (here.monthlySurplus + toMonthlyNeeds) * 12, destination.state, destination.local,
    ),
  };
}

/** What `salary` in `origin` is worth in `destination`. Places are
 *  `{rent, nonHousingMonthly, state, local}`. */
export function equivalentSalary(salary, origin, destination) {
  const here = standing(salary, origin);
  const there = matchIn(here, destination);
  return {
    salary,
    fromMonthlyNet: here.monthlyNet,
    fromMonthlyNeeds: here.monthlyNeeds,
    fromNeedsShare: here.needsShare,
    fromMonthlySurplus: here.monthlySurplus,
    ...there,
  };
}

// --- boot and page state -------------------------------------------------

/**
 * Fetch the definitions the pages describe themselves with, and the tax curves.
 *
 * These are model, not presentation — the map's class breaks and the verdict's
 * thresholds have to be the same numbers, so both come from here rather than one
 * being retyped next to the other.
 */
export async function boot() {
  const [meta, placeNames] = await Promise.all([json(bundleUrl('meta')), json(bundleUrl('places'))]);
  META = meta;
  places = placeNames;
  return META;
}

/** ZORI publishes no bedroom split, so on that basis one file serves every unit. */
const countiesFile = (basis, unit) => `counties-${basis}-${basis === 'zori' ? 'all' : unit}`;

/**
 * Load the page state for a salary and rent basis.
 *
 * Only the rent basis touches the network, and only the first time each is
 * asked for; the salary is applied to what is already in memory. Concurrent
 * calls collapse onto one request, so a salary dragged faster than a round trip
 * cannot repaint the map from a stale response.
 */
export async function refresh(salary, basis = 'zori', unit = 'all') {
  const request = json(bundleUrl(countiesFile(basis, unit))).then((file) => {
    const built = build(file, salary, basis, unit);
    if (inFlight === request) {
      snapshot = built;
      inFlight = null;
    }
    return built;
  });
  inFlight = request;
  return request;
}

/**
 * Turn a counties file plus a salary into everything the pages render from.
 *
 * Take-home is computed once per tax jurisdiction rather than once per county —
 * 53 evaluations instead of 3,142. The key is (state, local) rather than state
 * alone, which is what keeps the map and the tooltip agreeing over New York
 * City: painting the boroughs on state-only tax while the hover included city
 * tax is a bug this shape makes unrepresentable.
 */
function build(file, salary, basis, unit) {
  const bands = META.bands;
  const nets = new Map();
  const counties = {};
  const bandCounts = {};
  const netByState = {};

  for (const [fips, [rent, nonHousing]] of Object.entries(file.counties)) {
    const stateCode = places[fips]?.[1];
    const local = localFor(fips);
    const key = local ? `${stateCode}:${local}` : stateCode;

    let monthlyNet = nets.get(key);
    if (monthlyNet === undefined) {
      monthlyNet = liability(salary, stateCode, local).net / 12;
      nets.set(key, monthlyNet);
      if (!local) netByState[stateCode] = monthlyNet;
    }

    // IEEE 754 addition is correctly rounded, so this is the same double Python
    // computed — which is why the file ships the two parts rather than the sum.
    const needs = rent + nonHousing;
    const share = monthlyNet > 0 ? needs / monthlyNet : null;
    // A county whose take-home covers nothing still has to paint, and the
    // darkest class is the honest answer rather than a hole in the map.
    const step = share !== null ? needsShareStep(share) : lastStep();
    const band = classify(monthlyNet, needs);
    bandCounts[band.id] = (bandCounts[band.id] ?? 0) + 1;

    // Positional rows, and the same five fields in the same order the JSON API
    // used to send. The pages read `row[0]` and `row[3]` directly rather than
    // going through the accessors below, so this order is a published contract
    // and not an implementation detail.
    counties[fips] = [step, needs, share, bands.indexOf(band), monthlyNet];
  }

  return {
    basis, unit, salary,
    netByState,
    bands,
    bandCounts,
    counties,
    withRent: Object.keys(counties).length,
    states: file.states,
  };
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

// --- per-selection answers ------------------------------------------------
//
// These stayed asynchronous when the API went away. They no longer touch the
// network except on the first call for a dataset, but the pages already await
// them, and a facade that returns a promise is free to start needing one again.

/**
 * The full picture for one county: the salary ladder, the tax breakdown, and
 * the cost breakdown behind the needs figure.
 */
export async function assessCounty(fips, salary, basis = 'zori', unit = 'all') {
  const file = await json(bundleUrl(countiesFile(basis, unit)));

  const place = places[fips];
  if (!place) throw new Error(`Unknown county: ${fips}`);
  const [name, stateCode] = place;

  const priced = file.counties[fips];
  if (!priced) {
    // Deliberately not an error: "no figure is published for this county on
    // this basis" is a real answer, and the pages draw it as one. Which half is
    // missing is Python's call, published in the counties file, because a county
    // can be missing both and the two sentences are not interchangeable.
    return {
      fips, name, state: stateCode, basis, unit,
      available: false,
      missing: file.missingRent.includes(fips) ? 'rent' : 'nonHousing',
    };
  }

  const [rent, nonHousing] = priced;
  // Only needed for the cost-breakdown chart, so it is fetched here rather than
  // at boot — an unpriceable county never pays for it.
  const wage = await json(dataUrl('county-living-wage.json'));
  const local = localFor(fips);
  const tax = liability(salary, stateCode, local);
  const monthlyNet = tax.net / 12;
  const needs = rent + nonHousing;
  const share = monthlyNet > 0 ? needs / monthlyNet : null;

  return {
    fips, name, state: stateCode, basis, unit,
    available: true,
    local,
    salary,
    rent,
    nonHousingMonthly: nonHousing,
    monthlyNeeds: needs,
    monthlyNet,
    monthlySurplus: monthlyNet - needs,
    needsShare: share,
    needsShareStep: needsShareStep(share),
    rentShare: monthlyNet > 0 ? rent / monthlyNet : null,
    band: classify(monthlyNet, needs),
    bands: salaryBands(rent, nonHousing, stateCode, local),
    tax,
    breakdown: wage.counties.find((c) => c.fips === fips)?.e,
    unmodelledLocalTax: META.unmodelledLocalTax[stateCode],
  };
}

/** Per-state rollups: cheapest, median and dearest county, and the spread. */
export async function stateRollups(basis = 'zori', unit = 'all') {
  const file = await json(bundleUrl(countiesFile(basis, unit)));
  return { basis, unit, states: file.states };
}

/**
 * Everything about one state: its rollup, ladder, tax, and what "comfortable"
 * costs in each of its counties.
 */
export async function stateDetail(code, salary, basis = 'zori', unit = 'all') {
  const file = await json(bundleUrl(countiesFile(basis, unit)));
  code = code.toUpperCase();

  const state = META.states[code];
  if (!state) throw new Error(`Unknown state: ${code}`);

  const rollup = file.states[code];
  if (!rollup) {
    // A state can have counties on one basis and none on the other. That is an
    // answer, not an error — the page says so rather than drawing a blank.
    return { code, name: state.name, basis, unit, available: false };
  }

  const tax = liability(salary, code);
  const monthlyNet = tax.net / 12;
  const median = rollup.median;

  const counties = [];
  for (const [fips, [rent, nonHousing]] of Object.entries(file.counties)) {
    if (places[fips]?.[1] !== code) continue;
    const needs = rent + nonHousing;
    const share = monthlyNet > 0 ? needs / monthlyNet : null;
    counties.push({
      fips,
      name: places[fips][0],
      rent,
      nonHousingMonthly: nonHousing,
      needs,
      comfortable: salaryBands(rent, nonHousing, code).comfortable,
      needsShare: share,
      step: share !== null ? needsShareStep(share) : lastStep(),
    });
  }

  return {
    code,
    name: state.name,
    basis, unit, salary,
    available: true,
    tax,
    monthlyNet,
    rollup,
    band: classify(monthlyNet, median.needs),
    bands: salaryBands(median.rent, median.nonHousingMonthly, code),
    counties,
    unmodelledLocalTax: META.unmodelledLocalTax[code],
  };
}

/** A county assessment, in the shape the equivalence solve takes. */
const placeOf = (assessment) => ({
  rent: assessment.rent,
  nonHousingMonthly: assessment.nonHousingMonthly,
  state: assessment.state,
  local: assessment.local,
});

/**
 * Two counties, one salary, and what it would take to stay whole.
 *
 * Three assessments rather than two, because the middle one is the point. `from`
 * is where the reader is; `toAtSameSalary` is the naive move, keeping the same
 * number on the offer letter; `to` is the same county at the salary that
 * actually preserves their standing. The gap between the last two is the whole
 * argument the page is making.
 *
 * Built by calling `assessCounty` three times rather than by recomputing the
 * pieces, so a county reads identically here and on the Explore page.
 */
export async function comparePair(fromFips, toFips, salary, basis = 'zori', unit = 'all') {
  const [from, toAtSameSalary] = await Promise.all([
    assessCounty(fromFips, salary, basis, unit),
    assessCounty(toFips, salary, basis, unit),
  ]);

  // Either end unpriced on this basis means there is no comparison to draw. The
  // page says which end and why, so it stays an answer rather than a blank.
  if (!from.available || !toAtSameSalary.available) {
    return { basis, unit, salary, available: false, from, to: toAtSameSalary };
  }

  const equivalence = equivalentSalary(salary, placeOf(from), placeOf(toAtSameSalary));

  // Null only when the salary yields no take-home, so there is no standard of
  // living to carry across and nothing to assess at the other end.
  const to =
    equivalence.sameShare === null
      ? null
      : await assessCounty(toFips, equivalence.sameShare, basis, unit);

  return { basis, unit, salary, available: true, from, toAtSameSalary, to, equivalence };
}

/**
 * The same solve against every county in the country at once.
 *
 * The origin is evaluated once and only the destination varies, which is what
 * makes 3,000 answers cheap — and, more importantly, is why the map cannot
 * disagree with the headline: both go through `matchIn`, so a county shaded here
 * and named in the verdict is the same number, not two that were written to
 * match.
 *
 * Both readings are kept per county even though only one drives the shading, so
 * the tooltip can quote the pair without a second pass.
 */
export async function equivalentEverywhere(fromFips, salary, basis = 'zori', unit = 'all') {
  const file = await json(bundleUrl(countiesFile(basis, unit)));

  const priced = file.counties[fromFips];
  if (!priced) return { available: false, salary, basis, unit, salaries: {} };

  const [rent, nonHousing] = priced;
  const here = standing(salary, {
    rent,
    nonHousingMonthly: nonHousing,
    state: places[fromFips][1],
    local: localFor(fromFips),
  });

  const salaries = {};
  if (here.needsShare !== null) {
    for (const [fips, [destRent, destNonHousing]] of Object.entries(file.counties)) {
      const { sameShare, sameSurplus } = matchIn(here, {
        rent: destRent,
        nonHousingMonthly: destNonHousing,
        state: places[fips][1],
        local: localFor(fips),
      });
      salaries[fips] = { sameShare, sameSurplus };
    }
  }

  return {
    available: here.needsShare !== null,
    salary, basis, unit,
    standing: here,
    salaries,
  };
}

// --- compensation profiles ------------------------------------------------

/** Gross wage income in one year of an offer. `year` is 0-indexed. */
function grossForYear(profile, year) {
  const vesting = profile.vesting ?? [];
  const bonuses = profile.bonuses ?? [];
  const vested = (vesting[year] ?? 0) * (profile.rsuGrant ?? 0) * (profile.equityHaircut ?? 1);
  return profile.baseSalary + (bonuses[year] ?? 0) + vested;
}

/**
 * An offer against one hub.
 *
 * The headline ratio uses BASE SALARY ONLY. Equity and bonuses appear beside it,
 * never folded in: a sign-on bonus is one lump in January and RSUs vest at a
 * price nobody can predict, so treating either as evenly-spendable monthly
 * income flatters the number exactly where a relocation decision can least
 * afford flattery.
 */
function affordability(profile, rent, stateCode, local = null) {
  // An offer that nets nothing cannot cover any rent; report that rather than
  // dividing by zero and rendering an infinity into a chart.
  const ratio = (monthlyNet) => (monthlyNet > 0 ? rent / monthlyNet : null);

  const baseTax = liability(profile.baseSalary, stateCode, local);
  const baseMonthlyNet = baseTax.net / 12;
  const yearCount = Math.max((profile.vesting ?? []).length, (profile.bonuses ?? []).length, 1);

  const years = [];
  for (let y = 0; y < yearCount; y += 1) {
    const gross = grossForYear(profile, y);
    const monthlyNet = liability(gross, stateCode, local).net / 12;
    years.push({ year: y + 1, gross, monthlyNet, ratio: ratio(monthlyNet) });
  }

  return { baseRatio: ratio(baseMonthlyNet), baseMonthlyNet, baseTax, years };
}

/** Classify a rent burden against the HUD thresholds published in META. */
function burdenLevel(ratio) {
  if (ratio === null || ratio === undefined) return 'unknown';
  if (ratio >= META.severelyCostBurdenedThreshold) return 'severe';
  if (ratio >= META.costBurdenedThreshold) return 'burdened';
  return 'ok';
}

function rankRows(profile, hubs) {
  const rows = hubs.map((hub) => {
    const result = affordability(profile, hub.rent, hub.state, hub.local ?? null);
    return {
      hub,
      baseRatio: result.baseRatio,
      baseMonthlyNet: result.baseMonthlyNet,
      burden: burdenLevel(result.baseRatio),
      years: result.years,
    };
  });
  // A hub with no computable ratio sorts last rather than crashing the sort.
  rows.sort((a, b) => (a.baseRatio ?? 9e9) - (b.baseRatio ?? 9e9));
  return rows;
}

const offers = () =>
  Promise.all([json(dataUrl('profiles.json')), json(dataUrl('rents.json'))]);

/** Every sourced offer against every tracked hub, in one pass. */
export async function rankAll() {
  const [profiles, rents] = await offers();
  return {
    profiles: Object.fromEntries(
      profiles.profiles.map((p) => [p.id, rankRows(p, rents.hubs)]),
    ),
    hubCount: rents.hubs.length,
  };
}

/**
 * One offer against the tracked hubs, cheapest burden first.
 *
 * `overrides` carries the editable fields, applied on top of the named preset
 * rather than replacing it, which keeps the vesting schedule and equity haircut
 * authoritative in `data/profiles.json` instead of drifting.
 */
export async function rank(profileId, overrides = {}) {
  const [profiles, rents] = await offers();
  const preset = profiles.profiles.find((p) => p.id === profileId);
  if (!preset) throw new Error(`Unknown profile: ${profileId}`);

  const profile = { ...preset };
  for (const field of ['baseSalary', 'rsuGrant', 'equityHaircut']) {
    if (overrides[field] !== null && overrides[field] !== undefined) {
      profile[field] = Number(overrides[field]);
    }
  }
  // Only the first year's bonus is editable: a sign-on bonus is a year-one
  // event, and copying it across four years would invent three payments nobody
  // offered.
  if (overrides.bonus0 !== null && overrides.bonus0 !== undefined) {
    const bonuses = preset.bonuses ?? [];
    profile.bonuses = [Number(overrides.bonus0), ...bonuses.slice(1)];
  }

  return { profile, rows: rankRows(profile, rents.hubs) };
}

/**
 * Rent history and seasonal index for one county.
 *
 * The saving is precomputed in Python at each county's own latest observation,
 * so the money this page quotes and the money the method page describes come
 * from one implementation.
 */
export async function timing(fips) {
  const file = await json(bundleUrl('timing'));
  return {
    saving: file.savings[fips] ?? null,
    firstMonth: file.firstMonth,
    lastMonth: file.lastMonth,
  };
}
