"""
The JSON API the pages compute against.

Moving the maths to the server changed one thing about how this site behaves,
and it is worth naming rather than hiding: what the browser used to compute in a
loop it now has to ask for. The endpoints are shaped around that — see
:func:`snapshot`, which hands over the whole page state in one response so that
rendering and hovering stay synchronous and only a salary change costs a round
trip.
"""

import math
from typing import Any, Dict, Optional

from flask import Blueprint, current_app, jsonify, request

from .affordability import (
    COST_BURDENED_THRESHOLD,
    SEVERELY_COST_BURDENED_THRESHOLD,
    affordability,
    burden_level,
)
from .bands import (
    BANDS,
    COMFORTABLE_SHARE,
    NEEDS_SHARE_BREAKS,
    NEEDS_SHARE_CLASSES,
    SURVIVAL_SHARE,
    assess,
    classify,
    needs_share_step,
    salary_bands,
)
from .datasets import CATEGORY_LABELS, CATEGORY_ORDER, data
from .seasonality import (
    MEANINGFUL_AMPLITUDE,
    MONTH_NAMES,
    MONTH_SHORT,
    seasonal_saving,
)
from .state_rollup import roll_up_state, roll_up_states
from .tax import total_tax
from .tax_data import (
    ADDITIONAL_MEDICARE_RATE,
    ADDITIONAL_MEDICARE_THRESHOLD,
    FEDERAL_BRACKETS,
    FEDERAL_STANDARD_DEDUCTION,
    LOCAL,
    MEDICARE_RATE,
    SOCIAL_SECURITY_RATE,
    SOCIAL_SECURITY_WAGE_BASE,
    STATES,
    TAX_YEAR,
    UNMODELLED_LOCAL_TAX,
)

bp = Blueprint("api", __name__, url_prefix="/api")

#: The only two rent bases. Anything else is a client bug, and is rejected
#: rather than quietly defaulted — a silent fallback here would show ACS figures
#: under a ZORI label.
BASES = ("zori", "acs")

#: The darkest class, used when take-home cannot cover necessities at all.
LAST_STEP = len(NEEDS_SHARE_BREAKS)


#: ACS bedroom breakouts the pages may ask for. ZORI has no bedroom split, so
#: the parameter is accepted and ignored there rather than rejected — the page
#: keeps its selection while you switch bases and back.
UNITS = ("all", "studio", "br1", "br2", "br3")


def _unit() -> str:
    unit = request.args.get("unit", "all")
    if unit not in UNITS:
        raise ValueError("Unknown unit size: {!r}".format(unit))
    return unit


def _basis() -> str:
    basis = request.args.get("basis", "zori")
    if basis not in BASES:
        raise ValueError("Unknown rent basis: {!r}".format(basis))
    return basis


def _float_arg(name: str, default: Optional[float] = None) -> Optional[float]:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise ValueError("{} must be a number, got {!r}".format(name, raw))


@bp.errorhandler(ValueError)
def _bad_request(error: ValueError):
    return jsonify(error=str(error)), 400


def _local_for(state: str, fips: str) -> Optional[str]:
    """Which modelled city tax applies, if any.

    Only two cities are modelled, and both are identified by county FIPS rather
    than by name: New York City spans five counties, and Philadelphia is exactly
    one. Guessing from a place name would be wrong for both.
    """
    if fips in {"36005", "36047", "36061", "36081", "36085"}:
        return "NYC"
    if fips == "42101":
        return "PHL"
    return None


def _camel(name: str) -> str:
    head, _, tail = name.partition("_")
    return head + "".join(part.title() for part in tail.split("_") if part)


def _as_json(value: Any) -> Any:
    """Render NamedTuples as camelCase objects, recursively.

    Python is snake_case and the client is camelCase, and the boundary is the
    only sane place to reconcile that. Doing it here rather than per-endpoint is
    what stops half a response arriving as ``getting_by`` and the other half as
    ``needsShare`` — which is exactly what happened before this existed.
    """
    if hasattr(value, "_asdict"):
        return {_camel(k): _as_json(v) for k, v in value._asdict().items()}
    if isinstance(value, dict):
        return {_camel(k) if isinstance(k, str) else k: _as_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_json(item) for item in value]
    if value == math.inf:
        # JSON has no infinity. The bands use it as "no upper bound", which is a
        # statement the client can act on; a literal Infinity token is not.
        return None
    return value


