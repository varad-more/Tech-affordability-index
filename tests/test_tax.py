"""
The tax engine, ported from test/tax.test.mjs.

These assert behaviour rather than figures: bracket boundaries, the wage cap,
the surtax threshold, which deduction a state uses, and that unknown input
raises instead of quietly returning zero. The figures themselves are pinned
separately and exhaustively by ``test_parity.py``.
"""

import pytest

from app.tax import (
    federal_tax,
    fica_tax,
    local_tax,
    progressive_tax,
    state_tax,
    total_tax,
)
from app.tax_data import (
    ADDITIONAL_MEDICARE_RATE,
    ADDITIONAL_MEDICARE_THRESHOLD,
    FEDERAL_BRACKETS,
    FEDERAL_STANDARD_DEDUCTION,
    MEDICARE_RATE,
    SOCIAL_SECURITY_RATE,
    SOCIAL_SECURITY_WAGE_BASE,
    STATES,
    Bracket,
)

#: Money comparisons to the cent.
CENT = 0.01

BRACKETS = (Bracket(0, 0.1), Bracket(100, 0.2), Bracket(200, 0.3))


class TestProgressiveTax:
    def test_charges_each_bracket_only_on_the_slice_inside_it(self):
        assert progressive_tax(50, BRACKETS) == pytest.approx(5, abs=CENT)
        assert progressive_tax(100, BRACKETS) == pytest.approx(10, abs=CENT)
        assert progressive_tax(150, BRACKETS) == pytest.approx(10 + 10, abs=CENT)
        assert progressive_tax(200, BRACKETS) == pytest.approx(10 + 20, abs=CENT)
        assert progressive_tax(300, BRACKETS) == pytest.approx(10 + 20 + 30, abs=CENT)

    def test_is_zero_at_or_below_zero_income(self):
        assert progressive_tax(0, BRACKETS) == 0
        assert progressive_tax(-5000, BRACKETS) == 0

    def test_returns_zero_for_states_with_no_brackets(self):
        assert progressive_tax(500_000, ()) == 0

    @pytest.mark.parametrize("edge", [100, 200])
    def test_never_jumps_at_a_bracket_boundary(self, edge):
        """Earning one dollar more must never cost more than one dollar in tax."""
        delta = progressive_tax(edge + 1, BRACKETS) - progressive_tax(edge, BRACKETS)
        assert 0 < delta < 1, "discontinuity at {}: {}".format(edge, delta)

    def test_is_monotonic_across_the_federal_schedule(self):
        previous = -1.0
        for income in range(0, 800_001, 5000):
            tax = progressive_tax(income, FEDERAL_BRACKETS)
            assert tax >= previous, "federal tax decreased at {}".format(income)
            previous = tax


class TestFederalIncomeTax:
    """Hand-computed against the published 2026 single-filer schedule."""

    def test_100k_gross(self):
        # taxable 83,900 -> 12,400@10 + 38,000@12 + 33,500@22
        assert federal_tax(100_000) == pytest.approx(1240 + 4560 + 7370, abs=CENT)

    def test_185k_gross(self):
        # taxable 168,900 -> 1,240 + 4,560 + 12,166 + 15,168
        assert federal_tax(185_000) == pytest.approx(33_134, abs=CENT)

    def test_income_at_or_below_the_standard_deduction_owes_nothing(self):
        assert federal_tax(FEDERAL_STANDARD_DEDUCTION) == 0
        assert federal_tax(10_000) == 0


class TestFica:
    def test_social_security_stops_at_the_wage_base(self):
        max_ss = SOCIAL_SECURITY_WAGE_BASE * SOCIAL_SECURITY_RATE
        # Published 2026 maximum employee contribution.
        assert max_ss == pytest.approx(11_439, abs=CENT)

        # Above the cap SS adds nothing further: the delta is all Medicare.
        delta = fica_tax(SOCIAL_SECURITY_WAGE_BASE + 10_000) - fica_tax(
            SOCIAL_SECURITY_WAGE_BASE
        )
        assert delta == pytest.approx(10_000 * MEDICARE_RATE, abs=CENT)

    def test_additional_medicare_applies_only_above_the_threshold(self):
        threshold = ADDITIONAL_MEDICARE_THRESHOLD
        # At exactly the threshold the surtax has not started.
        assert fica_tax(threshold) == pytest.approx(
            min(threshold, SOCIAL_SECURITY_WAGE_BASE) * 0.062 + threshold * 0.0145,
            abs=CENT,
        )

        above = fica_tax(threshold + 50_000) - fica_tax(threshold)
        assert above == pytest.approx(
            50_000 * (MEDICARE_RATE + ADDITIONAL_MEDICARE_RATE), abs=CENT
        )

    def test_100k_gross(self):
        assert fica_tax(100_000) == pytest.approx(6200 + 1450, abs=CENT)

    def test_is_zero_at_zero_income(self):
        assert fica_tax(0) == 0


