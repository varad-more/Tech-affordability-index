"""
Seasonality, ported from test/seasonality.test.mjs.

A classical decomposition is easy to get subtly wrong: a trailing average
instead of a centred one shifts every peak by six months, and subtracting the
trend instead of dividing by it reads growth as seasonality. So the maths is
tested against synthetic series built from known factors, and the assertion is
that those exact factors come back out — including through a strong upward
trend, which is the case a naive implementation fails silently.

The committed dataset is what the pages serve, so its internal consistency is
pinned separately from the maths that produced it.
"""

import json
from pathlib import Path

import pytest

from app.seasonality import (
    MEANINGFUL_AMPLITUDE,
    MONTH_NAMES,
    centred_trend,
    seasonal_index,
    seasonal_saving,
)

DATA = Path(__file__).resolve().parent.parent / "data"


def synthesise(months, start_level, monthly_growth, factors, start_month=0):
    """A clean series: known trend times known seasonal factors."""
    return [
        start_level * (1 + monthly_growth) ** i * factors[(start_month + i) % 12]
        for i in range(months)
    ]


class TestCentredTrend:
    def test_reproduces_a_straight_line_exactly(self):
        series = [1000 + i * 10 for i in range(40)]
        trend = centred_trend(series)
        # A centred average of a linear series is the series itself.
        for i in range(6, 34):
            assert trend[i] == pytest.approx(series[i], abs=1e-6)

    def test_leaves_the_first_and_last_six_months_undefined(self):
        trend = centred_trend([100] * 30)
        for i in range(6):
            assert trend[i] is None
        for i in range(24, 30):
            assert trend[i] is None
        assert trend[6] is not None

    def test_averages_away_a_pure_seasonal_cycle_leaving_the_level(self):
        factors = [0.9, 0.95, 1.0, 1.05, 1.1, 1.05, 1.0, 0.95, 0.9, 1.0, 1.05, 1.05]
        mean = sum(factors) / 12
        series = synthesise(48, 100, 0, factors)

        trend = centred_trend(series)
        for i in range(6, 42):
            assert trend[i] == pytest.approx(100 * mean, abs=1e-6)

    def test_a_gap_blocks_only_the_windows_that_need_it(self):
        series = [100.0] * 40
        series[20] = None

        trend = centred_trend(series)
        # Every window covering index 20 is unusable; ones clear of it are fine.
        assert trend[20] is None
        assert trend[14] is None
        assert trend[26] is None
        assert trend[13] is not None
        assert trend[27] is not None


class TestSeasonalIndex:
    def test_recovers_the_factors_it_was_built_from(self):
        factors = [0.96, 0.97, 0.99, 1.0, 1.01, 1.02, 1.04, 1.03, 1.01, 1.0, 0.98, 0.97]
        mean = sum(factors) / 12
        normalised = [f / mean for f in factors]

        result = seasonal_index(synthesise(120, 1500, 0, factors), 0)

        assert result is not None, "expected an index"
        for m in range(12):
            assert result.index[m] == pytest.approx(normalised[m], abs=1e-6)

    def test_recovers_them_through_a_strong_upward_trend(self):
        """The whole point of dividing by a centred moving average.

        A series that grows 0.5% a month must not have that growth read as
        seasonality.
        """
        factors = [0.95, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06, 1.05, 1.02, 1.0, 0.97, 0.95]
        result = seasonal_index(synthesise(144, 1200, 0.005, factors), 0)

        assert result is not None
        mean = sum(factors) / 12
        for m in range(12):
            assert result.index[m] == pytest.approx(factors[m] / mean, abs=1e-3)

        assert result.cheapest == 0, "January should be cheapest"
        assert result.dearest == 6, "July should be dearest"

    def test_the_index_always_averages_to_one(self):
        factors = [0.9, 1.2, 1.0, 1.1, 0.95, 1.05, 1.0, 0.98, 1.02, 1.0, 0.99, 1.01]
        result = seasonal_index(synthesise(120, 900, 0.002, factors), 0)
        assert sum(result.index) / 12 == pytest.approx(1, abs=1e-9)

    def test_honours_the_calendar_month_the_series_starts_on(self):
        factors = [0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0]
        # Start in July: the cheapest calendar month is still January.
        result = seasonal_index(synthesise(120, 1000, 0, factors, start_month=6), 6)

        assert result.cheapest == 0, "expected January, got {}".format(
            MONTH_NAMES[result.cheapest]
        )
        assert result.dearest == 6, "expected July, got {}".format(
            MONTH_NAMES[result.dearest]
        )

    def test_a_flat_series_has_essentially_no_amplitude(self):
        result = seasonal_index([1000.0] * 120, 0)
        assert result.amplitude < 1e-9

    def test_refuses_a_series_too_short_to_average_a_calendar_month(self):
        """24 months leaves 12 usable ratios — one per month, not the three
        years demanded."""
        assert seasonal_index([100.0] * 24, 0) is None

    def test_refuses_when_gaps_starve_one_calendar_month(self):
        series = synthesise(120, 1000, 0, [1.0] * 12)
        # Blank out every March.
        for i in range(2, len(series), 12):
            series[i] = None
        assert seasonal_index(series, 0) is None