@bp.get("/meta")
def meta():
    """Everything the pages need to describe their own inputs."""
    return jsonify(
        siteOrigin=current_app.config['SITE_ORIGIN'],
        taxYear=TAX_YEAR,
        # The method page quotes these in prose, and prose is what goes stale.
        # Exposing them lets the browser suite check the page against the engine
        # rather than against a copy of the engine's numbers.
        federal={
            "standardDeduction": FEDERAL_STANDARD_DEDUCTION,
            "brackets": [{"from": b.lower, "rate": b.rate} for b in FEDERAL_BRACKETS],
        },
        fica={
            "socialSecurityRate": SOCIAL_SECURITY_RATE,
            "socialSecurityWageBase": SOCIAL_SECURITY_WAGE_BASE,
            "medicareRate": MEDICARE_RATE,
            "additionalMedicareRate": ADDITIONAL_MEDICARE_RATE,
            "additionalMedicareThreshold": ADDITIONAL_MEDICARE_THRESHOLD,
        },
        bases=list(BASES),
        categoryOrder=list(CATEGORY_ORDER),
        categoryLabels=CATEGORY_LABELS,
        # The band and class definitions are model, not presentation: the map's
        # class breaks and the verdict's thresholds have to be the same numbers,
        # and the only way to guarantee that is for both to come from here.
        bands=[_as_json(band) for band in BANDS],
        needsShareBreaks=list(NEEDS_SHARE_BREAKS),
        needsShareClasses=[_as_json(c) for c in NEEDS_SHARE_CLASSES],
        monthNames=list(MONTH_NAMES),
        monthShort=list(MONTH_SHORT),
        meaningfulAmplitude=MEANINGFUL_AMPLITUDE,
        survivalShare=SURVIVAL_SHARE,
        comfortableShare=COMFORTABLE_SHARE,
        costBurdenedThreshold=COST_BURDENED_THRESHOLD,
        severelyCostBurdenedThreshold=SEVERELY_COST_BURDENED_THRESHOLD,
        unmodelledLocalTax=UNMODELLED_LOCAL_TAX,
        modelledLocalTax={code: loc.name for code, loc in LOCAL.items()},
        # Shaped exactly like the tax-data.js export the pages used to import,
        # because they still read it that way: STATES[code].name, .brackets,
        # .standardDeduction, .payroll. Flattening it to {code: name} made every
        # state name on two pages render as "undefined" and the By-state tax
        # panel throw on a bracket table that was not there.
        #
        # `from` rather than `lower`: the field is named `lower` in Python only
        # because `from` is a keyword there. It is not a keyword in JavaScript,
        # and the client contract predates the port.
        states={
            code: {
                "name": state.name,
                "standardDeduction": state.standard_deduction,
                "brackets": [{"from": b.lower, "rate": b.rate} for b in state.brackets],
                "payroll": [
                    {"label": levy.label, "rate": levy.rate, "cap": levy.cap}
                    for levy in state.payroll
                ],
            }
            for code, state in STATES.items()
        },
        rents={
            "asOf": data.county_rents.get("asOf"),
            "fetchedAt": data.county_rents.get("fetchedAt"),
        },
        acs={"vintage": data.county_acs_rents.get("vintage")},
        counts={
            "counties": len(data.counties_by_fips),
            "zori": len(data.zori_by_fips),
            "acs": len(data.acs_by_fips),
        },
    )


@bp.get("/profiles")
def profiles():
    return jsonify(data.profiles)


@bp.get("/counties")
def counties():
    """Every county that can be assessed on the selected basis."""
    return jsonify(basis=_basis(), unit=_unit(), counties=data.priced_counties(_basis(), _unit()))


@bp.get("/assess")
def assess_county():
    """The full picture for one salary in one county."""
    basis = _basis()
    unit = _unit()
    fips = request.args.get("fips")
    if not fips:
        raise ValueError("fips is required")

    county = data.counties_by_fips.get(fips)
    if county is None:
        return jsonify(error="Unknown county: {}".format(fips)), 404

    rent = data.rent_for(fips, basis, unit)
    non_housing = data.non_housing_for(fips)
    if rent is None or non_housing is None:
        # Deliberately not an error: "no figure is published for this county on
        # this basis" is a real answer, and the pages draw it as one.
        return jsonify(
            fips=fips,
            name=county.get("name"),
            state=county.get("st"),
            basis=basis,
            unit=unit,
            available=False,
            missing="rent" if rent is None else "nonHousing",
        )

    state = county["st"]
    local = _local_for(state, fips)
    salary = _float_arg("salary", 156000.0)

    result = assess(salary, rent, non_housing, state, local)
    living_wage = data.living_wage_by_fips.get(fips, {})

    return jsonify(
        fips=fips,
        name=county.get("name"),
        state=state,
        basis=basis,
        unit=unit,
        available=True,
        local=local,
        salary=salary,
        rent=rent,
        nonHousingMonthly=non_housing,
        monthlyNeeds=result.monthly_needs,
        monthlyNet=result.monthly_net,
        monthlySurplus=result.monthly_surplus,
        needsShare=result.needs_share,
        needsShareStep=needs_share_step(result.needs_share),
        rentShare=result.rent_share,
        band=_as_json(result.band),
        bands=_as_json(result.bands),
        tax=_as_json(result.tax),
        breakdown=living_wage.get("e"),
        unmodelledLocalTax=UNMODELLED_LOCAL_TAX.get(state),
    )


