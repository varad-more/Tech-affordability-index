"""
The build step: what ``dist/`` must contain before it is safe to publish.

A static deploy fails differently from a server. A server that cannot start
takes the site down loudly and immediately; a bad freeze publishes successfully
and is simply wrong — a 404 body written into ``index.html``, a missing CNAME, a
canonical tag naming a host nobody owns. Nothing goes red. Someone notices weeks
later, if at all.

This project already has form for exactly that failure: an ingest whose
exception handler swallowed a dead URL, so every number on the site came from
four hardcoded fallback rows for months while the build stayed green.

So the freeze is checked here rather than trusted, and the browser suite then
grades the same directory end to end.
"""

import json
from pathlib import Path

import pytest

from scripts.freeze import DEFAULT_ORIGIN, freeze

ORIGIN = "https://frozen.example"
DOMAIN = "frozen.example"

PAGES = {
    "index.html": "/",
    "states/index.html": "/states/",
    "timing/index.html": "/timing/",
    "method/index.html": "/method/",
}


@pytest.fixture(scope="module")
def dist(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist")
    freeze(out, ORIGIN, DOMAIN)
    return out


class TestLayout:
    @pytest.mark.parametrize("path", sorted(PAGES))
    def test_every_page_is_written_as_a_directory_index(self, dist, path):
        """``/states/`` has to be a directory, or its trailing slash is a 404 and
        every relative link inside it resolves one level too high."""
        page = dist / path
        assert page.exists(), path
        assert "<title>" in page.read_text(encoding="utf-8")

    def test_the_site_keeps_its_own_404_page(self, dist):
        """Pages serves /404.html for any unmatched path. Without this file the
        visitor gets GitHub's 404 instead of the site's."""
        body = (dist / "404.html").read_text(encoding="utf-8")
        assert "There is nothing at this address" in body

    def test_cname_claims_the_domain(self, dist):
        """The file that took the site down by not existing.

        GitHub routes a custom domain to whichever repository declares it. With
        no CNAME the subdomain resolves to GitHub, nothing claims it, and GitHub
        answers 404 — which is exactly what the live site did.
        """
        assert (dist / "CNAME").read_text(encoding="utf-8").strip() == DOMAIN

    def test_nojekyll_is_present(self, dist):
        """Without it Pages runs the output through Jekyll, which silently drops
        every file whose name starts with an underscore."""
        assert (dist / ".nojekyll").exists()

    def test_assets_and_data_are_copied(self, dist):
        assert (dist / "assets" / "engine.js").exists()
        assert (dist / "assets" / "styles.css").exists()
        assert (dist / "data" / "us-basemap.json").exists()
        assert (dist / "assets" / "fonts").is_dir()

    def test_the_bundle_is_written_and_is_strict_json(self, dist):
        names = sorted(p.stem for p in (dist / "bundle").glob("*.json"))
        assert "meta" in names and "places" in names and "timing" in names
        assert "counties-zori-all" in names
        assert "counties-acs-br1" in names

        for path in (dist / "bundle").glob("*.json"):
            # Fails on NaN and Infinity, which are valid JavaScript and invalid
            # JSON — they would survive a fetch and break anything strict.
            json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject)


class TestOrigin:
    @pytest.mark.parametrize("path,url", sorted(PAGES.items()))
    def test_every_canonical_names_the_origin_it_was_built_with(self, dist, path, url):
        body = (dist / path).read_text(encoding="utf-8")
        assert '<link rel="canonical" href="{}{}"'.format(ORIGIN, url) in body

    def test_robots_and_sitemap_agree(self, dist):
        assert ORIGIN in (dist / "robots.txt").read_text(encoding="utf-8")
        sitemap = (dist / "sitemap.xml").read_text(encoding="utf-8")
        for url in PAGES.values():
            assert "<loc>{}{}</loc>".format(ORIGIN, url) in sitemap

    def test_the_bundle_advertises_the_same_origin(self, dist):
        meta = json.loads((dist / "bundle" / "meta.json").read_text(encoding="utf-8"))
        assert meta["siteOrigin"] == ORIGIN

    def test_a_staging_build_leaks_no_production_urls(self, dist):
        """The reason robots.txt and sitemap.xml are rendered, not copied."""
        for name in ("robots.txt", "sitemap.xml"):
            assert "varadmore.me" not in (dist / name).read_text(encoding="utf-8")


class TestNothingStaleSurvives:
    def test_no_page_or_script_still_calls_the_deleted_api(self, dist):
        """The JSON API is gone. A leftover ``/api/...`` call would fail silently
        in a browser and leave a panel permanently empty."""
        offenders = []
        for path in list(dist.rglob("*.html")) + list(dist.rglob("*.js")):
            text = path.read_text(encoding="utf-8", errors="ignore")
            for line_no, line in enumerate(text.splitlines(), 1):
                # Prose in a comment may still describe the old design; a fetch
                # of one is what matters.
                if "'/api/" in line or '"/api/' in line or "`/api/" in line:
                    offenders.append("{}:{}".format(path.relative_to(dist), line_no))
        assert not offenders, "still calling the removed API: {}".format(offenders)

    def test_no_page_links_to_a_html_address(self, dist):
        """The site moved to clean URLs. The tempting fix for a stray .html link
        is to add the alias back rather than to correct the link."""
        for path in dist.rglob("*.html"):
            body = path.read_text(encoding="utf-8")
            assert 'href="/timing.html"' not in body
            assert 'href="/method.html"' not in body


def test_the_default_origin_is_the_domain_the_repository_claims():
    """One definition of where the site lives, so the head tags and the CNAME
    cannot drift apart."""
    assert DEFAULT_ORIGIN == "https://affordability-index.varadmore.me"


def _reject(value):
    raise ValueError("non-finite JSON constant: {}".format(value))
