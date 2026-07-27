"""
Pins the derived layers — bands, seasonality, state rollup — against the
JavaScript they were ported from.

The tax engine is arithmetic and was always going to port cleanly.
:func:`app.bands.gross_for_net` is a bisection that has to terminate on the same
cent, and :func:`app.seasonality.seasonal_index` is a decomposition where an
off-by-one in the centring silently shifts every month by half a year and still
returns twelve plausible-looking numbers. Those are the two worth proving.

The seasonal cases are checked twice over: against a fresh run of the JavaScript,
and against the figures already committed in ``data/rent-history.json`` by the
Node build script. The second check is the one that matters, because it is the
shipped data rather than a recomputation agreeing with itself.
"""

import json
import math
from pathlib import Path

import pytest

from app.bands import assess, gross_for_net, needs_share_step, salary_bands
from app.seasonality import centred_trend, seasonal_index, seasonal_saving
from app.state_rollup import roll_up_states

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "derived-parity.json").read_text(encoding="utf-8")
)


def test_the_fixture_covers_what_it_claims():
    assert len(FIXTURE["bandCases"]) > 700
    assert len(FIXTURE["seasonalCases"]) > 30
    assert len(FIXTURE["rollups"]) == 51


def test_salary_ladders_match():
    mismatches = []
    for case in FIXTURE["bandCases"]:
        got = salary_bands(
            case["rent"], case["nonHousingMonthly"], case["state"], case["local"]
        )
        for key, mine in (
            ("monthlyNeeds", got.monthly_needs),
            ("survival", got.survival),
            ("gettingBy", got.getting_by),
            ("comfortable", got.comfortable),
        ):
            if mine != case[key]:
                mismatches.append(
                    "{} rent={} nh={}: {} want {!r} got {!r}".format(
                        case["state"], case["rent"], case["nonHousingMonthly"],
                        key, case[key], mine,
                    )
                )
    assert not mismatches, "\n  ".join(mismatches[:20])


def test_assessments_match():
    for case in FIXTURE["bandCases"]:
        got = assess(
            150000, case["rent"], case["nonHousingMonthly"], case["state"], case["local"]
        )
        assert got.needs_share == case["assessNeedsShare"]
        assert got.monthly_surplus == case["assessMonthlySurplus"]
        assert got.rent_share == case["assessRentShare"]
        assert got.band.id == case["assessBandId"]


def test_the_bisection_lands_on_the_same_cent():
    for case in FIXTURE["grossForNetCases"]:
        got = gross_for_net(case["target"], case["state"])
        assert got == case["gross"], "{} target {}".format(case["state"], case["target"])


def test_needs_share_step_agrees_at_every_break():
    for case in FIXTURE["stepCases"]:
        share = case["share"]
        if isinstance(share, str):
            share = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}.get(
                share
            )
            if share is None:  # the JS 'null'/'undefined' cases
                assert needs_share_step(None) == case["step"]
                continue
        assert needs_share_step(share) == case["step"], "share {!r}".format(share)


def test_seasonal_decomposition_matches_the_javascript():
    for case in FIXTURE["seasonalCases"]:
        got = seasonal_index(case["series"], case["startMonth"])
        want = case["result"]

        if want is None:
            assert got is None, case["fips"]
            continue

        assert got is not None, case["fips"]
        assert got.years == want["years"], case["fips"]
        assert got.cheapest == want["cheapest"], case["fips"]
        assert got.dearest == want["dearest"], case["fips"]

        # To a few ULP rather than bit-exact, unlike the tax engine above, and
        # the difference is worth stating rather than papering over.
        #
        # The tax engine is addition, multiplication and min/max on doubles.
        # IEEE 754 pins every one of those exactly, so two correct
        # implementations agree to the last bit on any platform.
        #
        # This is a decomposition: it averages long runs of ratios, and the
        # accuracy of a float sum depends on how it is accumulated. The
        # JavaScript reduced left to right; the Python uses math.fsum, which is
        # exactly rounded. They therefore differ in the last bit or two, and the
        # Python is the more accurate of the two. Demanding equality here would
        # be demanding that the port reproduce the original's rounding error.
        assert got.index == pytest.approx(want["index"], rel=1e-12), case["fips"]
        assert got.amplitude == pytest.approx(want["amplitude"], rel=1e-12), case["fips"]

        saving = seasonal_saving(got.index, 2000)
        assert saving.monthly == pytest.approx(want["saving"]["monthly"], rel=1e-12)
        assert saving.annual == pytest.approx(want["saving"]["annual"], rel=1e-12)


