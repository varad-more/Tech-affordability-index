"""
Counties, rolled up to states, without inventing a state-level number.

The map page argues that shading a whole state by cost is dishonest, and that is
still true: Texas holds both Loving County and Travis County, and no single fill
can stand for both. What is honest is to say which county sits in the middle,
name the two ends, and show how far apart they are. Every figure this module
produces therefore belongs to a real, named county rather than to an average of
places nobody lives.

The median is over counties, unweighted, because no population figure ships with
this project. A state's median county is its 50th-most-expensive county, not the
county half its residents live below. Pages using this must say so.
"""

from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence


class StateRollup(NamedTuple):
    n: int
    median: Dict[str, Any]
    cheapest: Dict[str, Any]
    dearest: Dict[str, Any]
    #: How much dearer the dearest county is than the cheapest. This is the
    #: number that says whether one figure for the state means anything: near 1
    #: the state is uniform, at 2 the state is two different countries.
    spread: Optional[float]


def median_by(
    items: Sequence[Any], value_of: Callable[[Any], float]
) -> Optional[Any]:
    """The element at the 50th percentile of ``items`` by ``value_of``.

    Returns an actual element, never an interpolated midpoint between two, so
    the caller can name it. With an even count this is the upper of the two
    middles, which is the conventional choice when the answer has to be a real
    member of the set.
    """
    if not items:
        return None
    ordered = sorted(items, key=value_of)
    return ordered[len(ordered) // 2]


def roll_up_state(counties: Sequence[Dict[str, Any]]) -> Optional[StateRollup]:
    """Roll up every county in one state that has a rent figure on the basis
    currently selected. Each county needs a ``needs`` key, the monthly total.
    """
    if not counties:
        return None

    ordered = sorted(counties, key=lambda c: c["needs"])
    cheapest = ordered[0]
    dearest = ordered[-1]

    return StateRollup(
        n=len(counties),
        median=ordered[len(ordered) // 2],
        cheapest=cheapest,
        dearest=dearest,
        spread=dearest["needs"] / cheapest["needs"] if cheapest["needs"] > 0 else None,
    )


def roll_up_states(
    counties: Sequence[Dict[str, Any]]
) -> Dict[str, Optional[StateRollup]]:
    """Every county with a rent figure, across all states, keyed by postal code.

    States with no priced county are omitted rather than given an empty rollup.
    """
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for county in counties:
        buckets.setdefault(county["state"], []).append(county)

    return {code: roll_up_state(group) for code, group in buckets.items()}
