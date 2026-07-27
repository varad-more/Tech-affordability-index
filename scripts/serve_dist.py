"""
Serve ``dist/`` the way GitHub Pages serves it.

The browser suite runs against this rather than against ``flask run``, because
``dist/`` is what actually gets deployed. A suite pointed at the development
server would pass while the frozen output was missing a file, pointing at the
wrong path, or serving the wrong 404 — the whole class of bug that only exists
because there is a build step.

Pages semantics that a plain file server does not give you, and that the site
depends on:

* ``/states/`` serves ``states/index.html`` — the trailing slash is what every
  relative link inside the page resolves against.
* ``/states`` redirects to ``/states/`` rather than 404ing.
* an unmatched path serves ``404.html`` with a 404 status, so the site keeps its
  own 404 page instead of GitHub's.

Freezes first by default, so the thing being served is never stale.

Usage::

    python scripts/serve_dist.py --port 4173
    python scripts/serve_dist.py --no-build      # serve what is already there
"""

import argparse
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.freeze import DEFAULT_ORIGIN, freeze  # noqa: E402


class PagesHandler(SimpleHTTPRequestHandler):
    """A file server with GitHub Pages' redirect and 404 behaviour."""

    def send_head(self):
        path = self.translate_path(self.path)

        # A directory without the trailing slash: redirect, do not 404. Pages
        # does this, and without it every relative asset URL inside the page
        # would resolve one level too high.
        if os.path.isdir(path) and not self.path.split("?", 1)[0].endswith("/"):
            self.send_response(301)
            self.send_header("Location", self.path.split("?", 1)[0] + "/")
            self.end_headers()
            return None

        target = os.path.join(path, "index.html") if os.path.isdir(path) else path
        if not os.path.exists(target):
            return self.not_found()

        return super().send_head()

    def not_found(self):
        page = Path(self.directory) / "404.html"
        body = page.read_bytes() if page.exists() else b"404"
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return None

    def handle(self):
        # A browser that navigates away mid-response leaves this end writing to
        # a closed socket. That is normal client behaviour, not a server fault,
        # and letting the traceback through buries real failures in the suite's
        # output.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass  # the suite is noisy enough


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--dist", default="dist")
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="serve the existing dist/ instead of rebuilding it first",
    )
    # Defaults to the production origin, not to localhost. The point of serving
    # dist/ is to exercise the artefact that ships, and the canonical tags and
    # CNAME are part of it — pointing them at localhost would make the one thing
    # a browser cannot see by rendering untestable.
    parser.add_argument("--origin", default=os.environ.get("SITE_ORIGIN", DEFAULT_ORIGIN))
    parser.add_argument("--domain", default=os.environ.get("SITE_DOMAIN"))
    args = parser.parse_args()

    origin = args.origin.rstrip("/")
    out = Path(args.dist).resolve()
    if not args.no_build:
        freeze(out, origin, args.domain or origin.split("://", 1)[-1])

    handler = functools.partial(PagesHandler, directory=str(out))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print("serving {} on http://127.0.0.1:{}".format(out, args.port), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
