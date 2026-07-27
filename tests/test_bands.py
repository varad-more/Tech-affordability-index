"""
Salary bands, ported from test/bands.test.mjs.

The interesting part is :func:`app.bands.gross_for_net`, which inverts the tax
engine by bisection. These assert the properties that make that valid — it
round-trips, it is monotonic, and it stays right across the wage cap where
take-home has a kink and an algebraic shortcut would go wrong.
"""

import json
from pathlib import Path

import pytest

from app.bands import (
    BANDS,
    assess,
    classify,
    gross_for_net,
    monthly_needs,
    salary_bands,
)
from app.tax import total_tax
from app.tax_data import STATES

DATA = Path(__file__).resolve().parent.parent / "data"

#: The bisection stops when the interval is under a cent, so agreement is
#: asserted to within a nickel rather than exactly.
TOL = 0.05


class TestGrossForNet:
    @pytest.mark.parametrize("state", ["CA", "TX", "NY", "WA", "MA"])
    def test_inverts_the_tax_engine(self, state):
        target = 90_000
        gross = gross_for_net(target, state)
        assert total_tax(gross, state).net == pytest.approx(target, abs=TOL)

    @pytest.mark.parametrize(
        "gross", [40_000, 75_000, 120_000, 184_500, 200_000, 350_000]
    )
    def test_round_trips_against_the_forward_direction(self, gross):
        net = total_tax(gross, "CA").net
        assert gross_for_net(net, "CA") == pytest.approx(gross, abs=TOL)

    def test_a_target_of_zero_or_less_needs_no_salary(self):
        assert gross_for_net(0, "TX") == 0
        assert gross_for_net(-5, "TX") == 0

    def test_a_higher_tax_jurisdiction_requires_a_higher_gross(self):
        tx = gross_for_net(100_000, "TX")
        ca = gross_for_net(100_000, "CA")

        assert ca > tx, "California should need more gross than Texas"
        assert gross_for_net(100_000, "NY", "NYC") > gross_for_net(100_000, "NY"), (
            "NYC adds city tax on top of NY"
        )

    @pytest.mark.parametrize("gross", [184_000, 184_500, 185_000])
    def test_stays_correct_across_the_social_security_wage_cap(self, gross):
        """The marginal rate changes here, so a closed form would go wrong."""
        net = total_tax(gross, "WA").net
        assert gross_for_net(net, "WA") == pytest.approx(gross, abs=TOL)

    def test_is_monotonic(self):
        previous = 0.0
        for target in range(20_000, 300_001, 10_000):
            gross = gross_for_net(target, "MN")
            assert gross > previous, "gross fell at target {}".format(target)
            previous = gross


class TestSalaryBands:
    RENT = 1700
    NON_HOUSING = 2000

    def ladder(self, rent=None, non_housing=None):
        return salary_bands(
            self.RENT if rent is None else rent,
            self.NON_HOUSING if non_housing is None else non_housing,
            "TX",
        )

    def test_needs_is_rent_plus_everything_else(self):
        assert monthly_needs(1700, 2000) == 3700
        assert self.ladder().monthly_needs == 3700

    def test_thresholds_ascend(self):
        b = self.ladder()
        assert b.survival < b.getting_by, "survival should be the lowest bar"
        assert b.getting_by < b.comfortable, "comfortable should be the highest bar"

    def test_at_the_survival_salary_take_home_exactly_covers_necessities(self):
        b = self.ladder()
        net = total_tax(b.survival, "TX").net / 12
        assert net == pytest.approx(b.monthly_needs, abs=TOL)

    def test_at_the_comfortable_salary_necessities_are_half_of_take_home(self):
        b = self.ladder()
        net = total_tax(b.comfortable, "TX").net / 12
        assert b.monthly_needs / net == pytest.approx(0.5, abs=0.001)

    def test_higher_rent_raises_every_threshold(self):
        cheap = self.ladder(rent=1200)
        dear = self.ladder(rent=3200)
        assert dear.survival > cheap.survival
        assert dear.comfortable > cheap.comfortable

    def test_non_housing_costs_move_the_thresholds_too(self):
        low = self.ladder(non_housing=1800)
        high = self.ladder(non_housing=2600)
        assert high.comfortable > low.comfortable, (
            "a place with pricier essentials must demand more at identical rent"
        )


