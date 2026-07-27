"""
The application itself: routes, the API, and the contracts the client depends on.

This suite exists because of a gap it found. Every other test here imports a
maths module directly, so none of them import ``app/__init__.py``, ``app/api.py``
or ``app/datasets.py`` at all — a NameError in any of those passed the whole
unit suite and only surfaced in the browser tests, which are slower and run
last. An application that cannot start should fail in the fastest suite, not the
slowest one.
"""

import json

import pytest

from app import create_app
from app.bands import BANDS
from app.tax_data import STATES

PAGES = ["/", "/states/", "/timing/", "/method/"]


@pytest.fixture(scope="module")
def client():
    return create_app({"TESTING": True}).test_client()


class TestPages:
    @pytest.mark.parametrize("path", PAGES)
    def test_every_page_renders(self, client, path):
        res = client.get(path)
        assert res.status_code == 200
        assert b"<title>" in res.data

    @pytest.mark.parametrize("path", PAGES)
    def test_every_page_carries_a_canonical_on_the_configured_origin(
        self, client, path
    ):
        origin = client.application.config["SITE_ORIGIN"]
        body = res_text(client, path)
        assert '<link rel="canonical" href="{}{}"'.format(origin, path) in body

    def test_a_missing_page_is_a_404_with_the_real_404_page(self, client):
        res = client.get("/nope/")
        assert res.status_code == 404
        assert b"There is nothing at this address" in res.data

    @pytest.mark.parametrize("bare,slashed", [("/states", "/states/"), ("/method", "/method/")])
    def test_a_missing_trailing_slash_redirects(self, client, bare, slashed):
        """Relative asset URLs inside the page resolve against the directory."""
        res = client.get(bare)
        assert res.status_code in (301, 308)
        assert res.headers["Location"].endswith(slashed)

    def test_robots_and_sitemap_name_the_configured_origin(self, client):
        origin = client.application.config["SITE_ORIGIN"]
        robots = res_text(client, "/robots.txt")
        sitemap = res_text(client, "/sitemap.xml")

        assert "{}/sitemap.xml".format(origin) in robots
        for path in PAGES:
            assert "<loc>{}{}</loc>".format(origin, path) in sitemap
        assert ".html" not in sitemap

    def test_a_staging_origin_does_not_advertise_production_urls(self):
        """The whole reason these are rendered rather than served flat."""
        staging = create_app(
            {"TESTING": True, "SITE_ORIGIN": "https://staging.example"}
        ).test_client()
        assert "https://staging.example/sitemap.xml" in res_text(staging, "/robots.txt")
        assert "varadmore.me" not in res_text(staging, "/sitemap.xml")


class TestMeta:
    def test_carries_everything_the_pages_boot_from(self, client):
        meta = client.get("/api/meta").get_json()
        for key in (
            "siteOrigin", "taxYear", "states", "bands", "needsShareBreaks",
            "needsShareClasses", "categoryOrder", "categoryLabels", "monthNames",
            "federal", "fica", "modelledLocalTax", "unmodelledLocalTax",
        ):
            assert key in meta, "missing {}".format(key)

    def test_states_are_shaped_the_way_the_client_reads_them(self, client):
        """STATES[code].name, .brackets, .standardDeduction, .payroll.

        Flattening this to {code: name} rendered every state name on two pages
        as "undefined" and threw in the By-state tax panel.
        """
        states = client.get("/api/meta").get_json()["states"]
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

    def test_band_definitions_match_the_engine(self, client):
        meta = client.get("/api/meta").get_json()
        assert [b["id"] for b in meta["bands"]] == [b.id for b in BANDS]
        # Infinity has no JSON spelling; the open-ended band arrives as null.
        assert meta["bands"][0]["maxNeedsShare"] is None


class TestSnapshot:
    def test_prices_every_county_it_can(self, client):
        j = client.get("/api/snapshot?salary=156000&basis=acs&unit=all").get_json()
        assert len(j["counties"]) > 3000
        assert j["withRent"] == len(j["counties"])

    def test_rows_are_positional_and_complete(self, client):
        j = client.get("/api/snapshot?salary=156000&basis=zori").get_json()
        step, needs, share, band_index, net = j["counties"]["06075"]
        assert 0 <= step <= 6
        assert needs > 0 and net > 0
        assert share == pytest.approx(needs / net)
        assert 0 <= band_index < len(j["bands"])

    def test_take_home_includes_city_tax_where_one_is_modelled(self, client):
        """The bug this endpoint was built to fix.

        The map painted every county on state-only tax while the tooltip over
        the same county included city tax, so New York City read one way in the
        fill and another on hover.
        """
        j = client.get("/api/snapshot?salary=156000&basis=acs&unit=all").get_json()
        manhattan_net = j["counties"]["36061"][4]
        ny_state_net = j["netByState"]["NY"]
        assert manhattan_net < ny_state_net, "NYC city tax is not being applied"
        assert ny_state_net - manhattan_net > 300, "the gap is materially large"

    def test_the_unit_size_changes_the_answer_on_acs(self, client):
        """Ignoring `unit` was worth $222/month on King County."""
        all_beds = client.get("/api/snapshot?salary=156000&basis=acs&unit=all").get_json()
        one_bed = client.get("/api/snapshot?salary=156000&basis=acs&unit=br1").get_json()
        assert all_beds["counties"]["53033"][1] != one_bed["counties"]["53033"][1]

    def test_the_unit_size_is_ignored_on_zori(self, client):
        """ZORI publishes no bedroom split, so the site never offers one."""
        a = client.get("/api/snapshot?salary=156000&basis=zori&unit=all").get_json()
        b = client.get("/api/snapshot?salary=156000&basis=zori&unit=br1").get_json()
        assert a["counties"] == b["counties"]

    def test_a_higher_salary_never_makes_a_county_harder(self, client):
        low = client.get("/api/snapshot?salary=80000&basis=zori").get_json()
        high = client.get("/api/snapshot?salary=250000&basis=zori").get_json()
        for fips, row in high["counties"].items():
            assert row[0] <= low["counties"][fips][0], fips


