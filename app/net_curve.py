"""
The tax engine, re-expressed as a table the browser can evaluate exactly.

The site is served as static files, so no Python runs when a reader moves the
salary slider. That would normally mean reimplementing the tax engine in
JavaScript — fifty states of bracket tables in a second language, which is
precisely the duplication the Flask port existed to remove.

It is avoidable, because of a property the engine happens to have.

Every component of the liability is **piecewise linear in gross wages**:

===================  =========================================================
``progressive_tax``  affine inside each bracket; kinks at the bracket edges,
                     shifted by whatever deduction applies to that base
``fica_tax``         ``min`` at the Social Security wage base, ``max`` at the
                     Additional Medicare threshold — two kinks, affine between
payroll levies       ``min(gross, cap) * rate`` — one kink at the cap
===================  =========================================================

A sum of piecewise-linear functions is piecewise linear, and the kinks are all
*known constants* rather than something to be discovered numerically. So the
whole engine can be published as a set of knot points, and linear interpolation
between two adjacent knots reproduces it **exactly** — not approximately. The
browser receives a few hundred numbers this module computed and does one
multiply and one add; it never sees a bracket, a rate or a deduction.

``tests/test_net_curve.py`` is the load-bearing check: it samples every
jurisdiction densely, and around every knot where an off-by-one would hide, and
asserts the interpolation agrees with :func:`app.tax.total_tax` to within float
noise. If a future tax year introduced a genuinely non-linear rule — a phase-out
computed on a square, say, or a credit that steps — that test fails loudly and
this approach has to be reconsidered. It does not fail silently.

The one thing to remember when editing: a curve must carry a knot at *every*
kink of the function it describes. A missing knot does not raise; it quietly
draws a straight line across a corner, and the error is largest exactly at the
salaries most people earn.
"""

import math
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

from .tax import fica_tax, federal_tax, local_tax, progressive_tax, state_taxable_income
from .tax_data import (
    ADDITIONAL_MEDICARE_THRESHOLD,
    FEDERAL_BRACKETS,
    FEDERAL_STANDARD_DEDUCTION,
    LOCAL,
    SOCIAL_SECURITY_WAGE_BASE,
    STATES,
)


class Curve(NamedTuple):
    """One piecewise-linear component, as knots and the values at them.

    ``knots`` is strictly ascending and always starts at 0. The last knot is a
    sentinel far above any real wage, placed so that the final segment carries
    the top marginal slope — which makes extrapolation past it exact rather than
    a guess.
    """

    knots: Tuple[float, ...]
    values: Tuple[float, ...]


class Levy(NamedTuple):
    label: str
    curve: Curve


class Jurisdiction(NamedTuple):
    income: Curve
    payroll: Tuple[Levy, ...]


#: Floor for the sentinel knot. The real sentinel is placed above the highest
#: genuine kink, never at a fixed figure — New York's top bracket starts at
#: $25,000,000, so a constant sentinel here sat *below* a real bracket edge and
#: left the knots unsorted, which silently breaks every binary search over them.
SENTINEL_FLOOR = 25_000_000.0


def _curve(kinks: Sequence[float], fn) -> Curve:
    """Build a curve from the kinks of a piecewise-linear function.

    Zero is always included, negative kinks are dropped (no wage is negative),
    and a sentinel is appended beyond the last real kink so the final segment
    carries the top marginal slope.
    """
    knots = sorted({0.0} | {float(k) for k in kinks if k > 0})
    knots.append(max(SENTINEL_FLOOR, knots[-1] * 2))
    return Curve(tuple(knots), tuple(fn(k) for k in knots))


def interpolate(curve: Curve, gross: float) -> float:
    """Evaluate a curve at any wage. Exact, not approximate — see module docs."""
    knots, values = curve.knots, curve.values
    if gross <= knots[0]:
        return values[0]

    lo, hi = 0, len(knots) - 1
    if gross >= knots[hi]:
        # Past the sentinel the function is still affine, with the slope of the
        # final segment. Extrapolating along it is exact.
        lo = hi - 1
    else:
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if knots[mid] <= gross:
                lo = mid
            else:
                hi = mid

    ga, gb = knots[lo], knots[lo + 1]
    va, vb = values[lo], values[lo + 1]
    return va + (gross - ga) * (vb - va) / (gb - ga)


def invert(curve: Curve, target: float) -> Optional[float]:
    """The wage at which a strictly increasing curve reaches ``target``.

    Used to solve the salary ladder: "what must someone earn here for
    necessities to be half of take-home?" The old implementation bisected the
    tax engine sixty times per answer and stopped within a cent. This is the
    closed-form inverse of the same function — exact, and one binary search over
    a couple of dozen knots.

    Returns None only if the curve is not increasing at the top, which would
    mean a marginal rate at or above 100%.
    """
    knots, values = curve.knots, curve.values
    if target <= values[0]:
        return knots[0]

    last = len(values) - 1
    if target >= values[last]:
        lo = last - 1
        if values[last] <= values[lo]:
            return None
    else:
        lo, hi = 0, last
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if values[mid] <= target:
                lo = mid
            else:
                hi = mid

    va, vb = values[lo], values[lo + 1]
    if vb == va:
        return knots[lo]
    ga, gb = knots[lo], knots[lo + 1]
    return ga + (target - va) * (gb - ga) / (vb - va)


# --- the published curves ------------------------------------------------
#
# Federal income tax and FICA do not vary by jurisdiction, so they are computed
# once rather than repeated in all fifty-three. That is not only smaller on the
# wire; it means there is exactly one federal curve to be right.

