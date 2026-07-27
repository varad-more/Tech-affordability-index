"""
Everything Python knows, in the form the browser reads it.

The site is served as static files, so there is no request-time Python. This
module is the whole boundary between the two languages: it computes every figure
that depends on the model, and emits it as JSON. :mod:`scripts.freeze` writes
those files at build time; :func:`app.create_app` serves the same functions live
in development. One producer, two transports — so a page cannot behave one way
locally and another once deployed.

The division of labour is deliberate and worth stating, because it is what keeps
the tax model in one language:

**Python decides.** Which counties can be priced at all, what a month of
necessities costs in each, where the class breaks and band ceilings fall, what
every state's rollup is, and — via :mod:`app.net_curve` — what tax is owed at any
wage in any jurisdiction.

**The browser only interpolates and compares.** Given a salary it reads
take-home off a curve this module published, divides, and compares the result
against thresholds this module published. It holds no bracket, no rate, no
deduction and no threshold of its own.

What is deliberately NOT precomputed is anything that varies with the salary
input, because that is continuous — a reader can type any number. Precomputing
it would mean either snapping salaries to a grid or shipping a file per salary,
and the curve makes both unnecessary.

The pages already fetch the raw datasets under ``data/`` for county names, map
geometry and the cost breakdowns, and they still do. This adds only what cannot
be derived without the tax engine.
"""

from typing import Any, Dict, List, Optional

from .affordability import COST_BURDENED_THRESHOLD, SEVERELY_COST_BURDENED_THRESHOLD
from .bands import (
    BANDS,
    COMFORTABLE_SHARE,
    NEEDS_SHARE_BREAKS,
    NEEDS_SHARE_CLASSES,
    SURVIVAL_SHARE,
)
from .datasets import CATEGORY_LABELS, CATEGORY_ORDER, data
from .net_curve import published as published_curves
from .seasonality import MEANINGFUL_AMPLITUDE, MONTH_NAMES, MONTH_SHORT, seasonal_saving
from .state_rollup import roll_up_states
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

#: The only two rent bases.
BASES = ("zori", "acs")

#: ACS bedroom breakouts. ZORI publishes no bedroom split, so on that basis the
#: selection is carried but never applied — the page keeps it while you switch
#: bases and back.
UNITS = ("all", "studio", "br1", "br2", "br3")

#: Which modelled city tax applies where, by county FIPS rather than by name.
#: New York City spans five counties and Philadelphia is exactly one; matching on
#: a place name would be wrong for both. Published so the browser can attribute a
#: county to its tax jurisdiction without knowing anything about tax.
LOCAL_BY_FIPS: Dict[str, str] = {
    "36005": "NYC",
    "36047": "NYC",
    "36061": "NYC",
    "36081": "NYC",
    "36085": "NYC",
    "42101": "PHL",
}


def local_for(fips: str) -> Optional[str]:
    return LOCAL_BY_FIPS.get(fips)


def _inf_to_none(value: float) -> Optional[float]:
    # JSON has no infinity. The open-ended band uses it to mean "no upper
    # bound", which is a statement the client can act on; a literal Infinity
    # token is not.
    return None if value == float("inf") else value


