"""
The Affordability Index, as a Flask application.

Routes match the URLs the site has always served — ``/``, ``/states/``,
``/timing/``, ``/method/`` — so the move to a server changed the implementation
without changing a single address. The trailing slashes are load-bearing: they
are what the canonical tags, the sitemap and every relative link inside the
pages already assume.
"""

import os
from pathlib import Path

from flask import Flask, Response, render_template, send_from_directory

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Datasets are served as static files rather than inlined into the templates.
#: The basemap alone is 728 KB of SVG path data that never changes between
#: deploys, so it belongs in the browser cache, not in every HTML response.
DATA_DIR = REPO_ROOT / "data"
ASSETS_DIR = REPO_ROOT / "assets"


def create_app(config=None) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(ASSETS_DIR),
        static_url_path="/assets",
        template_folder=str(Path(__file__).resolve().parent / "templates"),
    )
    app.config.update(
        # The canonical host, used by the templates for canonical and og tags.
        # Overridable so a staging deploy does not advertise production URLs.
        SITE_ORIGIN=os.environ.get(
            "SITE_ORIGIN", "https://affordability-index.varadmore.me"
        ),
    )
    if config:
        app.config.update(config)

    from .api import bp as api_bp

    app.register_blueprint(api_bp)

    @app.get("/")
    def index():
        return render_template("index.html", page="index", canonical="/")

    @app.get("/states/")
    def states():
        return render_template("states.html", page="states", canonical="states/")

    @app.get("/timing/")
    def timing():
        return render_template("timing.html", page="timing", canonical="timing/")

    @app.get("/method/")
    def method():
        return render_template("method.html", page="method", canonical="method/")

    @app.get("/data/<path:name>")
    def data_file(name: str):
        return send_from_directory(DATA_DIR, name, max_age=3600)

    @app.get("/robots.txt")
    def robots():
        return send_from_directory(REPO_ROOT, "robots.txt")

    @app.get("/sitemap.xml")
    def sitemap():
        return send_from_directory(REPO_ROOT, "sitemap.xml", mimetype="application/xml")

    @app.errorhandler(404)
    def not_found(_error):
        return (
            render_template("404.html", page="404", canonical=None),
            404,
        )

    return app