@bp.get("/snapshot")
def snapshot():
    """Everything the pages need about every county, for one salary and basis.

    This is the endpoint the migration turns on. The map used to repaint from a
    synchronous loop over 3,142 counties, and hovering one read the same
    in-memory objects the fill came from. Neither can call the network — a fetch
    per hover would be unusable and a fetch per county unthinkable.

    So the whole page state arrives in one response and the client renders from
    it synchronously, exactly as before. Only changing the salary or the rent
    basis costs a round trip.

    Rows are positional rather than named — ``[step, needs, share, bandIndex]``
    — which is not premature: repeating four key names 1,351 times roughly
    tripled the payload, and this is fetched on every salary change.
    """
    basis = _basis()
    unit = _unit()
    salary = _float_arg("salary", 156000.0)

    band_ids = [band.id for band in BANDS]

    # Take-home depends on the tax jurisdiction, not the county, so it is
    # computed once per jurisdiction rather than 3,142 times. That is the
    # difference between this endpoint answering in milliseconds and in seconds.
    #
    # The key is (state, local) rather than state alone, which corrects
    # something the JavaScript got wrong: the map painted every county on
    # state-only tax while the tooltip over the same county included city tax,
    # so New York City read one way in the fill and another on hover. Six
    # counties are affected — the five boroughs and Philadelphia — and the
    # method page already says omitting those rates materially flatters them.
    net_by_jurisdiction: Dict[Any, float] = {}
    counties: Dict[str, Any] = {}
    band_counts: Dict[str, int] = {}

    for county in data.priced_counties(basis, unit):
        state = county["state"]
        local = _local_for(state, county["fips"])
        key = (state, local)
        if key not in net_by_jurisdiction:
            net_by_jurisdiction[key] = total_tax(salary, state, local).net / 12
        monthly_net = net_by_jurisdiction[key]

        needs = county["needs"]
        share = needs / monthly_net if monthly_net > 0 else None
        # A county whose take-home covers nothing still has to paint, and the
        # darkest class is the honest answer rather than a hole in the map.
        step = needs_share_step(share) if share is not None else LAST_STEP
        band = classify(monthly_net, needs)
        band_counts[band.id] = band_counts.get(band.id, 0) + 1

        counties[county["fips"]] = [
            step,
            needs,
            share,
            band_ids.index(band.id),
            monthly_net,
        ]

    net_by_state = {
        state: net for (state, local), net in net_by_jurisdiction.items() if local is None
    }

    return jsonify(
        basis=basis,
        unit=unit,
        salary=salary,
        netByState=net_by_state,
        bands=[_as_json(band) for band in BANDS],
        bandCounts=band_counts,
        counties=counties,
        withRent=len(counties),
    )


@bp.get("/states")
def states():
    """Per-state rollups: cheapest, median and dearest county, and the spread."""
    basis = _basis()
    unit = _unit()
    rollups = roll_up_states(data.priced_counties(basis, unit))

    out = {}
    for code, rollup in rollups.items():
        if rollup is None:
            continue
        out[code] = {
            "n": rollup.n,
            "median": rollup.median,
            "cheapest": rollup.cheapest,
            "dearest": rollup.dearest,
            # A state with one priced county has a spread of exactly 1.0, which
            # would read as "measured, and found to be one market". It has not
            # been measured. Checked rather than special-cased by name, because
            # which states are thin depends on the basis.
            "spread": rollup.spread if rollup.n > 1 else None,
        }
    return jsonify(basis=basis, unit=unit, states=out)


def _rank_rows(profile):
    rows = []
    for hub in data.rents["hubs"]:
        result = affordability(profile, hub["rent"], hub["state"], hub.get("local"))
        rows.append(
            {
                "hub": hub,
                "baseRatio": result.base_ratio,
                "baseMonthlyNet": result.base_monthly_net,
                "burden": burden_level(result.base_ratio),
                "years": [
                    {
                        "year": y.year,
                        "gross": y.gross,
                        "ratio": y.ratio,
                        "monthlyNet": y.monthly_net,
                    }
                    for y in result.years
                ],
            }
        )
    # A hub with no computable ratio sorts last rather than crashing the sort.
    rows.sort(key=lambda row: row["baseRatio"] if row["baseRatio"] is not None else 9e9)
    return rows


