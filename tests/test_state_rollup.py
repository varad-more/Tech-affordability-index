"""
State rollups, ported from test/state-rollup.test.mjs.

The point of this module is that it never invents a state-level number, so most
of what is asserted here is what it refuses to do: no interpolated median, no
zero standing in for no data, no mutation of the caller's list.
"""

from app.state_rollup import median_by, roll_up_state, roll_up_states


def county(name, state, needs):
    return {"name": name, "state": state, "needs": needs}


TEXAS = [
    county("Loving", "TX", 1800),
    county("Travis", "TX", 3600),
    county("Bexar", "TX", 2400),
]


class TestMedianBy:
    def test_returns_a_real_element_never_an_interpolated_one(self):
        items = [county("a", "CA", 10), county("b", "CA", 20)]
        assert median_by(items, lambda c: c["needs"]) in items

    def test_is_the_middle_by_value_not_by_input_order(self):
        items = [
            county("c", "CA", 90),
            county("a", "CA", 10),
            county("b", "CA", 50),
        ]
        assert median_by(items, lambda c: c["needs"])["name"] == "b"

    def test_an_empty_list_has_no_median(self):
        assert median_by([], lambda c: c["needs"]) is None


class TestRollUpState:
    def test_names_the_two_ends_and_the_middle(self):
        roll = roll_up_state(TEXAS)
        assert roll.cheapest["name"] == "Loving"
        assert roll.dearest["name"] == "Travis"
        assert roll.median["name"] == "Bexar"
        assert roll.n == 3

    def test_spread_is_the_ratio_of_the_ends(self):
        assert roll_up_state(TEXAS).spread == 2

    def test_a_one_county_state_is_its_own_median_and_has_no_spread(self):
        roll = roll_up_state([county("Kalawao", "HI", 2100)])
        assert roll.median["name"] == "Kalawao"
        assert roll.cheapest is roll.dearest
        assert roll.spread == 1

    def test_a_state_with_nothing_published_rolls_up_to_nothing_not_to_zero(self):
        """"No data" and "$0 a month" are very different claims on screen."""
        assert roll_up_state([]) is None

    def test_does_not_mutate_the_callers_list(self):
        before = [c["name"] for c in TEXAS]
        roll_up_state(TEXAS)
        assert [c["name"] for c in TEXAS] == before


class TestRollUpStates:
    ALL = [
        county("Loving", "TX", 1800),
        county("Travis", "TX", 3600),
        county("King", "WA", 3200),
    ]

    def test_buckets_by_state_and_rolls_each_up(self):
        out = roll_up_states(self.ALL)
        assert sorted(out) == ["TX", "WA"]
        assert out["TX"].n == 2
        assert out["WA"].median["name"] == "King"

    def test_a_state_with_no_counties_in_the_input_is_absent_not_empty(self):
        assert "CA" not in roll_up_states(self.ALL)
