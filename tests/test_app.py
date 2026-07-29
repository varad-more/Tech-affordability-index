"""
The application's routes: what it renders, and what it refuses to.

Flask renders this site but no longer serves it — ``scripts/freeze.py`` drives
these same routes at build time and writes the output to ``dist/``. So every
assertion here is really about the frozen artefact, one step upstream of it.
``tests/test_freeze.py`` checks that step; the browser suite then grades the
result end to end.

This suite exists because of a gap it found. Every other Python test imports a
maths module directly, so none of them import ``app/__init__.py`` or
``app/datasets.py`` at all — a NameError in either passed the whole unit suite
and only surfaced in the browser tests, which are slower and run last. An
application that cannot start should fail in the fastest suite, not the slowest.
"""

import pytest

from app import create_app

PAGES = ["/", "/states/", "/compare/", "/timing/", "/method/"]


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
    def test_every_page_carries_a_canonical_on_the_configured_origin(self, client, path):
        origin = client.application.config["SITE_ORIGIN"]
        body = res_text(client, path)
        assert '<link rel="canonical" href="{}{}"'.format(origin, path) in body

    def test_a_missing_page_is_a_404_with_the_real_404_page(self, client):
        """The freeze captures this response as ``404.html``, which is the file
        GitHub Pages serves for any unmatched path."""
        res = client.get("/nope/")
        assert res.status_code == 404
        assert b"There is nothing at this address" in res.data

    @pytest.mark.parametrize("bare,slashed", [("/states", "/states/"), ("/method", "/method/")])
    def test_a_missing_trailing_slash_redirects(self, client, bare, slashed):
        """Relative asset URLs inside the page resolve against the directory.

        Flask sends 308 and Pages sends 301; both are permanent, and the browser
        suite asserts the number the deploy target actually uses. What matters
        on both is the destination.
        """
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


class TestBundleRoutes:
    """Served live in development, written as files by the freeze.

    Both read the same functions in :mod:`app.bundle`, which is what stops a page
    behaving one way locally and another once deployed.
    """

    @pytest.mark.parametrize(
        "name",
        ["meta", "places", "timing", "counties-zori-all", "counties-acs-br1"],
    )
    def test_every_bundle_file_is_served(self, client, name):
        res = client.get("/bundle/{}.json".format(name))
        assert res.status_code == 200
        assert res.get_json()

    def test_meta_advertises_the_configured_origin(self, client):
        origin = client.application.config["SITE_ORIGIN"]
        assert client.get("/bundle/meta.json").get_json()["siteOrigin"] == origin

    @pytest.mark.parametrize(
        "name", ["nope", "counties", "counties-bogus-all", "counties-acs-penthouse"]
    )
    def test_an_unknown_bundle_file_is_a_404(self, client, name):
        """A silent empty object here would render a blank page rather than an
        error, which is the harder failure to notice."""
        res = client.get("/bundle/{}.json".format(name))
        assert res.status_code == 404
        assert "error" in res.get_json()


class TestCompression:
    def test_large_json_is_gzipped_for_clients_that_ask(self, client):
        res = client.get(
            "/bundle/counties-acs-all.json", headers={"Accept-Encoding": "gzip"}
        )
        assert res.headers.get("Content-Encoding") == "gzip"
        assert "Accept-Encoding" in res.headers.get("Vary", "")

    def test_a_client_that_does_not_ask_gets_plain_bytes(self, client):
        res = client.get("/bundle/counties-acs-all.json", headers={"Accept-Encoding": ""})
        assert "Content-Encoding" not in res.headers
        assert res.get_json()


def res_text(client, path):
    return client.get(path).get_data(as_text=True)
