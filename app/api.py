"""
The JSON API the pages compute against.

Moving the maths to the server changed one thing about how this site behaves,
and it is worth naming rather than hiding: repainting the county map used to be
a synchronous loop in the browser and is now a request. The endpoints here are
shaped around that — :func:`county_map` returns one small integer per county in
a single response rather than making the client ask 3,142 times, because the
round trip is the cost now, not the arithmetic.
"""

import math
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from .affordability import affordability, burden_level
from .bands import assess, needs_share_step
from .datasets import CATEGORY_LABELS, CATEGORY_ORDER, data
from .state_rollup import roll_up_states
from .tax import total_tax
from .tax_data import LOCAL, STATES, TAX_YEAR, UNMODELLED_LOCAL_TAX

bp = Blueprint("api", __name__, url_prefix="/api")

#: The only two rent bases. Anything else is a client bug, and is rejected
#: rather than quietly defaulted — a silent fallback here would show ACS figures
#: under a ZORI label.
BASES = ("zori", "acs")


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
        taxYear=TAX_YEAR,
        bases=list(BASES),
        categoryOrder=list(CATEGORY_ORDER),
        categoryLabels=CATEGORY_LABELS,
        unmodelledLocalTax=UNMODELLED_LOCAL_TAX,
        modelledLocalTax={code: loc.name for code, loc in LOCAL.items()},
        states={code: state.name for code, state in STATES.items()},
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
    return jsonify(basis=_basis(), counties=data.priced_counties(_basis()))


@bp.get("/assess")
def assess_county():
    """The full picture for one salary in one county."""
    basis = _basis()
    fips = request.args.get("fips")
    if not fips:
        raise ValueError("fips is required")

    county = data.counties_by_fips.get(fips)
    if county is None:
        return jsonify(error="Unknown county: {}".format(fips)), 404

    rent = data.rent_for(fips, basis)
    non_housing = data.non_housing_for(fips)
    if rent is None or non_housing is None:
        # Deliberately not an error: "no figure is published for this county on
        # this basis" is a real answer, and the pages draw it as one.
        return jsonify(
            fips=fips,
            name=county.get("name"),
            state=county.get("st"),
            basis=basis,
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


@bp.get("/map")
def county_map():
    """One needs-share class per county, for the choropleth.

    The response is deliberately flat and short — a FIPS-to-step mapping and
    nothing else. The client already holds the geometry; sending anything more
    per county would make a salary change feel slower than it needs to.
    """
    basis = _basis()
    salary = _float_arg("salary", 156000.0)

    # Take-home depends only on the state, so it is computed 51 times rather
    # than once per county. That is the difference between this endpoint taking
    # milliseconds and taking seconds.
    net_by_state: Dict[str, float] = {}

    steps: Dict[str, Optional[int]] = {}
    for county in data.priced_counties(basis):
        state = county["state"]
        if state not in net_by_state:
            net_by_state[state] = total_tax(salary, state).net / 12
        monthly_net = net_by_state[state]
        share = county["needs"] / monthly_net if monthly_net > 0 else None
        steps[county["fips"]] = needs_share_step(share) if share is not None else 6

    return jsonify(basis=basis, salary=salary, steps=steps)


@bp.get("/states")
def states():
    """Per-state rollups: cheapest, median and dearest county, and the spread."""
    basis = _basis()
    rollups = roll_up_states(data.priced_counties(basis))

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
    return jsonify(basis=basis, states=out)


@bp.get("/rank")
def rank():
    """The reference offers against the tracked hubs, cheapest burden first."""
    profile_id = request.args.get("profile", "google-l3")
    profile = data.profile_by_id.get(profile_id)
    if profile is None:
        return jsonify(error="Unknown profile: {}".format(profile_id)), 404

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
                    {"year": y.year, "gross": y.gross, "ratio": y.ratio}
                    for y in result.years
                ],
            }
        )

    rows.sort(key=lambda row: row["baseRatio"] if row["baseRatio"] is not None else 9e9)
    return jsonify(profile=profile, rows=rows)


@bp.get("/timing/<fips>")
def timing(fips: str):
    """The rent-history and seasonal index for one county."""
    county = data.history_by_fips.get(fips)
    if county is None:
        return jsonify(error="No rent history for {}".format(fips)), 404
    return jsonify(
        county=county,
        firstMonth=data.rent_history["firstMonth"],
        lastMonth=data.rent_history["lastMonth"],
    )
