"""
The precomputed data the browser reads, and the decisions baked into it.

These assertions mostly predate the static build — they were written against the
JSON API and moved here when it went away, because what they check is the model
rather than the transport. Which counties can be priced, whether the unit-size
selector reaches the numbers, whether New York City's tax is applied: those are
the same questions whether the answer arrives over HTTP or in a file.

What is new is that this bundle is now a published contract. The browser reads
positions out of these rows and keys off these names, so a change here is a
change to something two languages agree on.
"""

import json
import math

import pytest

from app import bundle
from app.bands import BANDS
from app.datasets import data
from app.tax import total_tax
from app.tax_data import LOCAL, STATES


@pytest.fixture(scope="module")
def meta():
    return bundle.meta("https://example.test")


@pytest.fixture(scope="module")
def zori():
    return bundle.counties("zori", "all")


@pytest.fixture(scope="module")
def acs():
    return bundle.counties("acs", "all")


class TestMeta:
    def test_carries_everything_the_pages_boot_from(self, meta):
        for key in (
            "siteOrigin", "taxYear", "states", "bands", "needsShareBreaks",
            "needsShareClasses", "categoryOrder", "categoryLabels", "monthNames",
            "federal", "fica", "modelledLocalTax", "unmodelledLocalTax",
            "localByFips", "curves",
        ):
            assert key in meta, "missing {}".format(key)

    def test_states_are_shaped_the_way_the_client_reads_them(self, meta):
        """STATES[code].name, .brackets, .standardDeduction, .payroll.

        Flattening this to {code: name} once rendered every state name on two
        pages as "undefined" and threw in the By-state tax panel.
        """
        states = meta["states"]
        assert len(states) == 51
        for code, state in states.items():
            assert isinstance(state, dict), "{} is not an object".format(code)
            assert state["name"]
            assert isinstance(state["brackets"], list)
            assert isinstance(state["payroll"], list)
            assert "standardDeduction" in state
        # `from`, not `lower`: the field is only called `lower` in Python because
        # `from` is a keyword there.
        assert set(states["CA"]["brackets"][0]) == {"from", "rate"}

    def test_band_definitions_match_the_engine(self, meta):
        assert [b["id"] for b in meta["bands"]] == [b.id for b in BANDS]
        # Infinity has no JSON spelling; the open-ended band arrives as null.
        assert meta["bands"][0]["maxNeedsShare"] is None

    def test_the_city_tax_map_names_the_counties_it_applies_to(self, meta):
        """Five boroughs and Philadelphia, keyed by FIPS rather than by name.

        The browser has to attribute a county to a tax jurisdiction without
        knowing anything about tax, and matching on a place name would be wrong
        for both cities.
        """
        assert set(meta["localByFips"]) == {
            "36005", "36047", "36061", "36081", "36085", "42101",
        }
        assert set(meta["localByFips"].values()) <= set(LOCAL)

    def test_the_curves_cover_every_jurisdiction(self, meta):
        curves = meta["curves"]
        assert set(curves["states"]) == set(STATES)
        assert set(curves["local"]) == set(LOCAL)
        # Shared rather than repeated fifty-three times: there is one federal
        # curve to be right, and it is most of why this file is kilobytes.
        assert curves["federal"]["knots"][0] == 0
        assert curves["fica"]["knots"][0] == 0

    def test_it_is_json_with_no_infinities_in_it(self, meta):
        """`allow_nan=False` is what the freeze writes with.

        A stray inf serialises to the literal `Infinity`, which is valid
        JavaScript and invalid JSON — so it would work when tested through a
        `fetch` and break the moment anything strict parsed it.
        """
        json.dumps(meta, allow_nan=False)


class TestCounties:
    def test_prices_every_county_it_can(self, acs):
        assert len(acs["counties"]) > 3000
        assert acs["withRent"] == len(acs["counties"])

    def test_rows_are_positional_and_complete(self, zori):
        """The browser reads these two positions. It is a contract, not a shape."""
        rent, non_housing = zori["counties"]["06075"]
        assert rent > 0 and non_housing > 0

    def test_the_unit_size_changes_the_answer_on_acs(self):
        """Ignoring `unit` was worth $222/month on King County."""
        all_beds = bundle.counties("acs", "all")
        one_bed = bundle.counties("acs", "br1")
        assert all_beds["counties"]["53033"] != one_bed["counties"]["53033"]

    def test_zori_serves_one_file_for_every_unit_size(self):
        """ZORI publishes no bedroom split, so five identical files would be five
        chances to fall out of step."""
        assert bundle.get("counties-zori-br1") == bundle.get("counties-zori-all")

    def test_every_priced_county_has_a_name_and_a_state(self, acs, zori):
        places = bundle.places()
        for file in (acs, zori):
            for fips in file["counties"]:
                name, state = places[fips]
                assert name, fips
                assert state in STATES, fips

    def test_a_county_missing_rent_says_so_rather_than_being_priced_as_cheap(self, zori):
        """Barbour County, AL is in the basemap and has an MIT budget, but Zillow
        does not index it — so on the ZORI basis it is unpriceable."""
        assert "01005" not in zori["counties"]
        assert "01005" in zori["missingRent"]

    def test_a_county_missing_the_other_half_says_so_too(self, zori):
        """Connecticut is the mirror image, and the reason it is unshaded.

        Its counties carry a Zillow rent under the pre-2022 FIPS the basemap
        uses, but MIT publishes no budget against those codes — so the missing
        half is the non-housing figure, not the rent.
        """
        assert "09001" not in zori["counties"]
        assert "09001" in zori["missingNonHousing"]

    def test_the_two_missing_lists_partition_everything_unpriced(self, zori):
        """No county may be absent without a reason, or claim two of them.

        The page prints a different sentence for each, so an overlap would be a
        county that is both, and a gap would be one that vanished silently.
        """
        priced = set(zori["counties"])
        missing_rent = set(zori["missingRent"])
        missing_nh = set(zori["missingNonHousing"])

        assert not (missing_rent & missing_nh)
        assert priced | missing_rent | missing_nh == set(data.counties_by_fips)
        assert not (priced & (missing_rent | missing_nh))

    def test_an_unknown_basis_or_unit_is_rejected_not_defaulted(self):
        """A silent fallback here would show ACS figures under a ZORI label."""
        with pytest.raises(ValueError):
            bundle.counties("bogus", "all")
        with pytest.raises(ValueError):
            bundle.counties("acs", "penthouse")