class TestStateTax:
    @pytest.mark.parametrize("code", ["TX", "FL", "TN", "NV"])
    def test_no_income_tax_states_owe_nothing_on_wages(self, code):
        assert state_tax(250_000, code).total == 0

    def test_washington_has_no_income_tax_but_real_payroll_levies(self):
        result = state_tax(200_000, "WA")
        assert result.income_tax == 0

        # PFML: employee share of 1.13%, capped at the SS wage base.
        pfml = 184_500 * (0.0113 * 0.7143)
        wa_cares = 200_000 * 0.0058  # uncapped
        assert result.payroll_tax == pytest.approx(pfml + wa_cares, abs=CENT)
        assert result.payroll_tax > 2000, "WA payroll should be material"

    def test_california_uses_its_own_standard_deduction(self):
        """The bug in the original Python engine, guarded ever since.

        It subtracted the federal $16,100 from state taxable income rather than
        California's $5,540, which understates CA tax.
        """
        gross = 200_000
        actual = state_tax(gross, "CA").income_tax

        assert STATES["CA"].standard_deduction == 5540

        wrong = progressive_tax(
            max(0, gross - FEDERAL_STANDARD_DEDUCTION), STATES["CA"].brackets
        )
        assert actual > wrong, "correct CA tax must exceed the federal-deduction version"
        # The gap is the deduction difference taxed at CA's 9.3% band.
        assert actual - wrong == pytest.approx(
            (FEDERAL_STANDARD_DEDUCTION - 5540) * 0.093, abs=1
        )

    def test_ca_sdi_is_uncapped_and_charged_on_gross(self):
        assert state_tax(500_000, "CA").payroll_tax == pytest.approx(
            500_000 * 0.013, abs=CENT
        )

    def test_pennsylvania_taxes_gross_with_no_deduction(self):
        assert state_tax(150_000, "PA").income_tax == pytest.approx(
            150_000 * 0.0307, abs=CENT
        )

    def test_unknown_state_raises_rather_than_returning_zero(self):
        # The original engine returned $0 for every unmodelled state.
        with pytest.raises(ValueError, match="Unknown state"):
            state_tax(100_000, "ZZ")


class TestLocalIncomeTax:
    def test_nyc_applies_on_top_of_new_york_state(self):
        gross = 185_000
        nyc = local_tax(gross, "NYC", "NY")

        # Taxable = 185,000 - 8,000 NY deduction = 177,000, walked through the
        # four NYC resident bands:
        #   12,000 @ 3.078% +  13,000 @ 3.762%
        # + 25,000 @ 3.819% + 127,000 @ 3.876%
        expected = (
            12_000 * 0.03078
            + 13_000 * 0.03762
            + 25_000 * 0.03819
            + 127_000 * 0.03876
        )
        assert nyc == pytest.approx(expected, abs=CENT)
        assert nyc == pytest.approx(6735.69, abs=CENT)

        # The blended rate must land below the 3.876% top band, since the first
        # $50k is taxed lower — a flat-rate approximation would overstate it.
        taxable = gross - STATES["NY"].standard_deduction
        assert nyc < taxable * 0.03876

    def test_a_metro_with_no_local_tax_pays_none(self):
        assert local_tax(185_000, None, "TX") == 0

    def test_philadelphia_is_charged_on_gross_not_taxable_income(self):
        assert local_tax(150_000, "PHL", "PA") == pytest.approx(
            150_000 * 0.03735, abs=CENT
        )

    def test_unknown_locality_raises(self):
        with pytest.raises(ValueError, match="Unknown locality"):
            local_tax(100_000, "XYZ", "CA")


class TestTotalTax:
    def test_breakdown_sums_to_the_total(self):
        r = total_tax(250_000, "CA")
        assert r.federal + r.fica + r.state_income + r.state_payroll + r.local == (
            pytest.approx(r.total, abs=CENT)
        )
        assert r.net == pytest.approx(250_000 - r.total, abs=CENT)

    def test_no_tax_state_beats_high_tax_state_at_equal_gross(self):
        tx = total_tax(200_000, "TX")
        ca = total_tax(200_000, "CA")
        nyc = total_tax(200_000, "NY", "NYC")

        assert tx.total < ca.total, "TX should tax less than CA"
        assert ca.total < nyc.total, "CA should tax less than NYC at this income"

    def test_effective_rate_is_a_sane_fraction(self):
        r = total_tax(185_000, "CA")
        assert 0.25 < r.effective_rate < 0.45

    @pytest.mark.parametrize("gross", [0, 50_000, 185_000, 1_000_000])
    @pytest.mark.parametrize(
        "state,local", [("CA", None), ("NY", "NYC"), ("TX", None), ("WA", None)]
    )
    def test_take_home_never_exceeds_gross_and_never_goes_negative(
        self, gross, state, local
    ):
        r = total_tax(gross, state, local)
        assert r.net <= gross
        assert r.net >= 0