class TestSeasonalSaving:
    def test_values_the_swing_against_the_mid_point_of_the_cycle(self):
        index = [0.98, 0.99, 1.0, 1.0, 1.01, 1.01, 1.02, 1.02, 1.0, 1.0, 0.99, 0.98]
        saving = seasonal_saving(index, 2000)

        # Peak-to-trough is 4% of the trend level, and the mid-point of
        # 0.98/1.02 is exactly 1.0, so the trend level here is the rent itself.
        assert saving.monthly == pytest.approx(2000 * 0.04, abs=1e-6)
        assert saving.annual == pytest.approx(saving.monthly * 12, abs=1e-6)

    def test_scales_with_rent(self):
        index = [0.97, 1, 1, 1, 1, 1, 1.03, 1, 1, 1, 1, 1]
        assert seasonal_saving(index, 4000).monthly > seasonal_saving(index, 2000).monthly


class TestTheCommittedRentHistory:
    """What the pages actually serve, pinned independently of the maths."""

    data = json.loads((DATA / "rent-history.json").read_text(encoding="utf-8"))
    seasonal = [c for c in data["counties"] if c.get("season")]

    def test_covers_a_plausible_number_of_counties(self):
        assert len(self.data["counties"]) > 900
        assert self.data["seasonalCount"] > 400

    def test_every_seasonal_index_has_twelve_entries_averaging_one(self):
        for county in self.seasonal:
            assert len(county["season"]) == 12, "{} has {} months".format(
                county["name"], len(county["season"])
            )
            mean = sum(county["season"]) / 12
            # Committed at three decimals, so allow for the rounding.
            assert abs(mean - 1) < 0.002, "{} index averages {}".format(
                county["name"], mean
            )

    def test_cheapest_and_dearest_agree_with_the_index_they_came_from(self):
        for county in self.seasonal:
            low = min(county["season"])
            high = max(county["season"])
            assert county["season"][county["cheapest"]] == low, county["name"]
            assert county["season"][county["dearest"]] == high, county["name"]
            assert abs(county["amplitude"] - (high - low)) < 0.002, county["name"]

    def test_the_meaningful_flag_matches_the_threshold(self):
        for county in self.seasonal:
            assert bool(county.get("meaningful")) == (
                county["amplitude"] >= MEANINGFUL_AMPLITUDE
            ), "{} meaningful flag disagrees with its amplitude".format(county["name"])

    def test_amplitudes_stay_in_a_believable_range(self):
        for county in self.seasonal:
            # A county whose rent halves and doubles within a year is a parse
            # error, not a housing market.
            assert county["amplitude"] < 0.5, "{} swings {}".format(
                county["name"], county["amplitude"]
            )

    def test_every_county_has_history_to_chart(self):
        months = self.data["historyMonths"]
        for county in self.data["counties"]:
            assert len(county["history"]) == months, county["name"]
            assert any(v is not None for v in county["history"]), county["name"]
            for v in county["history"]:
                if v is not None:
                    assert 100 < v < 30_000, "{} rent {}".format(county["name"], v)

    def test_records_the_smoothing_caveat(self):
        assert "smooth" in self.data["source"]["caveat"].lower()
        assert "centred moving average" in self.data["method"].lower()
