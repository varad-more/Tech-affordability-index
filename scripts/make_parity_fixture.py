"""
Generate the fixture that proves the browser agrees with Python.

The static build moved a small amount of arithmetic into JavaScript: evaluating
the published tax curves, dividing needs by take-home, and comparing the result
against thresholds Python published. No constant moved — but the *code* did, and
two implementations of anything is how a map and a verdict start disagreeing.

So the agreement is demonstrated rather than reviewed, the same way the original
JavaScript-to-Python port was. This writes down what Python says for a grid of
cases; ``e2e/site.spec.mjs`` makes the browser answer the same questions and
compares. Neither side can be quietly edited into agreement, because the fixture
is checked against Python by ``tests/test_derivation_parity.py`` and against the
browser by the suite.

Comparison is **exact**, not tolerant. Every operation involved is +, -, * or /
on doubles, all of which IEEE 754 pins exactly, and both sides deliberately
perform them in the same order. A tolerance here would absorb precisely the
kind of change worth catching.

Regenerate with::

    python scripts/make_parity_fixture.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from app.affordability import affordability, burden_level  # noqa: E402
from app.bands import (  # noqa: E402
    BANDS,
    NEEDS_SHARE_BREAKS,
    classify,
    gross_for_net,
    needs_share_step,
    salary_bands,
)
from app.bundle import LOCAL_BY_FIPS, local_for  # noqa: E402
from app.datasets import data  # noqa: E402
from app.net_curve import liability  # noqa: E402
from app.tax_data import LOCAL, STATES  # noqa: E402

FIXTURE = REPO_ROOT / "e2e" / "fixtures" / "derivation.json"

#: Every jurisdiction the site can price.
JURISDICTIONS = [(code, None) for code in sorted(STATES)] + [
    (locality.state, code) for code, locality in sorted(LOCAL.items())
]

#: Wages spanning what the site serves, plus the kinks that are easy to get
#: wrong: the Social Security wage base, the Additional Medicare threshold, and
#: zero.
SALARIES = [
    0, 1, 15_000, 42_500, 63_000, 88_888.88, 120_000, 156_000,
    184_500, 200_000, 265_000, 450_000, 1_200_000,
]

#: Counties chosen to exercise the cases that differ: a city tax, a state with
#: payroll levies, a no-income-tax state, and the cheapest end of the range.
COUNTIES = [
    "36061",  # New York County — city tax on state-taxable income
    "42101",  # Philadelphia — city tax on gross
    "06075",  # San Francisco — high rent, high state tax
    "53033",  # King — no state income tax, two payroll levies
    "48201",  # Harris — no state income tax at all
    "01001",  # Autauga — the cheap end
    "11001",  # District of Columbia — the single-county state
]


def build() -> dict:
    return {
        "liability": _liability_cases(),
        "grossForNet": _gross_for_net_cases(),
        "steps": _step_cases(),
        "classify": _classify_cases(),
        "salaryBands": _salary_band_cases(),
        "rank": _rank_cases(),
    }


def _liability_cases():
    out = []
    for state, local in JURISDICTIONS:
        for gross in SALARIES:
            result = liability(gross, state, local)
            out.append(
                {
                    "state": state,
                    # `localCode` rather than `local`: the result carries a field
                    # called `local` holding the city tax *amount*, and naming
                    # both the same thing meant the amount silently overwrote the
                    # jurisdiction in the dict literal.
                    "localCode": local,
                    "gross": gross,
                    "federal": result.federal,
                    "fica": result.fica,
                    "stateIncome": result.state_income,
                    "statePayroll": result.state_payroll,
                    "statePayrollDetail": [
                        {"label": label, "amount": amount}
                        for label, amount in result.state_payroll_detail
                    ],
                    "local": result.local,
                    "total": result.total,
                    "net": result.net,
                    "effectiveRate": result.effective_rate,
                }
            )
    return out


def _gross_for_net_cases():
    out = []
    for state, local in JURISDICTIONS:
        for target in (0, 1, 25_000, 48_000, 96_000, 175_000, 500_000):
            out.append(
                {
                    "state": state,
                    "local": local,
                    "target": target,
                    "gross": gross_for_net(target, state, local),
                }
            )
    return out


def _step_cases():
    """Every class break, and both sides of it.

    An off-by-one in a `<=` here moves a county one shade on the map and one
    sentence in the verdict, which is a change nobody would notice by looking.
    """
    shares = [0.0, -1.0, 5.0]
    for value in NEEDS_SHARE_BREAKS:
        shares += [value, value - 1e-12, value + 1e-12, value - 0.001, value + 0.001]
    return [{"share": share, "step": needs_share_step(share)} for share in shares]


def _classify_cases():
    out = []
    # Straddles every band ceiling, including the zero and negative take-home
    # cases where the answer is the open-ended band rather than an error.
    for monthly_net in (0, -100, 1_000, 2_500, 4_200, 9_000):
        for needs in (500, 1_250, 2_100, 3_400, 6_000):
            out.append(
                {
                    "monthlyNet": monthly_net,
                    "needs": needs,
                    "bandId": classify(monthly_net, needs).id,
                }
            )
    return out


def _salary_band_cases():
    out = []
    for fips in COUNTIES:
        county = data.counties_by_fips[fips]
        state = county["st"]
        local = local_for(fips)
        non_housing = data.non_housing_for(fips)
        for basis in ("zori", "acs"):
            rent = data.rent_for(fips, basis, "all")
            if rent is None or non_housing is None:
                continue
            ladder = salary_bands(rent, non_housing, state, local)
            out.append(
                {
                    "fips": fips,
                    "basis": basis,
                    "state": state,
                    "local": local,
                    "rent": rent,
                    "nonHousingMonthly": non_housing,
                    "monthlyNeeds": ladder.monthly_needs,
                    "annualNeeds": ladder.annual_needs,
                    "survival": ladder.survival,
                    "gettingBy": ladder.getting_by,
                    "comfortable": ladder.comfortable,
                }
            )
    return out


def _rank_cases():
    """The compensation model: vesting, the equity haircut, and the burden bands.

    Included because it is the one derivation whose inputs are editable on the
    page, so the browser has to compute it rather than read a precomputed answer.
    """
    out = []
    for profile in data.profiles["profiles"]:
        for hub in data.rents["hubs"]:
            result = affordability(profile, hub["rent"], hub["state"], hub.get("local"))
            out.append(
                {
                    "profileId": profile["id"],
                    "hub": hub.get("city") or hub.get("metro"),
                    "rent": hub["rent"],
                    "state": hub["state"],
                    "local": hub.get("local"),
                    "baseRatio": result.base_ratio,
                    "baseMonthlyNet": result.base_monthly_net,
                    "burden": burden_level(result.base_ratio),
                    "years": [
                        {
                            "year": y.year,
                            "gross": y.gross,
                            "monthlyNet": y.monthly_net,
                            "ratio": y.ratio,
                        }
                        for y in result.years
                    ],
                }
            )
    return out


def main() -> None:
    fixture = build()
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture, indent=1, allow_nan=False) + "\n", encoding="utf-8")

    counts = ", ".join("{} {}".format(len(v), k) for k, v in fixture.items())
    print("wrote {} ({})".format(FIXTURE.relative_to(REPO_ROOT), counts))
    print("bands: {}  breaks: {}  jurisdictions: {}".format(
        len(BANDS), len(NEEDS_SHARE_BREAKS), len(JURISDICTIONS)
    ))
    assert set(LOCAL_BY_FIPS.values()) <= set(LOCAL)


if __name__ == "__main__":
    main()