@bp.get("/state/<code>")
def state_detail(code: str):
    """Everything the By-state page needs about one state.

    The page asks four questions of the same state — where the median county
    sits, what the ladder there looks like, what the tax is, and what
    "comfortable" costs in every county inside it. Each is cheap; the last is a
    bisection per county, which is why they arrive together rather than as one
    request per chart.
    """
    basis = _basis()
    unit = _unit()
    salary = _float_arg("salary", 130000.0)

    code = code.upper()
    if code not in STATES:
        return jsonify(error="Unknown state: {}".format(code)), 404

    inside = [c for c in data.priced_counties(basis, unit) if c["state"] == code]
    if not inside:
        # A state can have counties on one basis and none on the other. That is
        # an answer, not an error — the page says so rather than drawing a blank.
        return jsonify(
            code=code, name=STATES[code].name, basis=basis, unit=unit, available=False
        )

    rollup = roll_up_state(inside)
    tax = total_tax(salary, code)
    monthly_net = tax.net / 12

    median = rollup.median
    ladder = salary_bands(
        median["rent"], median["nonHousingMonthly"], code
    )

    counties = []
    for county in inside:
        rung = salary_bands(county["rent"], county["nonHousingMonthly"], code)
        share = county["needs"] / monthly_net if monthly_net > 0 else None
        counties.append(
            {
                "fips": county["fips"],
                "name": county["name"],
                "rent": county["rent"],
                "nonHousingMonthly": county["nonHousingMonthly"],
                "needs": county["needs"],
                "comfortable": rung.comfortable,
                "needsShare": share,
                "step": needs_share_step(share) if share is not None else LAST_STEP,
            }
        )

    return jsonify(
        code=code,
        name=STATES[code].name,
        basis=basis,
        unit=unit,
        salary=salary,
        available=True,
        tax=_as_json(tax),
        monthlyNet=monthly_net,
        rollup={
            "n": rollup.n,
            "median": rollup.median,
            "cheapest": rollup.cheapest,
            "dearest": rollup.dearest,
            "spread": rollup.spread if rollup.n > 1 else None,
        },
        band=_as_json(classify(monthly_net, median["needs"])),
        bands=_as_json(ladder),
        counties=counties,
        unmodelledLocalTax=UNMODELLED_LOCAL_TAX.get(code),
    )


@bp.get("/rank")
def rank():
    """The reference offers against the tracked hubs, cheapest burden first.

    Without a profile this answers for all of them at once. The heatmap needs
    every offer against every hub — 7 x 21 — and asking seven times for what one
    response can carry would put six avoidable round trips in the way of the
    page settling.
    """
    profile_id = request.args.get("profile")

    if profile_id is None:
        return jsonify(
            profiles={
                profile["id"]: _rank_rows(profile)
                for profile in data.profiles["profiles"]
            },
            hubCount=len(data.rents["hubs"]),
        )

    profile = data.profile_by_id.get(profile_id)
    if profile is None:
        return jsonify(error="Unknown profile: {}".format(profile_id)), 404

    # The salary field on the page is editable, so the offer being ranked is
    # often a preset with one number changed. Overrides are applied on top of
    # the named preset rather than requiring the client to post a whole profile,
    # which keeps the vesting schedule and the equity haircut authoritative here
    # instead of being round-tripped through the browser where they could drift.
    overrides = {}
    for field in ("baseSalary", "rsuGrant", "equityHaircut"):
        value = _float_arg(field)
        if value is not None:
            overrides[field] = value

    # Only the first year's bonus is editable on the page; the later years stay
    # whatever the preset says, because a sign-on bonus is a year-one event and
    # copying it across four years would invent three payments nobody offered.
    bonus0 = _float_arg("bonus0")
    if bonus0 is not None:
        bonuses = list(profile.get("bonuses") or [])
        overrides["bonuses"] = [bonus0] + bonuses[1:] if bonuses else [bonus0]

    if overrides:
        profile = dict(profile, **overrides)

    return jsonify(profile=profile, rows=_rank_rows(profile))


@bp.get("/timing/<fips>")
def timing(fips: str):
    """The rent-history and seasonal index for one county.

    The saving is computed here rather than shipped as a formula, so the money
    the timing page quotes and the money the method page describes come from one
    implementation. ``rent`` defaults to the county's own latest observation.
    """
    county = data.history_by_fips.get(fips)
    if county is None:
        return jsonify(error="No rent history for {}".format(fips)), 404

    saving = None
    if county.get("season"):
        recent = [v for v in county["history"] if v is not None]
        rent = _float_arg("rent", recent[-1] if recent else None)
        if rent:
            saving = _as_json(seasonal_saving(county["season"], rent))

    return jsonify(
        county=county,
        saving=saving,
        firstMonth=data.rent_history["firstMonth"],
        lastMonth=data.rent_history["lastMonth"],
    )
