"""
The committed datasets, loaded once and indexed for lookup.

Every file under ``data/`` is written by a Node ingest, committed, and dated.
Nothing here fetches anything: a clone is immediately runnable, and the git
history of that directory is the freshness record.

Loading is eager and process-wide. The whole set is about 2 MB and never changes
while the process lives, so paying for it once at import beats paying for it per
request — and a missing or malformed file then fails at boot rather than on
whichever request first happens to touch it.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

#: Non-housing essential categories, in the order MIT publishes them. Housing is
#: excluded on purpose: rent comes from ZORI or ACS instead, and counting MIT's
#: housing row as well would double-count it.
CATEGORY_ORDER = (
    "Food",
    "Medical",
    "Transportation",
    "Civic",
    "Internet & Mobile",
    "Other",
)

CATEGORY_LABELS = {
    "Food": "Groceries",
    "Medical": "Healthcare",
    "Transportation": "Transport",
    "Civic": "Civic & recreation",
    "Internet & Mobile": "Internet & phone",
    "Other": "Other essentials",
}


def _load(name: str) -> Dict[str, Any]:
    path = DATA_DIR / name
    if not path.exists():
        raise FileNotFoundError(
            "{} is missing. It is committed to the repository, so a clone should "
            "already have it; if an ingest deleted it, restore it from git rather "
            "than regenerating, so the dataset keeps its real date.".format(path)
        )
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


class Datasets:
    """Every dataset the pages read, plus the indexes they look up by."""

    def __init__(self) -> None:
        self.rents = _load("rents.json")
        self.profiles = _load("profiles.json")
        self.county_rents = _load("county-rents.json")
        self.county_acs_rents = _load("county-acs-rents.json")
        self.living_wage = _load("county-living-wage.json")
        self.basemap = _load("us-basemap.json")
        self.rent_history = _load("rent-history.json")

        # --- indexes -----------------------------------------------------
        self.counties_by_fips: Dict[str, Dict[str, Any]] = {
            county["id"]: county for county in self.basemap["counties"]
        }
        self.living_wage_by_fips: Dict[str, Dict[str, Any]] = {
            county["fips"]: county for county in self.living_wage["counties"]
        }
        self.zori_by_fips: Dict[str, Any] = {
            county["fips"]: county for county in self.county_rents["counties"]
        }
        self.acs_by_fips: Dict[str, Any] = {
            county["fips"]: county for county in self.county_acs_rents["counties"]
        }
        self.history_by_fips: Dict[str, Any] = {
            county["fips"]: county for county in self.rent_history["counties"]
        }
        self.profile_by_id: Dict[str, Any] = {
            profile["id"]: profile for profile in self.profiles["profiles"]
        }

    # -- rent bases -------------------------------------------------------

    def rent_for(
        self, fips: str, basis: str, unit: str = "all"
    ) -> Optional[float]:
        """Monthly rent for a county on the selected basis and unit size.

        The two bases are never mixed into one number. A single national
        ZORI/ACS multiplier was tested against the 1,351 counties carrying both
        and rejected — correlation 0.675, median error 11%, Pitkin County off by
        a factor of nine — so a county missing from the selected basis is
        missing, not imputed from the other one.

        ``unit`` applies to ACS only. ZORI publishes no bedroom split at all,
        which is why the site never offers one on that basis. Where ACS
        suppresses a size for a county, this falls back to the all-bedroom
        median rather than dropping the county — the pages say when it has.
        """
        table = self.acs_by_fips if basis == "acs" else self.zori_by_fips
        entry = table.get(fips)
        if entry is None:
            return None

        # Both bases spell the all-bedroom median 'rent'.
        value = entry.get("rent")
        if basis == "acs" and unit != "all":
            specific = entry.get(unit)
            if isinstance(specific, (int, float)):
                value = specific

        return value if isinstance(value, (int, float)) else None

    def non_housing_for(self, fips: str) -> Optional[float]:
        entry = self.living_wage_by_fips.get(fips)
        return entry["nonHousingMonthly"] if entry else None

    @lru_cache(maxsize=16)
    def priced_counties(self, basis: str, unit: str = "all") -> Tuple[Dict[str, Any], ...]:
        """Every county with both a rent figure and a non-housing figure.

        A county missing either cannot be assessed at all, and is left out here
        rather than defaulted — the pages draw those in a no-data fill.

        Cached: the result depends only on committed data, and rebuilding a
        3,123-entry list on every request was most of what the snapshot endpoint
        was doing. Ten combinations exist (two bases x five unit sizes), so the
        cache is bounded by construction.

        Returns a tuple to make the shared, cached nature obvious at the call
        site. The dicts inside are shared too — read them, do not edit them.
        """
        out = []
        for fips, county in self.counties_by_fips.items():
            rent = self.rent_for(fips, basis, unit)
            non_housing = self.non_housing_for(fips)
            if rent is None or non_housing is None:
                continue
            out.append(
                {
                    "fips": fips,
                    "name": county.get("name"),
                    "state": county.get("st"),
                    "rent": rent,
                    "nonHousingMonthly": non_housing,
                    "needs": rent + non_housing,
                }
            )
        return tuple(out)


#: Process-wide singleton. Import this, not the class.
data = Datasets()
