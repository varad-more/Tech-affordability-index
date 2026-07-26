"""
Affordability = the share of one month's take-home pay that rent consumes.

The headline ratio deliberately uses BASE SALARY ONLY. Equity and bonuses are
shown alongside it, never folded silently into the headline: a sign-on bonus is
one lump in January, and RSUs vest quarterly at a price nobody can predict, so
treating either as evenly-spendable monthly income flatters the number exactly
where a relocation decision can least afford flattery.

Profiles arrive as dicts straight from ``data/profiles.json``, so their keys stay
camelCase — they are external data being read, not Python being written.
"""

import math
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from .tax import TaxBreakdown, total_tax

#: HUD's long-standing definition of "cost-burdened": more than 30% of income
#: spent on housing. Anchors the charts with a real threshold, not an arbitrary
#: one.
COST_BURDENED_THRESHOLD = 0.30
SEVERELY_COST_BURDENED_THRESHOLD = 0.50


class YearResult(NamedTuple):
    year: int
    gross: float
    tax: TaxBreakdown
    monthly_net: float
    ratio: Optional[float]


class Affordability(NamedTuple):
    rent: float
    state: str
    local: Optional[str]
    #: Headline: rent against take-home from base salary alone.
    base_ratio: Optional[float]
    base_monthly_net: float
    base_tax: TaxBreakdown
    #: The same ratio once equity and bonuses are counted, year by year.
    years: List[YearResult]
    total_ratio_y1: Optional[float]


def gross_for_year(profile: Dict[str, Any], year: int) -> float:
    """Gross wage income in a given year of the offer. ``year`` is 0-indexed."""
    vesting: Sequence[float] = profile.get("vesting") or []
    bonuses: Sequence[float] = profile.get("bonuses") or []

    vested_fraction = vesting[year] if year < len(vesting) else 0
    vested = vested_fraction * profile.get("rsuGrant", 0) * profile.get("equityHaircut", 1)
    bonus = bonuses[year] if year < len(bonuses) else 0

    return profile["baseSalary"] + bonus + vested


def _ratio(monthly_rent: float, monthly_net: float) -> Optional[float]:
    # An offer that nets nothing monthly cannot cover any rent; report it as
    # such rather than dividing by zero and rendering an infinity into a chart.
    if not (monthly_net > 0):
        return None
    return monthly_rent / monthly_net


def affordability(
    profile: Dict[str, Any], rent: float, state: str, local: Optional[str] = None
) -> Affordability:
    """Affordability for one compensation profile in one location."""
    base_tax = total_tax(profile["baseSalary"], state, local)
    base_monthly_net = base_tax.net / 12

    year_count = max(
        len(profile.get("vesting") or []), len(profile.get("bonuses") or []), 1
    )

    years = []
    for y in range(year_count):
        gross = gross_for_year(profile, y)
        tax = total_tax(gross, state, local)
        monthly_net = tax.net / 12
        years.append(
            YearResult(
                year=y + 1,
                gross=gross,
                tax=tax,
                monthly_net=monthly_net,
                ratio=_ratio(rent, monthly_net),
            )
        )

    return Affordability(
        rent=rent,
        state=state,
        local=local,
        base_ratio=_ratio(rent, base_monthly_net),
        base_monthly_net=base_monthly_net,
        base_tax=base_tax,
        years=years,
        total_ratio_y1=years[0].ratio if years else None,
    )


def burden_level(ratio: Optional[float]) -> str:
    """Classify a ratio against the HUD thresholds."""
    if ratio is None:
        return "unknown"
    if ratio >= SEVERELY_COST_BURDENED_THRESHOLD:
        return "severe"
    if ratio >= COST_BURDENED_THRESHOLD:
        return "burdened"
    return "ok"


def rank_locations(
    profile: Dict[str, Any], locations: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Rank locations for a profile, cheapest rent burden first."""
    scored = [
        {
            "location": loc,
            "result": affordability(
                profile, loc["rent"], loc["state"], loc.get("local")
            ),
        }
        for loc in locations
    ]
    # A location with no computable ratio sorts last rather than crashing the
    # comparison, matching the Infinity the JavaScript used for the same job.
    return sorted(
        scored,
        key=lambda row: row["result"].base_ratio
        if row["result"].base_ratio is not None
        else math.inf,
    )
