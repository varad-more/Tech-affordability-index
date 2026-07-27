"""
Rent seasonality — when in the year is a lease cheapest to sign?

Classical multiplicative decomposition. For a monthly series:

1. trend      12-month centred moving average (half weight on the two end
              months, so the window covers exactly one year and no calendar
              month is counted twice)
2. ratio      value / trend, which strips the trend and leaves season + noise
3. index[m]   mean ratio for calendar month m, across every year available
4. normalise  so the twelve indices average to exactly 1.0

A centred average is what makes this work: a trailing average lags the series by
six months and would smear the seasonal peak into the wrong months.

The result reads directly — 0.98 for January means January rents sit about 2%
below that year's trend.

HONESTY NOTE, which the page repeats: ZORI is a *smoothed* index, and smoothing
damps exactly the within-year movement measured here. So these amplitudes are,
if anything, an understatement of what a listing-level series would show — but
they are what this data can support, and they are small compared with the
differences between places.
"""

import math
from typing import List, NamedTuple, Optional, Sequence, Tuple

#: Half-weight on the two end months so the window spans exactly twelve.
HALF_WINDOW = 6

MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

MONTH_SHORT = ("J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D")

#: Whether a seasonal pattern is worth acting on. Below about 1.5%
#: peak-to-trough the signal is comparable to the noise in a smoothed index, and
#: telling someone to move house over it would be false precision.
MEANINGFUL_AMPLITUDE = 0.015


class SeasonalIndex(NamedTuple):
    index: List[float]
    #: Observation count per calendar month.
    years: List[int]
    #: Peak-to-trough, as a fraction: 0.037 means a 3.7% swing across the year.
    amplitude: float
    cheapest: int
    dearest: int


class SeasonalSaving(NamedTuple):
    monthly: float
    annual: float


def centred_trend(series: Sequence[Optional[float]]) -> List[Optional[float]]:
    """Centred 12-month moving average.

    Same length as the input, None where the window is incomplete.
    """
    n = len(series)
    trend: List[Optional[float]] = [None] * n

    for i in range(HALF_WINDOW, n - HALF_WINDOW):
        total = 0.0
        complete = True

        for k in range(-HALF_WINDOW, HALF_WINDOW + 1):
            value = series[i + k]
            if value is None:
                complete = False
                break
            total += value / 2 if abs(k) == HALF_WINDOW else value

        if complete:
            trend[i] = total / 12
    return trend


def seasonal_index(
    series: Sequence[Optional[float]], start_month: int, min_years: int = 3
) -> Optional[SeasonalIndex]:
    """Seasonal index by calendar month.

    ``start_month`` is the calendar month of ``series[0]``, 0 = January.
    Returns None for a series too short to average over.
    """
    trend = centred_trend(series)

    # Ratios grouped by calendar month.
    ratios: List[List[float]] = [[] for _ in range(12)]
    for i, value in enumerate(series):
        if value is None or trend[i] is None:
            continue
        ratios[(start_month + i) % 12].append(value / trend[i])

    # Every calendar month needs enough observations, or the index is comparing
    # months measured over different spans of the trend.
    counts = [len(group) for group in ratios]
    if min(counts) < min_years:
        return None

    # math.fsum, not sum(). Python 3.12 changed sum() for floats to Neumaier
    # compensated summation, so the same code returns results one ULP apart on
    # 3.11 and 3.12 — which CI found by running a version this machine does not
    # have. fsum is exactly rounded, so it is identical on every version and
    # platform, and it is the more accurate of the two rather than a compromise
    # between them.
    raw = [math.fsum(group) / len(group) for group in ratios]
    mean = math.fsum(raw) / 12
    index = [value / mean for value in raw]

    return SeasonalIndex(
        index=index,
        years=counts,
        amplitude=max(index) - min(index),
        cheapest=index.index(min(index)),
        dearest=index.index(max(index)),
    )


def seasonal_saving(index: Sequence[float], rent: float) -> SeasonalSaving:
    """What the seasonal swing is worth, in money."""
    cheapest = min(index)
    dearest = max(index)

    # The trend-level rent this index is expressed against.
    base = rent / ((cheapest + dearest) / 2)

    monthly = base * (dearest - cheapest)
    return SeasonalSaving(monthly=monthly, annual=monthly * 12)