class TestRollups:
    def test_every_state_with_counties_gets_one(self, acs):
        for code, rollup in acs["states"].items():
            assert rollup["n"] >= 1, code
            assert rollup["cheapest"]["needs"] <= rollup["median"]["needs"], code
            assert rollup["median"]["needs"] <= rollup["dearest"]["needs"], code

    @pytest.mark.parametrize("basis", ["zori", "acs"])
    def test_connecticut_is_the_only_state_with_no_rollup_at_all(self, basis):
        """Named rather than counted, because the reason is specific and fixable.

        The basemap uses Connecticut's pre-2022 eight-county FIPS; both rent
        sources publish against the planning-region codes that replaced them. So
        every Connecticut county fails the join on both bases, which is why the
        state is blank on the map.

        A bare `== 50` would pass just as well if some other state silently
        dropped out. If a data refresh ever fixes Connecticut, this fails and
        says so, which is the right way round.
        """
        missing = set(STATES) - set(bundle.counties(basis, "all")["states"])
        assert missing == {"CT"}

    def test_a_single_county_state_reports_no_spread(self, acs):
        """DC has one county. A spread of exactly 1.0 would claim it was measured
        and found to be a single market; it has not been measured."""
        dc = acs["states"]["DC"]
        assert dc["n"] == 1
        assert dc["spread"] is None


class TestCityTax:
    def test_new_york_city_is_taxed_differently_from_new_york_state(self):
        """The bug the jurisdiction key was introduced to fix.

        The map painted every county on state-only tax while the tooltip over
        the same county included city tax, so New York City read one way in the
        fill and another on hover.
        """
        salary = 156_000
        state_only = total_tax(salary, "NY").net
        with_city = total_tax(salary, "NY", "NYC").net

        assert with_city < state_only
        assert (state_only - with_city) / 12 > 300, "the monthly gap is material"

    def test_the_curve_carries_that_difference_into_the_browser(self, meta):
        """It is no use being right in Python if the published curve is not."""
        assert "NYC" in meta["curves"]["local"]
        assert any(v > 0 for v in meta["curves"]["local"]["NYC"]["values"])


class TestTiming:
    def test_prices_the_seasonal_swing_for_counties_that_have_one(self):
        timing = bundle.timing()
        assert timing["firstMonth"] and timing["lastMonth"]
        assert len(timing["savings"]) > 100

        for fips, saving in timing["savings"].items():
            assert saving["monthly"] > 0, fips
            assert saving["annual"] == pytest.approx(saving["monthly"] * 12)

    def test_a_county_without_enough_history_is_absent_rather_than_zero(self):
        """Zero would read as "measured, and found to have no seasonality"."""
        timing = bundle.timing()
        no_season = [
            fips
            for fips, county in data.history_by_fips.items()
            if not county.get("season")
        ]
        assert no_season, "fixture assumes some counties are too short to measure"
        for fips in no_season:
            assert fips not in timing["savings"]


class TestTheWholeBundle:
    def test_every_file_serialises_without_a_nan_or_an_infinity(self):
        for name, payload in bundle.files("https://example.test").items():
            try:
                json.dumps(payload, allow_nan=False)
            except ValueError as error:
                pytest.fail("{}.json is not strict JSON: {}".format(name, error))

    def test_get_answers_for_every_name_the_freeze_writes(self):
        for name in bundle.names():
            assert bundle.get(name) is not None, name

    def test_an_unknown_name_is_absent_rather_than_an_empty_file(self):
        for name in ("nope", "counties", "counties-zori", "counties-bogus-all", "../meta"):
            assert bundle.get(name) is None, name

    def test_it_stays_small_enough_to_ship(self):
        """Every one of these is fetched by a real person on a real connection."""
        for name, payload in bundle.files("https://example.test").items():
            size = len(json.dumps(payload, separators=(",", ":")))
            assert size < 200_000, "{}.json is {:,} bytes".format(name, size)