FEDERAL: Curve = _curve(
    [FEDERAL_STANDARD_DEDUCTION + b.lower for b in FEDERAL_BRACKETS],
    federal_tax,
)

FICA: Curve = _curve(
    [SOCIAL_SECURITY_WAGE_BASE, ADDITIONAL_MEDICARE_THRESHOLD],
    fica_tax,
)


def _state_curves(code: str) -> Jurisdiction:
    state = STATES[code]

    income = _curve(
        [state.standard_deduction + b.lower for b in state.brackets],
        lambda g: progressive_tax(state_taxable_income(g, code), state.brackets),
    )

    payroll = tuple(
        Levy(
            levy.label,
            _curve(
                [levy.cap] if levy.cap is not None else [],
                # Bound to this levy, not the loop variable: a late-binding
                # closure here would give every levy the last one's rate.
                lambda g, levy=levy: min(
                    g, math.inf if levy.cap is None else levy.cap
                )
                * levy.rate,
            ),
        )
        for levy in state.payroll
    )

    return Jurisdiction(income=income, payroll=payroll)


def _local_curve(code: str) -> Curve:
    locality = LOCAL[code]
    # A city tax on state-taxable income kinks at the state's deduction plus each
    # bracket edge; one on gross kinks at the edges themselves.
    shift = (
        0.0
        if locality.base == "gross"
        else STATES[locality.state].standard_deduction
    )

    return _curve(
        [shift + b.lower for b in locality.brackets],
        lambda g: local_tax(g, code, locality.state),
    )


STATE_CURVES: Dict[str, Jurisdiction] = {code: _state_curves(code) for code in STATES}
LOCAL_CURVES: Dict[str, Curve] = {code: _local_curve(code) for code in LOCAL}


class Liability(NamedTuple):
    """The same fields :class:`app.tax.TaxBreakdown` carries, from the curves."""

    gross: float
    federal: float
    fica: float
    state_income: float
    state_payroll: float
    state_payroll_detail: Tuple[Tuple[str, float], ...]
    local: float
    total: float
    net: float
    effective_rate: float


def liability(gross: float, state: str, local: Optional[str] = None) -> Liability:
    """Evaluate the whole liability from the curves.

    The summation order matters and is deliberately identical to
    :func:`app.tax.total_tax`: federal, then FICA, then the state total, then
    local. Floating-point addition is not associative, so a different order
    would agree to within a cent and disagree in the last bit — and the last bit
    is what the parity tests are for.
    """
    jurisdiction = STATE_CURVES[state]

    federal = interpolate(FEDERAL, gross)
    fica = interpolate(FICA, gross)
    state_income = interpolate(jurisdiction.income, gross)

    # No wage, no levies — matching :func:`app.tax.state_tax`, which returns an
    # empty breakdown rather than a list of zeroes. The pages itemise this list,
    # and a row reading "State Disability Insurance $0" is noise, not detail.
    detail = (
        tuple(
            (levy.label, interpolate(levy.curve, gross))
            for levy in jurisdiction.payroll
        )
        if gross > 0
        else ()
    )
    state_payroll = 0.0
    for _, amount in detail:
        state_payroll += amount

    local_amount = interpolate(LOCAL_CURVES[local], gross) if local else 0.0

    total = federal + fica + (state_income + state_payroll) + local_amount

    return Liability(
        gross=gross,
        federal=federal,
        fica=fica,
        state_income=state_income,
        state_payroll=state_payroll,
        state_payroll_detail=detail,
        local=local_amount,
        total=total,
        net=gross - total,
        effective_rate=total / gross if gross > 0 else 0.0,
    )


def _merged_knots(state: str, local: Optional[str]) -> Tuple[float, ...]:
    """Every knot of every component that applies in one jurisdiction.

    The union is where the *total* kinks, so a net curve built on it is exact.
    Built the same way in the browser, from the same published numbers, which is
    what lets both sides land on identical floats rather than merely close ones.
    """
    jurisdiction = STATE_CURVES[state]
    knots = set(FEDERAL.knots) | set(FICA.knots) | set(jurisdiction.income.knots)
    for levy in jurisdiction.payroll:
        knots |= set(levy.curve.knots)
    if local:
        knots |= set(LOCAL_CURVES[local].knots)
    return tuple(sorted(knots))


_NET_CACHE: Dict[Tuple[str, Optional[str]], Curve] = {}


def net_curve(state: str, local: Optional[str] = None) -> Curve:
    """Take-home pay against gross, for one jurisdiction."""
    key = (state, local)
    curve = _NET_CACHE.get(key)
    if curve is None:
        knots = _merged_knots(state, local)
        curve = Curve(knots, tuple(liability(k, state, local).net for k in knots))
        _NET_CACHE[key] = curve
    return curve


def published() -> Dict[str, object]:
    """The curves as plain JSON, for the browser.

    Values are emitted at full precision on purpose. Rounding them to cents
    would round the *slopes*, and a slope error compounds across a segment
    hundreds of thousands of dollars wide.
    """

    def as_json(curve: Curve) -> Dict[str, List[float]]:
        return {"knots": list(curve.knots), "values": list(curve.values)}

    return {
        "federal": as_json(FEDERAL),
        "fica": as_json(FICA),
        "states": {
            code: {
                "income": as_json(jurisdiction.income),
                "payroll": [
                    dict(label=levy.label, **as_json(levy.curve))
                    for levy in jurisdiction.payroll
                ],
            }
            for code, jurisdiction in STATE_CURVES.items()
        },
        "local": {code: as_json(curve) for code, curve in LOCAL_CURVES.items()},
    }
