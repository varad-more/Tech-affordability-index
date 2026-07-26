"""
Salary bands — what a place actually costs, in dollars of gross salary.

The rest of this project answers a *relative* question: given an offer, where
does rent eat least? That ranks places against each other but never says whether
any of them is affordable. Two counties at an identical 28% rent burden are not
equally livable if one has materially higher transport and medical costs, and a
rent-share chart cannot see that difference.

So the model here is absolute. For each county::

    needs = rent + non-housing essentials       (monthly, after tax)

and the thresholds are the salaries at which that figure lands on a recognised
share of take-home pay. Each cut is a published standard rather than a number
chosen to look reasonable:

Survival
    needs = 100% of take-home. MIT's living wage is explicitly a subsistence
    budget — no savings, no travel, no dining out. Covering it exactly is the
    floor, not a target.
Getting by
    needs = 70% of take-home. The 70/20/10 budget, leaving 20% for savings and
    10% for debt or giving.
Comfortable
    needs = 50% of take-home. The 50/30/20 rule, leaving 30% discretionary and
    20% for savings.

Salaries are solved by inverting the tax engine numerically rather than
algebraically, so the bands stay correct for every state, bracket, payroll levy
and city tax automatically — including the kinks at the Social Security wage cap
and the Additional Medicare threshold, which have no closed form.
"""

import math
from typing import NamedTuple, Optional, Tuple

from .tax import TaxBreakdown, total_tax


class Band(NamedTuple):
    id: str
    label: str
    #: Upper bound on the share of take-home that essentials may consume.
    max_needs_share: float
    description: str


class NeedsShareClass(NamedTuple):
    max: float
    label: str
    note: Optional[str] = None


#: Ordered from hardest to easiest.
BANDS: Tuple[Band, ...] = (
    Band(
        "below-survival",
        "Below survival",
        # No upper bound on the share: essentials cost more than the paycheque.
        math.inf,
        "Essentials cost more than take-home pay.",
    ),
    Band(
        "survival",
        "Survival",
        1.0,
        "Covers necessities with nothing meaningful left over.",
    ),
    Band(
        "getting-by",
        "Getting by",
        0.7,
        "Necessities under 70% of take-home, with room to save.",
    ),
    Band(
        "comfortable",
        "Comfortable",
        0.5,
        "Necessities under half of take-home, the full 50/30/20 headroom.",
    ),
)

BAND_BY_ID = {band.id: band for band in BANDS}

#: The two thresholds the page leads with.
SURVIVAL_SHARE = 1.0
COMFORTABLE_SHARE = 0.5

#: Class breaks for the map, on "share of take-home consumed by necessities".
#:
#: Why the map does not simply paint the four bands: at an entry-level tech
#: salary more than nine counties in ten fall into "comfortable", so a four-class
#: map is one colour almost everywhere and the encoding carries nothing. The
#: underlying quantity is continuous and varies a great deal inside that band —
#: necessities take about a quarter of take-home in rural Ohio and about
#: two-thirds in the Bay Area — so the map shows the continuous quantity and uses
#: the band boundaries as class breaks.
#:
#: The upper three breaks are exactly the named standards (50%, 70%, 100%), so
#: the map and the verdict never disagree; the lower ones subdivide the crowded
#: comfortable end where the real variation lives.
NEEDS_SHARE_BREAKS: Tuple[float, ...] = (0.25, 0.32, 0.4, 0.5, 0.7, 1.0)

#: Legend copy for each class, lightest (easiest) to darkest.
NEEDS_SHARE_CLASSES: Tuple[NeedsShareClass, ...] = (
    NeedsShareClass(0.25, "under 25%"),
    NeedsShareClass(0.32, "25-32%"),
    NeedsShareClass(0.4, "32-40%"),
    NeedsShareClass(0.5, "40-50%"),
    NeedsShareClass(0.7, "50-70%", "past the 50/30/20 comfortable line"),
    NeedsShareClass(1.0, "70-100%", "past the 70/20/10 line, little left to save"),
    NeedsShareClass(math.inf, "over 100%", "necessities exceed take-home"),
)


class SalaryLadder(NamedTuple):
    rent: float
    non_housing_monthly: float
    monthly_needs: float
    annual_needs: float
    survival: Optional[float]
    getting_by: Optional[float]
    comfortable: Optional[float]


