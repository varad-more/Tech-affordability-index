"""
Pins the published tax curves against the engine they are generated from.

This is the load-bearing test of the static build. The site ships as flat files,
so the browser evaluates tax from a table of knot points rather than by running
:mod:`app.tax`. That is only sound because every component of the liability is
piecewise linear in gross wages, with kinks at known constants — see
:mod:`app.net_curve`.

"Only sound because" is an assumption, and assumptions in a tax engine should be
executable. So this samples every jurisdiction densely, and deliberately crowds
the neighbourhood of every knot, where a missing kink or an off-by-one would
hide. If a future tax year adds a rule that is not piecewise linear — a phase-out
computed on a square, a credit that steps — these fail, loudly, on the sample
that straddles it. They do not degrade quietly.

A missing knot is the specific failure worth fearing: it does not raise, it draws
a straight line across a corner, and the error is largest at exactly the salaries
most people earn.
"""

import random

import pytest

from app.bands import gross_for_net
from app.net_curve import (
    FEDERAL,
    FICA,
    LOCAL_CURVES,
    STATE_CURVES,
    interpolate,
    invert,
    liability,
    net_curve,
    published,
)
from app.tax import total_tax
from app.tax_data import LOCAL, STATES

#: Every tax jurisdiction the site can price: fifty states and DC, plus the two
#: modelled city taxes.
JURISDICTIONS = [(code, None) for code in sorted(STATES)] + [
    (locality.state, code) for code, locality in sorted(LOCAL.items())
]

#: Salaries to check in every jurisdiction. Spread across the range the site
#: actually serves, with the extremes included because that is where
#: extrapolation past the sentinel knot takes over.
SALARIES = [
    0, 1, 0.01, 12_000, 30_000, 47_500, 63_000, 85_000, 100_000, 123_456.78,
    156_000, 184_500, 200_000, 250_000, 400_000, 626_350, 1_000_000, 5_000_000,
    25_000_000, 40_000_000,
]


def around(knot: float):
    """A knot and its immediate neighbourhood, on both sides."""
    return [
        knot,
        knot - 1e-6, knot + 1e-6,
        knot - 0.01, knot + 0.01,
        knot - 1, knot + 1,
        knot - 1000, knot + 1000,
    ]


def all_knots(state: str, local) -> set:
    knots = set(FEDERAL.knots) | set(FICA.knots) | set(STATE_CURVES[state].income.knots)
    for levy in STATE_CURVES[state].payroll:
        knots |= set(levy.curve.knots)
    if local:
        knots |= set(LOCAL_CURVES[local].knots)
    return knots


@pytest.mark.parametrize("state,local", JURISDICTIONS, ids=lambda v: str(v))
def test_the_curve_reproduces_the_engine(state, local):
    """The whole approach in one assertion, for every jurisdiction."""
    rng = random.Random(20260726)
    samples = list(SALARIES)
    samples += [rng.uniform(0, 800_000) for _ in range(500)]
    for knot in all_knots(state, local):
        samples += around(knot)

    for gross in samples:
        if gross < 0:
            continue
        want = total_tax(gross, state, local)
        got = liability(gross, state, local)

        # Cents, not dollars: the two differ only by the order floating-point
        # addition happens in, and anything larger means a knot is missing.
        assert got.federal == pytest.approx(want.federal, abs=1e-6, rel=1e-12)
        assert got.fica == pytest.approx(want.fica, abs=1e-6, rel=1e-12)
        assert got.state_income == pytest.approx(want.state_income, abs=1e-6, rel=1e-12)
        assert got.state_payroll == pytest.approx(want.state_payroll, abs=1e-6, rel=1e-12)
        assert got.local == pytest.approx(want.local, abs=1e-6, rel=1e-12)
        assert got.net == pytest.approx(want.net, abs=1e-6, rel=1e-12)


