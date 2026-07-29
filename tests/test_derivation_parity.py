"""
Guards the browser-parity fixture against drifting away from Python.

The static build put a little arithmetic in the browser: evaluating the tax
curves, dividing needs by take-home, and comparing against thresholds Python
published. ``e2e/fixtures/derivation.json`` is the contract between the two, and
it is only worth anything if both ends are pinned:

* **this file** checks the committed fixture still matches what Python computes,
  so a change to the model cannot leave stale expectations behind;
* **the browser suite** checks JavaScript reproduces the same fixture.

Without the first check, changing a bracket and forgetting to regenerate would
leave the browser agreeing perfectly with last month's answer.

If this fails after a deliberate change, regenerate::

    python scripts/make_parity_fixture.py

and read the diff before committing it. A diff here is a change to numbers the
site publishes.
"""

import json
from pathlib import Path

import pytest

from scripts.make_parity_fixture import FIXTURE, build


@pytest.fixture(scope="module")
def committed():
    if not FIXTURE.exists():
        pytest.fail(
            "{} is missing. Generate it with "
            "`python scripts/make_parity_fixture.py`.".format(FIXTURE.name)
        )
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def current():
    return build()


def test_the_fixture_covers_what_it_claims(committed):
    """A fixture that quietly shrank would keep passing while proving less."""
    assert len(committed["liability"]) > 600
    assert len(committed["grossForNet"]) > 300
    assert len(committed["steps"]) > 30
    assert len(committed["classify"]) > 25
    assert len(committed["salaryBands"]) >= 10
    assert len(committed["equivalence"]) > 400
    assert len(committed["rank"]) > 100


def test_the_equivalence_cases_cover_both_directions_and_the_identity(committed):
    """The three properties that make the section worth having.

    Every ordered pair means a destination-side bug cannot hide behind the
    origin, and the identity pairs are the cheapest check that the inverse is
    genuinely one — move nowhere, get the salary back.
    """
    cases = committed["equivalence"]
    pairs = {(c["basis"], c["from"], c["to"]) for c in cases}

    identity = [c for c in cases if c["from"] == c["to"] and c["salary"] > 0]
    assert identity, "no identity pairs — the round-trip check is not being made"
    for case in identity:
        assert case["sameShare"] == pytest.approx(case["salary"])
        assert case["sameSurplus"] == pytest.approx(case["salary"])

    for basis, a, b in list(pairs):
        assert (basis, b, a) in pairs, "{}: {} -> {} has no reverse".format(basis, a, b)

    # No take-home, no standard of living to hold constant. Null rather than nought.
    for case in cases:
        if case["salary"] == 0:
            assert case["sameShare"] is None and case["sameSurplus"] is None


@pytest.mark.parametrize(
    "section",
    [
        "liability", "grossForNet", "steps", "classify",
        "salaryBands", "equivalence", "rank",
    ],
)
def test_the_committed_fixture_still_matches_python(committed, current, section):
    """Exact, not approximate.

    Every value here comes from +, -, * and / on doubles, which IEEE 754 pins
    exactly, and JSON round-trips a double losslessly. A tolerance would hide
    precisely the kind of change worth catching in a tax engine.
    """
    want = committed[section]
    got = current[section]

    assert len(want) == len(got), (
        "{}: fixture has {} cases, Python now produces {} — regenerate with "
        "`python scripts/make_parity_fixture.py`".format(section, len(want), len(got))
    )

    mismatches = [
        "case {}: fixture {!r} != python {!r}".format(i, a, b)
        for i, (a, b) in enumerate(zip(want, got))
        if a != b
    ]
    assert not mismatches, "{}: {} of {} cases drifted\n  {}".format(
        section, len(mismatches), len(want), "\n  ".join(mismatches[:5])
    )


def test_the_fixture_is_strict_json_the_browser_can_parse():
    """NaN and Infinity are valid JavaScript and invalid JSON.

    Either would survive `json.dumps` with default settings, sail through a
    browser `fetch`, and fail anywhere strict — so the generator writes with
    `allow_nan=False` and this proves the committed file honours it.
    """
    text = Path(FIXTURE).read_text(encoding="utf-8")
    json.loads(text, parse_constant=_reject)


def _reject(value):
    raise ValueError("non-finite JSON constant: {}".format(value))
