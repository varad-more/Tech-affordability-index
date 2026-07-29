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

The same machinery answers the relocation question — *what is this salary worth
somewhere else?* — because an equivalent salary is one of these solves at the
share you already have rather than at one of the three named standards. See
:func:`equivalent_salary`.
"""

import math
from typing import NamedTuple, Optional, Tuple

from .net_curve import invert, liability, net_curve
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


class Place(NamedTuple):
    """One county, as everything in this module needs to see it.

    Exists because :func:`equivalent_salary` takes two of them, and eight
    positional floats and strings at a call site is how an origin and a
    destination get silently swapped.
    """

    rent: float
    non_housing_monthly: float
    state: str
    local: Optional[str] = None


class Equivalence(NamedTuple):
    """What one salary is worth somewhere else, on both readings.

    Both are reported because neither is the whole answer, and a page that
    quoted one without the other would be picking a side of a real argument
    without saying so.
    """

    salary: float
    #: Monthly, where the salary is earned now.
    from_monthly_net: float
    from_monthly_needs: float
    from_needs_share: Optional[float]
    from_monthly_surplus: float
    #: Monthly cost of necessities at the destination.
    to_monthly_needs: float
    #: Necessities keep the same share of take-home. The headline.
    same_share: Optional[float]
    #: The same dollars survive each month after necessities.
    same_surplus: Optional[float]


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

    Take-home is piecewise linear in gross, with kinks at every bracket edge, the
    Social Security wage base and the Additional Medicare threshold — and those
    kinks are known constants rather than something to be found numerically. So
    this is the closed-form inverse of that function: one binary search over a
    couple of dozen knots, then a single interpolation.

    This used to bisect the tax engine itself, roughly sixty evaluations per
    call, stopping once the interval was under a cent. That was correct to the
    cent and slow enough to need an 8,192-entry cache in front of it, because the
    By-state page solves one per county — 254 of them for Texas.

    The exact answer is not merely faster. The browser has to solve the same
    ladder against the same published curve, and two bisections tuned to
    different tolerances would disagree in the pennies while both looked right.
    An exact inverse on both sides agrees to the last bit, which is a property
    that can actually be tested.

    Returns None only if take-home stops increasing with gross, which would mean
    a marginal rate at or above 100%.
    """
    if target_annual_net is None or not (target_annual_net > 0):
        return 0.0

    return invert(net_curve(state, local), target_annual_net)


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


def equivalent_salary(salary: float, origin: Place, destination: Place) -> Equivalence:
    """What ``salary`` in ``origin`` is worth in ``destination``.

    The relocation question — "I earn this in Austin; what is the same life worth
    in San Francisco?" — turns out to need no new tax code at all. It is
    :func:`salary_bands` solved at the share you already have rather than at one
    of the three named standards, so it inherits the exact inverse, every payroll
    levy and both city taxes for free.

    Two answers, because there are two honest readings of "the same life" and
    they diverge by tens of thousands of dollars:

    ``same_share``
        Necessities keep the same fraction of take-home. This is the headline,
        and it is the only reading consistent with the rest of the site: the
        map's class breaks, the four bands and every verdict all cut on
        needs-share. It assumes discretionary spending scales with the
        destination, which overstates the raise for a high earner whose savings
        do not care what rent costs.
    ``same_surplus``
        The same dollars survive each month. It assumes *none* of your
        discretionary spending is local, which understates the raise for anyone
        who eats out where they live.

    Real life sits between them, and where two counties cost alike they collapse
    together — which is itself worth seeing.

    Take-home comes from :func:`app.net_curve.liability` rather than
    :func:`app.tax.total_tax` for the reason :mod:`app.affordability` gives at
    length: the browser can only evaluate the published curve, so pinning this to
    the curve keeps the parity test exact instead of forcing a tolerance into it.

    A salary that yields no take-home has no standard of living to hold constant,
    so both readings are ``None`` rather than zero — "there is no equivalent" and
    "the equivalent is nothing" are different sentences.
    """
    monthly_net = liability(salary, origin.state, origin.local).net / 12
    needs_here = monthly_needs(origin.rent, origin.non_housing_monthly)
    needs_there = monthly_needs(destination.rent, destination.non_housing_monthly)

    if not (monthly_net > 0):
        return Equivalence(
            salary=salary,
            from_monthly_net=monthly_net,
            from_monthly_needs=needs_here,
            from_needs_share=None,
            from_monthly_surplus=monthly_net - needs_here,
            to_monthly_needs=needs_there,
            same_share=None,
            same_surplus=None,
        )

    share = needs_here / monthly_net
    surplus = monthly_net - needs_here

    # A destination cheap enough that even earning nothing there beats being
    # short here lands on a non-positive target, and `gross_for_net` answers 0.
    # That is the right answer rather than an edge case to trap: no salary is
    # required to be at least this well off.
    return Equivalence(
        salary=salary,
        from_monthly_net=monthly_net,
        from_monthly_needs=needs_here,
        from_needs_share=share,
        from_monthly_surplus=surplus,
        to_monthly_needs=needs_there,
        same_share=gross_for_net(
            needs_there * 12 / share, destination.state, destination.local
        ),
        same_surplus=gross_for_net(
            (surplus + needs_there) * 12, destination.state, destination.local
        ),
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