class Assessment(NamedTuple):
    gross: float
    tax: TaxBreakdown
    monthly_net: float
    monthly_needs: float
    #: Share of take-home consumed by essentials — what the bands cut on.
    needs_share: Optional[float]
    #: What is left after rent and essentials, each month.
    monthly_surplus: float
    rent_share: Optional[float]
    bands: SalaryLadder
    band: Band


def needs_share_step(share: Optional[float]) -> Optional[int]:
    """Which class a needs-share falls in: 0 (easiest) to 6 (hardest)."""
    if share is None or not math.isfinite(share):
        return None

    for i, break_at in enumerate(NEEDS_SHARE_BREAKS):
        if share <= break_at:
            return i
    return len(NEEDS_SHARE_BREAKS)


def monthly_needs(rent: float, non_housing_monthly: float) -> float:
    """Monthly cost of everything a single adult needs in a place."""
    return rent + non_housing_monthly


def gross_for_net(
    target_annual_net: Optional[float], state: str, local: Optional[str] = None
) -> Optional[float]:
    """Smallest gross salary whose take-home pay reaches ``target_annual_net``.

    Bisection, not algebra: take-home is piecewise-linear in gross with kinks at
    every bracket edge, the Social Security wage cap and the Additional Medicare
    threshold. It is, however, strictly increasing, which is all bisection needs
    — and it means one implementation covers every jurisdiction the engine knows.

    Returns None when the target is unreachable.
    """
    if target_annual_net is None or not (target_annual_net > 0):
        return 0.0

    def net_of(gross: float) -> float:
        return total_tax(gross, state, local).net

    # Grow the upper bound until it brackets the target. Marginal rates stay
    # below 100%, so this terminates; the cap guards against a malformed bracket
    # table rather than an expected path.
    hi = max(target_annual_net * 1.5, 10_000.0)
    attempts = 0
    while net_of(hi) < target_annual_net:
        if attempts > 40:
            return None
        hi *= 2
        attempts += 1

    lo = 0.0
    # ~60 halvings takes a $10M interval well below a cent; the loop bound is a
    # belt-and-braces stop, and the width test is what actually ends it.
    for _ in range(200):
        if hi - lo <= 0.01:
            break
        mid = (lo + hi) / 2
        if net_of(mid) < target_annual_net:
            lo = mid
        else:
            hi = mid
    return hi


def salary_bands(
    rent: float, non_housing_monthly: float, state: str, local: Optional[str] = None
) -> SalaryLadder:
    """The salary ladder for one place."""
    needs = monthly_needs(rent, non_housing_monthly)

    def salary_at_share(share: float) -> Optional[float]:
        return gross_for_net((needs * 12) / share, state, local)

    return SalaryLadder(
        rent=rent,
        non_housing_monthly=non_housing_monthly,
        monthly_needs=needs,
        annual_needs=needs * 12,
        survival=salary_at_share(1.0),
        getting_by=salary_at_share(0.7),
        comfortable=salary_at_share(0.5),
    )


def classify(monthly_net: float, needs: float) -> Band:
    """Where a given take-home figure lands on the ladder."""
    if not (monthly_net > 0):
        return BAND_BY_ID["below-survival"]

    share = needs / monthly_net

    # Bands are ordered hardest-first; the last one whose ceiling still admits
    # this share is the answer.
    match = BAND_BY_ID["below-survival"]
    for band in BANDS:
        if share <= band.max_needs_share:
            match = band
    return match


def assess(
    gross: float,
    rent: float,
    non_housing_monthly: float,
    state: str,
    local: Optional[str] = None,
) -> Assessment:
    """The ladder, where this salary sits on it, and the tax in between."""
    tax = total_tax(gross, state, local)
    monthly_net = tax.net / 12
    needs = monthly_needs(rent, non_housing_monthly)

    return Assessment(
        gross=gross,
        tax=tax,
        monthly_net=monthly_net,
        monthly_needs=needs,
        needs_share=needs / monthly_net if monthly_net > 0 else None,
        monthly_surplus=monthly_net - needs,
        rent_share=rent / monthly_net if monthly_net > 0 else None,
        bands=salary_bands(rent, non_housing_monthly, state, local),
        band=classify(monthly_net, needs),
    )
