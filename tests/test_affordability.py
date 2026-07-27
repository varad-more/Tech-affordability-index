"""
Affordability, ported from test/affordability.test.mjs.

Includes the block that pins the prose: the pages make specific factual claims
about the reference offers, and if the profile data is edited so a claim stops
holding, these fail and flag the copy as stale. A sentence the numbers no longer
support is a correctness bug, not a wording nit.
"""

import json
from pathlib import Path

import pytest

from app.affordability import (
    COST_BURDENED_THRESHOLD,
    affordability,
    burden_level,
    gross_for_year,
    rank_locations,
)
from app.tax import total_tax

DATA = Path(__file__).resolve().parent.parent / "data"

PROFILE = {
    "baseSalary": 185_000,
    "rsuGrant": 350_000,
    "vesting": [0.33, 0.33, 0.22, 0.12],
    "bonuses": [27_750, 27_750, 27_750, 27_750],
    "equityHaircut": 0.85,
}

CENT = 0.01


class TestGrossForYear:
    def test_adds_bonus_and_haircut_adjusted_vested_equity_to_base(self):
        assert gross_for_year(PROFILE, 0) == pytest.approx(
            185_000 + 27_750 + 350_000 * 0.33 * 0.85, abs=CENT
        )

    def test_follows_the_vesting_schedule_year_by_year(self):
        """Front-loaded grant: year 1 vests more than year 4."""
        assert gross_for_year(PROFILE, 0) > gross_for_year(PROFILE, 3)

    def test_years_beyond_the_schedule_contribute_no_equity_or_bonus(self):
        assert gross_for_year(PROFILE, 99) == PROFILE["baseSalary"]

    def test_a_haircut_of_zero_removes_equity_entirely(self):
        """Illiquid startup paper."""
        illiquid = dict(PROFILE, equityHaircut=0)
        assert gross_for_year(illiquid, 0) == pytest.approx(185_000 + 27_750, abs=CENT)


class TestAffordability:
    RENT = 1800

    def test_headline_ratio_uses_base_salary_only(self):
        r = affordability(PROFILE, self.RENT, "TX")
        expected_net = total_tax(PROFILE["baseSalary"], "TX").net / 12

        assert r.base_monthly_net == pytest.approx(expected_net, abs=CENT)
        assert r.base_ratio == pytest.approx(self.RENT / expected_net, abs=CENT)

    def test_counting_equity_lowers_the_ratio_below_the_base_only_headline(self):
        r = affordability(PROFILE, self.RENT, "TX")
        assert r.years[0].ratio < r.base_ratio, (
            "total comp should make rent a smaller share than base alone"
        )

    def test_produces_one_entry_per_vesting_year(self):
        assert len(affordability(PROFILE, self.RENT, "TX").years) == 4

    def test_a_higher_tax_state_yields_a_worse_ratio_at_identical_rent(self):
        tx = affordability(PROFILE, 2500, "TX")
        nyc = affordability(PROFILE, 2500, "NY", "NYC")
        assert nyc.base_ratio > tx.base_ratio, (
            "NYC take-home is lower, so rent bites harder"
        )

    def test_returns_none_rather_than_infinity_when_take_home_is_zero(self):
        broke = {"baseSalary": 0, "rsuGrant": 0, "vesting": [0], "bonuses": [0]}
        r = affordability(broke, self.RENT, "TX")
        assert r.base_ratio is None
        assert r.years[0].ratio is None

    def test_rent_of_zero_costs_nothing(self):
        assert affordability(PROFILE, 0, "TX").base_ratio == 0


class TestClaimsThePagesMakeAboutTheReferenceOffers:
    profiles = json.loads((DATA / "profiles.json").read_text(encoding="utf-8"))["profiles"]
    by_id = {p["id"]: p for p in profiles}

    def gross_y(self, profile_id, year):
        return gross_for_year(self.by_id[profile_id], year)

    def test_google_leads_amazon_in_year_one_but_is_overtaken_by_year_four(self):
        assert self.gross_y("google-l3", 0) > self.gross_y("amazon-sde1", 0), (
            "Google should lead in year 1"
        )
        assert self.gross_y("google-l3", 3) < self.gross_y("amazon-sde1", 3), (
            "Amazon should lead by year 4"
        )

    def test_googles_front_loaded_grant_makes_its_pay_decay(self):
        assert self.gross_y("google-l3", 3) < self.gross_y("google-l3", 0)

    def test_amazons_back_loaded_grant_makes_its_pay_climb(self):
        assert self.gross_y("amazon-sde1", 3) > self.gross_y("amazon-sde1", 0)

    @pytest.mark.parametrize(
        "profile_id", ["meta-e3", "apple-ict2", "microsoft-59", "netflix-l3"]
    )
    def test_the_evenly_vesting_offers_stay_flat(self, profile_id):
        """These vest 25% a year with a level bonus.

        The pages describe their year-one number as also being their year-four
        number, which only holds while the schedules stay even.
        """
        years = [self.gross_y(profile_id, y) for y in range(4)]
        swing = (max(years) - min(years)) / max(years)
        assert swing < 0.01, "{} swings {:.1f}%, expected flat".format(
            profile_id, swing * 100
        )

    def test_netflix_has_the_highest_base_salary(self):
        """Being almost entirely cash."""
        highest = max(self.profiles, key=lambda p: p["baseSalary"])
        assert highest["id"] == "netflix-l3"

    def test_the_startup_profile_counts_no_equity_at_all(self):
        assert self.by_id["startup-series-b"]["equityHaircut"] == 0
        assert self.gross_y("startup-series-b", 0) == (
            self.by_id["startup-series-b"]["baseSalary"]
        )

    def test_every_profile_carries_a_vesting_note_the_pages_render(self):
        for p in self.profiles:
            assert len(p.get("vestingNote", "")) > 20, "{} needs a vesting note".format(
                p["id"]
            )
            assert len(p.get("short", "")) > 0, "{} needs a short label".format(p["id"])


class TestBurdenLevel:
    @pytest.mark.parametrize(
        "ratio,expected",
        [
            (0.22, "ok"),
            (COST_BURDENED_THRESHOLD, "burdened"),
            (0.41, "burdened"),
            (0.5, "severe"),
            (None, "unknown"),
        ],
    )
    def test_classifies_against_the_hud_thresholds(self, ratio, expected):
        assert burden_level(ratio) == expected


class TestRankLocations:
    LOCATIONS = [
        {"city": "Expensive", "state": "CA", "rent": 3400},
        {"city": "Cheap", "state": "TX", "rent": 1600},
        {"city": "Middle", "state": "WA", "rent": 2200},
    ]

    def test_orders_cheapest_rent_burden_first(self):
        ranked = rank_locations(PROFILE, self.LOCATIONS)
        assert [r["location"]["city"] for r in ranked] == [
            "Cheap",
            "Middle",
            "Expensive",
        ]

    def test_does_not_mutate_the_input_list(self):
        before = [loc["city"] for loc in self.LOCATIONS]
        rank_locations(PROFILE, self.LOCATIONS)
        assert [loc["city"] for loc in self.LOCATIONS] == before