class TestClassify:
    NEEDS = 4000

    @pytest.mark.parametrize(
        "net,expected",
        [
            (3000, "below-survival"),  # needs > net
            (4000, "survival"),  # needs = 100% of net
            (5000, "survival"),  # 80%
            (6000, "getting-by"),  # 66.7%
            (8000, "comfortable"),  # 50%
            (12000, "comfortable"),  # 33%
        ],
    )
    def test_places_a_salary_in_the_band_its_needs_share_falls_in(self, net, expected):
        assert classify(net, self.NEEDS).id == expected

    def test_boundaries_are_inclusive_of_the_easier_band(self):
        """Exactly 70% and exactly 50% land on the better side of each cut."""
        assert classify(self.NEEDS / 0.7, self.NEEDS).id == "getting-by"
        assert classify(self.NEEDS / 0.5, self.NEEDS).id == "comfortable"

    @pytest.mark.parametrize("net", [0, -100])
    def test_zero_or_negative_take_home_is_below_survival_not_an_error(self, net):
        assert classify(net, self.NEEDS).id == "below-survival"

    def test_every_band_carries_a_label_and_a_description(self):
        for band in BANDS:
            assert len(band.label) > 0, "{} needs a label".format(band.id)
            assert len(band.description) > 10, "{} needs a description".format(band.id)


class TestAssess:
    RENT = 3300
    NON_HOUSING = 2400

    def test_agrees_with_the_thresholds_it_reports(self):
        a = assess(200_000, self.RENT, self.NON_HOUSING, "CA")
        assert a.gross > a.bands.getting_by
        assert a.band.id in ("getting-by", "comfortable")

    def test_surplus_is_take_home_minus_necessities(self):
        a = assess(160_000, self.RENT, self.NON_HOUSING, "CA")
        assert a.monthly_surplus == pytest.approx(
            a.monthly_net - a.monthly_needs, abs=0.02
        )

    def test_a_salary_at_the_survival_threshold_classifies_as_survival(self):
        ladder = salary_bands(self.RENT, self.NON_HOUSING, "CA")
        assert assess(ladder.survival, self.RENT, self.NON_HOUSING, "CA").band.id == (
            "survival"
        )

    def test_a_salary_at_the_comfortable_threshold_classifies_as_comfortable(self):
        ladder = salary_bands(self.RENT, self.NON_HOUSING, "CA")
        assert assess(ladder.comfortable, self.RENT, self.NON_HOUSING, "CA").band.id == (
            "comfortable"
        )


class TestCoverageOfTheCommittedCountyData:
    """The map paints every county in the country.

    A state with no bracket table would throw at render time in someone's
    browser rather than here.
    """

    rents = json.loads((DATA / "county-rents.json").read_text(encoding="utf-8"))
    wages = json.loads((DATA / "county-living-wage.json").read_text(encoding="utf-8"))

    def test_every_state_in_the_county_rent_data_has_a_tax_table(self):
        missing = sorted(
            {c["state"] for c in self.rents["counties"]} - set(STATES)
        )
        assert missing == [], "no tax brackets for: {}".format(", ".join(missing))

    def test_all_50_states_plus_dc_are_modelled(self):
        assert len(STATES) == 51

    def test_every_priced_county_produces_a_finite_band(self):
        wage_by_fips = {c["fips"]: c["nonHousingMonthly"] for c in self.wages["counties"]}

        checked = 0
        for county in self.rents["counties"]:
            non_housing = wage_by_fips.get(county["fips"])
            if non_housing is None:
                continue
            band = classify(
                total_tax(150_000, county["state"]).net / 12,
                monthly_needs(county["rent"], non_housing),
            )
            assert band.id, "{}, {} produced no band".format(
                county["name"], county["state"]
            )
            checked += 1
        assert checked > 1200, "only {} counties were checkable".format(checked)

    def test_county_rents_and_costs_are_within_sane_bounds(self):
        for c in self.rents["counties"]:
            assert 200 < c["rent"] < 20_000, "{} rent ${}".format(c["name"], c["rent"])
            assert len(c["fips"]) == 5 and c["fips"].isdigit(), (
                "{} has a malformed FIPS {!r}".format(c["name"], c["fips"])
            )
        for c in self.wages["counties"]:
            assert 700 < c["nonHousingMonthly"] < 6000, "{} non-housing ${}".format(
                c["name"], c["nonHousingMonthly"]
            )
