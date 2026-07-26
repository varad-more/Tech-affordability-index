"""
Pins the Python tax engine against the JavaScript engine it replaced.

The fixture was generated from ``src/tax.js`` immediately before the Flask port,
over 2,067 cases chosen to sit where a progressive engine goes wrong: every
federal bracket edge and a dollar either side of it, the Social Security wage
cap, the Additional Medicare threshold, zero, one, and a deliberately awkward
non-integer salary. All 51 states, plus the two modelled city taxes.

Both languages compute in IEEE 754 doubles in the same order, so the port is
expected to be bit-exact rather than merely close — and it is, across all 16,536
compared figures. The assertion is therefore equality, not a tolerance: a
tolerance would quietly absorb a real arithmetic change, which for a tax engine
is the whole thing worth catching.

Now that the JavaScript is gone this is a golden regression fixture. A change
here has to be a deliberate change to the tax model, not a surprise.
"""

import json
from pathlib import Path

import pytest

from app.tax import total_tax

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "tax-parity.json").read_text(encoding="utf-8")
)
CASES = FIXTURE["cases"]

#: Fixture key -> attribute on the breakdown the port returns.
FIELDS = (
    ("federal", "federal"),
    ("fica", "fica"),
    ("stateIncome", "state_income"),
    ("statePayroll", "state_payroll"),
    ("local_", "local"),
    ("total", "total"),
    ("net", "net"),
    ("effectiveRate", "effective_rate"),
)


def test_the_fixture_covers_what_it_claims():
    """A fixture that silently shrank would make every assertion below vacuous."""
    assert FIXTURE["caseCount"] == len(CASES)
    assert len(CASES) > 2000
    assert len({c["state"] for c in CASES}) == 51
    assert {c["local"] for c in CASES} == {None, "NYC", "PHL"}


def test_every_figure_matches_the_javascript_engine():
    mismatches = []

    for case in CASES:
        got = total_tax(case["gross"], case["state"], case["local"])
        for key, attr in FIELDS:
            want = case[key]
            mine = getattr(got, attr)
            if mine != want:
                mismatches.append(
                    "{state} {gross} {local}: {field} want {want!r} got {mine!r} (delta {d!r})".format(
                        state=case["state"],
                        gross=case["gross"],
                        local=case["local"] or "no-local",
                        field=key,
                        want=want,
                        mine=mine,
                        d=mine - want,
                    )
                )

    assert not mismatches, "{} of {} figures diverged:\n  {}".format(
        len(mismatches),
        len(CASES) * len(FIELDS),
        "\n  ".join(mismatches[:20]),
    )


def test_payroll_detail_matches_line_for_line():
    """The total can be right while the breakdown that explains it is wrong."""
    for case in CASES:
        got = total_tax(case["gross"], case["state"], case["local"])
        want = [(label, amount) for label, amount in case["payrollDetail"]]
        mine = [(item.label, item.amount) for item in got.state_payroll_detail]
        assert mine == want, "{} at {}".format(case["state"], case["gross"])


@pytest.mark.parametrize("state", ["TX", "WA", "FL", "TN", "NV"])
def test_no_income_tax_states_still_pay_payroll(state):
    """Guards the port against 'no brackets' quietly becoming 'no tax at all'."""
    got = total_tax(120_000, state)
    assert got.state_income == 0
    assert got.federal > 0
    assert got.fica > 0