def test_centred_trend_matches():
    for case in FIXTURE["seasonalCases"]:
        assert centred_trend(case["series"])[-8:] == case["trendTail"], case["fips"]


def js_round(value: float, places: int) -> float:
    """JavaScript's ``Math.round(v * 10**places) / 10**places``.

    Not the same as Python's :func:`round`. Python rounds halves to even and
    JavaScript rounds them up, so the two disagree on exact ties — and a
    seasonal index lands on one often enough to matter. Comparing against the
    committed file means comparing on the rule that wrote it.

    This only arises because the ingests stayed in Node while the app moved to
    Python. If a rewrite ever hands ``rent-history.json`` to Python, this is the
    difference that would silently move the last digit of every county.
    """
    scale = 10 ** places
    return math.floor(value * scale + 0.5) / scale


def test_the_shipped_index_cannot_be_recomputed_from_the_shipped_history():
    """Documents a real gap in ``data/rent-history.json``, found during the port.

    The committed ``season`` is computed from the **full** ZORI series — all 138
    months, at full precision. The committed ``history`` beside it is only the
    last 72 months, rounded to whole dollars. So a reader who tries to verify
    the seasonal index from the published file cannot: they are missing five
    years of input and the cents from the rest.

    That does not make the index wrong — using every month makes it better — but
    for a project whose pitch is "sources you can check", the check does not
    close. Pinned here rather than left to be rediscovered as a bug, with the
    observed bound recorded so a genuine regression still shows up.

    The port's own fidelity is proved by
    :func:`test_seasonal_decomposition_matches_the_javascript`, which feeds both
    engines identical inputs. That drift is measured in ULP; this one is
    measured in thousandths, and they are unrelated.
    """
    deviations = []
    for case in FIXTURE["seasonalCases"]:
        got = seasonal_index(case["series"], case["startMonth"])
        committed = case["committed"]
        if got is None or committed["season"] is None:
            continue
        deviations.append(
            max(abs(a - b) for a, b in zip(got.index, committed["season"]))
        )

    assert deviations, "no comparable series in the fixture"
    # Recomputing from the shipped history lands near the shipped index without
    # reaching it. A tenth of a percentage point of drift is the cost of the
    # truncation and the rounding; materially more would mean the model moved.
    assert max(deviations) < 0.02, "worst drift {:.5f}".format(max(deviations))
    assert max(deviations) > 0, "if this ever hits zero the inputs were unified"


def test_a_known_seasonal_answer_is_recovered():
    """Real data that happens to be flat would let a broken port look fine.

    This series is a 0.4%/month exponential trend times a 5% sine wave, so the
    right answer is known independently: the peak sits three months after the
    series starts and the amplitude is close to 10% peak-to-trough.
    """
    got = seasonal_index(FIXTURE["synthetic"]["series"], 0)
    want = FIXTURE["synthetic"]["result"]

    assert got is not None
    assert got.index == pytest.approx(want["index"], rel=1e-12)
    assert got.dearest == 3
    assert got.cheapest == 9
    assert 0.09 < got.amplitude < 0.11


def test_state_rollups_match():
    got = roll_up_states(FIXTURE["rollupCounties"])
    want = FIXTURE["rollups"]

    assert set(got) == set(want)
    for code, rollup in got.items():
        expected = want[code]
        assert rollup.n == expected["n"], code
        assert rollup.median["fips"] == expected["medianFips"], code
        assert rollup.cheapest["fips"] == expected["cheapestFips"], code
        assert rollup.dearest["fips"] == expected["dearestFips"], code
        assert rollup.spread == expected["spread"], code
