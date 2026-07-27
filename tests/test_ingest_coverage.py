"""
Coverage checks that used to live in the Node ingest suite.

They moved when the tax tables did. The check is stronger here: it runs against
``data/rents.json`` — the file the application actually reads — rather than
against ``src/hubs.js``, the constant the ingest was written from. A hub that
survives the ingest but names a state with no bracket table would render as a
crash in someone's browser, so it fails here instead.
"""

import json
from pathlib import Path

from app.tax_data import LOCAL, STATES

DATA = Path(__file__).resolve().parent.parent / "data"
HUBS = json.loads((DATA / "rents.json").read_text(encoding="utf-8"))["hubs"]


def test_there_are_hubs_to_check():
    assert len(HUBS) > 15


def test_every_hub_maps_to_a_modelled_state():
    unmodelled = sorted({h["state"] for h in HUBS} - set(STATES))
    assert unmodelled == [], "hubs reference unmodelled states: {}".format(unmodelled)


def test_every_declared_locality_exists():
    for hub in HUBS:
        if hub.get("local"):
            assert hub["local"] in LOCAL, "{} references unknown locality {}".format(
                hub["city"], hub["local"]
            )


def test_the_two_modelled_city_taxes_are_both_reachable_from_a_hub():
    """If a locality is modelled but no hub uses it, the model is untested."""
    used = {h.get("local") for h in HUBS if h.get("local")}
    assert used == set(LOCAL), "modelled but unused: {}".format(set(LOCAL) - used)
