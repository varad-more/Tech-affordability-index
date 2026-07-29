"""
Render the site to ``dist/`` as flat files, for GitHub Pages.

Pages serves files; it runs no code. So the Flask application is driven here
through its own test client, once per URL, and whatever it returns is written to
disk. Nothing is re-implemented for the static build — if a page renders wrong
in ``flask run`` it renders wrong here, which is the point.

Every response is checked for a 200. A freeze that silently wrote a 404 page to
``index.html`` would deploy successfully and be wrong, and that is exactly the
failure this project already has form for: an ingest whose exception handler hid
a broken URL for months. So this exits non-zero rather than publishing something
it could not verify.

Usage::

    python scripts/freeze.py                       # -> dist/
    python scripts/freeze.py --out build           # somewhere else
    python scripts/freeze.py --origin https://staging.example
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from app import create_app  # noqa: E402  (path set above)
from app import bundle  # noqa: E402

#: Where the site lives. One definition, imported by anything that needs it, so
#: the canonical tags, the sitemap and the CNAME file cannot drift apart.
DEFAULT_ORIGIN = "https://affordability-index.varadmore.me"

#: Pages that become directories, so ``/states/`` keeps its trailing slash and
#: every relative link inside it still resolves.
PAGES = ["/", "/states/", "/compare/", "/timing/", "/method/"]

#: Served from the site root, rendered rather than copied because both name the
#: site's own origin.
ROOT_FILES = ["/robots.txt", "/sitemap.xml"]

#: Copied verbatim.
ASSET_DIRS = ["assets", "data"]


def write(path: Path, content: bytes) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return len(content)


def freeze(out: Path, origin: str, domain: str) -> None:
    app = create_app({"SITE_ORIGIN": origin, "TESTING": True})
    client = app.test_client()

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    total = 0

    def fetch(url: str) -> bytes:
        res = client.get(url)
        if res.status_code != 200:
            raise SystemExit(
                "freeze: {} returned {}. Refusing to publish a page the "
                "application could not render.".format(url, res.status_code)
            )
        return res.get_data()

    # --- pages ----------------------------------------------------------
    for url in PAGES:
        body = fetch(url)
        target = out / "index.html" if url == "/" else out / url.strip("/") / "index.html"
        total += write(target, body)

    for url in ROOT_FILES:
        total += write(out / url.lstrip("/"), fetch(url))

    # The 404 handler is reached by asking for something that is not there. Pages
    # serves /404.html for any unmatched path, so the site keeps its own 404
    # rather than GitHub's.
    res = client.get("/this-path-does-not-exist/")
    if res.status_code != 404:
        raise SystemExit("freeze: expected a 404 handler, got {}".format(res.status_code))
    total += write(out / "404.html", res.get_data())

    # --- precomputed data -----------------------------------------------
    for name, payload in bundle.files(origin).items():
        # Compact separators: this is machine-read, and the whitespace is a
        # meaningful fraction of a file that is mostly punctuation and digits.
        blob = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        total += write(out / "bundle" / "{}.json".format(name), blob.encode("utf-8"))

    # --- static files ----------------------------------------------------
    for name in ASSET_DIRS:
        source = REPO_ROOT / name
        shutil.copytree(source, out / name)
        total += sum(f.stat().st_size for f in (out / name).rglob("*") if f.is_file())

    # --- the two files that make Pages behave -----------------------------
    #
    # CNAME is how a repository claims a custom domain: GitHub routes the domain
    # to whichever repository declares it, and without this the subdomain
    # resolves to GitHub and gets a 404 from it. Deleting this file is what took
    # the site down.
    total += write(out / "CNAME", (domain + "\n").encode("utf-8"))

    # Without .nojekyll, Pages runs the output through Jekyll, which silently
    # drops any file or directory whose name starts with an underscore.
    total += write(out / ".nojekyll", b"")

    files = sum(1 for f in out.rglob("*") if f.is_file())
    print("froze {} files, {:.1f} MB -> {}".format(files, total / 1e6, out))
    print("  origin  {}".format(origin))
    print("  domain  {}".format(domain))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="dist", help="output directory (default: dist)")
    parser.add_argument(
        "--origin",
        default=os.environ.get("SITE_ORIGIN", DEFAULT_ORIGIN),
        help="canonical origin baked into canonical tags, robots.txt and the sitemap",
    )
    parser.add_argument(
        "--domain",
        default=os.environ.get("SITE_DOMAIN"),
        help="custom domain for the CNAME file (default: the origin's host)",
    )
    args = parser.parse_args()

    origin = args.origin.rstrip("/")
    domain = args.domain or origin.split("://", 1)[-1]

    freeze(Path(args.out).resolve(), origin, domain)


if __name__ == "__main__":
    main()