def meta(site_origin: Optional[str] = None) -> Dict[str, Any]:
    """Model constants and the tax curves — fetched once, at boot.

    Everything here is a definition rather than a measurement, which is why it
    can be one cacheable file. The class breaks the map paints with and the
    thresholds the verdict text quotes are the same numbers because both read
    them from here.

    ``site_origin`` is threaded in rather than read from config, because this
    module has to produce identical output whether it is called inside a request
    or by the freeze, where there is no application context to read.
    """
    return {
        "siteOrigin": site_origin,
        "taxYear": TAX_YEAR,
        "bases": list(BASES),
        "units": list(UNITS),
        "categoryOrder": list(CATEGORY_ORDER),
        "categoryLabels": CATEGORY_LABELS,
        "bands": [
            {
                "id": band.id,
                "label": band.label,
                "maxNeedsShare": _inf_to_none(band.max_needs_share),
                "description": band.description,
            }
            for band in BANDS
        ],
        "needsShareBreaks": list(NEEDS_SHARE_BREAKS),
        "needsShareClasses": [
            {"max": _inf_to_none(c.max), "label": c.label, "note": c.note}
            for c in NEEDS_SHARE_CLASSES
        ],
        "monthNames": list(MONTH_NAMES),
        "monthShort": list(MONTH_SHORT),
        "meaningfulAmplitude": MEANINGFUL_AMPLITUDE,
        "survivalShare": SURVIVAL_SHARE,
        "comfortableShare": COMFORTABLE_SHARE,
        "costBurdenedThreshold": COST_BURDENED_THRESHOLD,
        "severelyCostBurdenedThreshold": SEVERELY_COST_BURDENED_THRESHOLD,
        "unmodelledLocalTax": UNMODELLED_LOCAL_TAX,
        "modelledLocalTax": {code: loc.name for code, loc in LOCAL.items()},
        "localByFips": dict(LOCAL_BY_FIPS),
        # The method page quotes these in prose, and prose is what goes stale.
        # Publishing them lets the browser suite check the page against the
        # engine rather than against a copy of the engine's numbers.
        "federal": {
            "standardDeduction": FEDERAL_STANDARD_DEDUCTION,
            "brackets": [{"from": b.lower, "rate": b.rate} for b in FEDERAL_BRACKETS],
        },
        "fica": {
            "socialSecurityRate": SOCIAL_SECURITY_RATE,
            "socialSecurityWageBase": SOCIAL_SECURITY_WAGE_BASE,
            "medicareRate": MEDICARE_RATE,
            "additionalMedicareRate": ADDITIONAL_MEDICARE_RATE,
            "additionalMedicareThreshold": ADDITIONAL_MEDICARE_THRESHOLD,
        },
        # Shaped as the pages read it: STATES[code].name, .brackets,
        # .standardDeduction, .payroll. `from` rather than `lower` — the field is
        # only called `lower` in Python because `from` is a keyword there.
        #
        # These brackets are for the By-state tax panel to *display*. Nothing
        # computes from them: tax is evaluated from `curves` below.
        "states": {
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
        "rents": {
            "asOf": data.county_rents.get("asOf"),
            "fetchedAt": data.county_rents.get("fetchedAt"),
        },
        "acs": {"vintage": data.county_acs_rents.get("vintage")},
        "counts": {
            "counties": len(data.counties_by_fips),
            "zori": len(data.zori_by_fips),
            "acs": len(data.acs_by_fips),
        },
        "curves": published_curves(),
    }


def places() -> Dict[str, Any]:
    """Every county's name and state, keyed by FIPS.

    Split out from the per-basis files because it is the same on all of them,
    and split out from the basemap because the basemap is 742 KB of SVG path
    data. The engine needs to name a county long before it needs to draw one.
    """
    return {
        fips: [county.get("name"), county.get("st")]
        for fips, county in data.counties_by_fips.items()
    }


def counties(basis: str, unit: str = "all") -> Dict[str, Any]:
    """Every county priceable on one basis, and the per-state rollups.

    Rows are ``[rent, nonHousingMonthly]`` — positional because naming two keys
    three thousand times roughly triples the file, and this is the largest thing
    the page fetches.

    Monthly needs is their sum and is left to the browser to add rather than
    shipped as a third number. That is exact, not an approximation: IEEE 754
    addition is correctly rounded, so ``rent + nonHousing`` is the same double on
    both sides of the wire.

    Which counties appear is the whole point of publishing this rather than
    letting the browser filter for itself. A county needs both a rent figure on
    the selected basis and an MIT budget; missing either it cannot be assessed,
    and it is absent here rather than defaulted. The ACS bedroom fallback — where
    a suppressed size falls back to the all-bedroom median — is applied here too,
    so there is one implementation of it rather than one per language.
    """
    if basis not in BASES:
        raise ValueError("Unknown rent basis: {!r}".format(basis))
    if unit not in UNITS:
        raise ValueError("Unknown unit size: {!r}".format(unit))

    priced = data.priced_counties(basis, unit)
    priced_fips = {county["fips"] for county in priced}

    # Why a county cannot be assessed, kept as two lists rather than left for
    # the browser to infer. "No rent is published here" and "no budget is
    # published here" are different sentences on the page, and the counties that
    # fail each way differ by basis: Barbour County AL has an MIT budget Zillow
    # does not index, and Connecticut has Zillow rents under FIPS codes MIT does
    # not publish against. Inferring the reason from the absence would get the
    # precedence wrong for counties missing both.
    missing_rent = []
    missing_non_housing = []
    for fips in data.counties_by_fips:
        if fips in priced_fips:
            continue
        if data.rent_for(fips, basis, unit) is None:
            missing_rent.append(fips)
        else:
            missing_non_housing.append(fips)

    rollups = {}
    for code, rollup in roll_up_states(priced).items():
        if rollup is None:
            continue
        rollups[code] = {
            "n": rollup.n,
            "median": rollup.median,
            "cheapest": rollup.cheapest,
            "dearest": rollup.dearest,
            # A state with one priced county has a spread of exactly 1.0, which
            # would read as "measured, and found to be a single market". It has
            # not been measured. Checked rather than special-cased by name,
            # because which states are thin depends on the basis.
            "spread": rollup.spread if rollup.n > 1 else None,
        }

    return {
        "basis": basis,
        "unit": unit,
        "counties": {
            county["fips"]: [county["rent"], county["nonHousingMonthly"]]
            for county in priced
        },
        "states": rollups,
        "withRent": len(priced),
        "missingRent": missing_rent,
        "missingNonHousing": missing_non_housing,
    }


def timing() -> Dict[str, Any]:
    """What the seasonal swing is worth per county, in money.

    Priced at each county's own latest observation, which is the only rent the
    timing page ever asks about. Computed here so the money that page quotes and
    the money the method page describes come from one implementation.
    """
    savings = {}
    for fips, county in data.history_by_fips.items():
        season = county.get("season")
        if not season:
            continue
        observed = [v for v in county["history"] if v is not None]
        if not observed:
            continue
        saving = seasonal_saving(season, observed[-1])
        savings[fips] = {"monthly": saving.monthly, "annual": saving.annual}

    return {
        "firstMonth": data.rent_history["firstMonth"],
        "lastMonth": data.rent_history["lastMonth"],
        "savings": savings,
    }


#: Every file the static build emits, as ``name -> producer``. The freeze walks
#: this, and so does the development server, which is what keeps them identical.
def files(site_origin: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "meta": meta(site_origin),
        "places": places(),
        "timing": timing(),
    }
    for basis in BASES:
        # ZORI publishes no bedroom split, so every unit would produce a
        # byte-identical file. Emitting one and pointing the client at it beats
        # emitting five copies and hoping they stay in step.
        units = UNITS if basis == "acs" else ("all",)
        for unit in units:
            out["counties-{}-{}".format(basis, unit)] = counties(basis, unit)
    return out


def get(name: str, site_origin: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """One bundle file by name, for the development server."""
    if name == "meta":
        return meta(site_origin)
    if name == "places":
        return places()
    if name == "timing":
        return timing()
    if name.startswith("counties-"):
        parts = name.split("-")
        if len(parts) == 3:
            _, basis, unit = parts
            if basis in BASES and unit in UNITS:
                return counties(basis, "all" if basis == "zori" else unit)
    return None


def names() -> List[str]:
    return sorted(files(None))