class TestStateDetail:
    def test_answers_the_whole_by_state_page(self, client):
        j = client.get("/api/state/CA?salary=130000&basis=acs&unit=br1").get_json()
        assert j["available"] is True
        assert j["rollup"]["n"] == len(j["counties"])
        assert j["rollup"]["cheapest"]["needs"] <= j["rollup"]["median"]["needs"]
        assert j["rollup"]["median"]["needs"] <= j["rollup"]["dearest"]["needs"]
        assert j["bands"]["comfortable"] > j["bands"]["survival"]
        for county in j["counties"]:
            assert county["comfortable"] > 0

    def test_a_single_county_state_reports_no_spread(self, client):
        """DC has one county. A spread of 1.0 would claim it was measured and
        found to be one market; it has not been measured."""
        j = client.get("/api/state/DC?salary=130000&basis=acs").get_json()
        assert j["rollup"]["n"] == 1
        assert j["rollup"]["spread"] is None

    def test_an_unknown_state_is_a_404(self, client):
        assert client.get("/api/state/ZZ").status_code == 404


class TestRank:
    def test_without_a_profile_it_answers_for_all_of_them(self, client):
        j = client.get("/api/rank").get_json()
        assert len(j["profiles"]) == 7
        assert j["hubCount"] > 15

    def test_rows_ascend_by_burden(self, client):
        rows = client.get("/api/rank?profile=google-l3").get_json()["rows"]
        ratios = [r["baseRatio"] for r in rows if r["baseRatio"] is not None]
        assert ratios == sorted(ratios)

    def test_overrides_apply_on_top_of_the_named_preset(self, client):
        base = client.get("/api/rank?profile=google-l3").get_json()
        raised = client.get("/api/rank?profile=google-l3&baseSalary=250000").get_json()
        assert raised["rows"][0]["baseRatio"] < base["rows"][0]["baseRatio"]
        # The vesting schedule stays the preset's, not the client's.
        assert raised["profile"]["vesting"] == base["profile"]["vesting"]

    def test_only_the_first_year_bonus_is_overridable(self, client):
        j = client.get("/api/rank?profile=google-l3&bonus0=50000").get_json()
        assert j["profile"]["bonuses"][0] == 50000
        assert j["profile"]["bonuses"][1] != 50000

    def test_an_unknown_profile_is_a_404(self, client):
        assert client.get("/api/rank?profile=nope").status_code == 404


class TestAssess:
    def test_answers_for_one_county(self, client):
        j = client.get("/api/assess?fips=06075&salary=156000&basis=zori").get_json()
        assert j["available"] is True
        assert j["name"] == "San Francisco County"
        assert j["monthlyNeeds"] == pytest.approx(j["rent"] + j["nonHousingMonthly"])
        assert j["monthlySurplus"] == pytest.approx(j["monthlyNet"] - j["monthlyNeeds"])
        assert j["band"]["id"] in {b.id for b in BANDS}

    def test_a_county_with_no_published_rent_is_an_answer_not_an_error(self, client):
        """"No figure is published here" is a real answer and the pages draw it.

        Barbour County, AL is in the basemap and has an MIT budget, but Zillow
        does not index it — so on the ZORI basis it is unpriceable, and says so
        rather than 404ing or being shaded as cheap.
        """
        j = client.get("/api/assess?fips=01005&basis=zori").get_json()
        assert j["available"] is False
        assert j["missing"] == "rent"
        assert j["name"] == "Barbour County"

    def test_a_county_missing_the_other_half_says_so_too(self, client):
        """Connecticut is the mirror image, and the reason it is unshaded.

        Its counties carry a Zillow rent under the pre-2022 FIPS the basemap
        uses, but MIT publishes no budget against those codes — so the missing
        half is the non-housing figure, not the rent.
        """
        j = client.get("/api/assess?fips=09001&basis=zori").get_json()
        assert j["available"] is False
        assert j["missing"] == "nonHousing"

    def test_an_unknown_county_is_a_404(self, client):
        assert client.get("/api/assess?fips=99999").status_code == 404


class TestBadInput:
    """A silent fallback here would show ACS figures under a ZORI label."""

    @pytest.mark.parametrize(
        "query",
        [
            "/api/snapshot?basis=bogus",
            "/api/snapshot?unit=penthouse",
            "/api/snapshot?salary=abc",
            "/api/assess?fips=06075&basis=bogus",
            "/api/states?basis=bogus",
        ],
    )
    def test_rejected_rather_than_defaulted(self, client, query):
        res = client.get(query)
        assert res.status_code == 400
        assert "error" in res.get_json()

    def test_assess_without_a_fips_is_rejected(self, client):
        assert client.get("/api/assess").status_code == 400


def res_text(client, path):
    return client.get(path).get_data(as_text=True)