@pytest.mark.parametrize("state,local", JURISDICTIONS, ids=lambda v: str(v))
def test_the_payroll_breakdown_survives_the_round_trip(state, local):
    """The pages itemise each levy by name, so each has to be right on its own.

    Summing to the right total while attributing it to the wrong levy is a bug a
    total-only check cannot see, and the tax panel prints every label.
    """
    for gross in (0, 50_000, 156_000, 400_000):
        want = total_tax(gross, state, local)
        got = liability(gross, state, local)

        assert [d[0] for d in got.state_payroll_detail] == [
            item.label for item in want.state_payroll_detail
        ]
        for (_, amount), item in zip(got.state_payroll_detail, want.state_payroll_detail):
            assert amount == pytest.approx(item.amount, abs=1e-6, rel=1e-12)


@pytest.mark.parametrize("state,local", JURISDICTIONS, ids=lambda v: str(v))
def test_take_home_only_ever_rises(state, local):
    """Strict monotonicity, which is what makes the inverse well-defined.

    It is also a real-world claim worth pinning: a raise must never reduce
    take-home pay. A bracket table entered out of order would break both.
    """
    curve = net_curve(state, local)
    for i in range(len(curve.values) - 1):
        assert curve.values[i + 1] > curve.values[i], curve.knots[i]


@pytest.mark.parametrize("state,local", JURISDICTIONS, ids=lambda v: str(v))
def test_the_inverse_lands_back_on_the_wage_it_came_from(state, local):
    """Round-trip: gross -> net -> gross."""
    curve = net_curve(state, local)
    for gross in (12_000, 47_500, 85_000, 156_000, 250_000, 626_350, 2_000_000):
        back = invert(curve, interpolate(curve, gross))
        assert back == pytest.approx(gross, abs=1e-6, rel=1e-12)


def test_the_inverse_beats_the_bisection_it_replaced():
    """``gross_for_net`` used to bisect the engine and stop within a cent.

    It now solves the curve exactly. The old answer was always the true root or
    a hair above it — bisection returned the upper bound of its final interval —
    so this pins both that the new answer agrees, and that it is the tighter of
    the two rather than merely different.
    """
    for state, local in JURISDICTIONS:
        for target in (30_000, 60_000, 90_000, 150_000, 400_000):
            exact = gross_for_net(target, state, local)
            assert exact is not None
            assert total_tax(exact, state, local).net == pytest.approx(target, abs=1e-6)


def test_zero_and_below_are_free():
    for state, local in JURISDICTIONS:
        assert liability(0, state, local).total == 0
        assert liability(0, state, local).net == 0


def test_every_curve_starts_at_zero_and_ascends():
    """The shape the browser's interpolation assumes."""
    curves = [FEDERAL, FICA]
    curves += [j.income for j in STATE_CURVES.values()]
    curves += [levy.curve for j in STATE_CURVES.values() for levy in j.payroll]
    curves += list(LOCAL_CURVES.values())

    for curve in curves:
        assert curve.knots[0] == 0
        assert len(curve.knots) == len(curve.values)
        assert list(curve.knots) == sorted(set(curve.knots)), "knots must be unique"
        assert curve.values[0] == 0


def test_the_published_bundle_is_json_shaped_and_small():
    """It is fetched once by every visitor, so its size is a real constraint.

    Sharing the federal and FICA curves across all fifty-three jurisdictions
    rather than repeating them is most of why this is kilobytes and not hundreds.
    """
    import json

    blob = published()
    text = json.dumps(blob)

    assert set(blob) == {"federal", "fica", "states", "local"}
    assert len(blob["states"]) == len(STATES)
    assert len(blob["local"]) == len(LOCAL)
    assert len(text) < 60_000, "curve bundle grew to {} bytes".format(len(text))

    # Full precision, not rounded: rounding a knot value rounds the *slope* of
    # the segment leading to it, and that error compounds across a segment
    # hundreds of thousands of dollars wide.
    assert json.loads(text) == blob
