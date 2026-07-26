"""
Tax engine — single filer, standard deduction, wage income only.

Holds no constants: every figure comes from :mod:`app.tax_data`, so rolling to a
new tax year never touches this module.
"""

import math
from typing import NamedTuple, Optional, Sequence, Tuple

from .tax_data import (
    ADDITIONAL_MEDICARE_RATE,
    ADDITIONAL_MEDICARE_THRESHOLD,
    FEDERAL_BRACKETS,
    FEDERAL_STANDARD_DEDUCTION,
    LOCAL,
    MEDICARE_RATE,
    SOCIAL_SECURITY_RATE,
    SOCIAL_SECURITY_WAGE_BASE,
    STATES,
    Bracket,
)


class PayrollItem(NamedTuple):
    """One employee-side payroll levy, priced for a particular wage."""

    label: str
    amount: float


class StateTax(NamedTuple):
    income_tax: float
    payroll_tax: float
    total: float
    payroll_detail: Tuple[PayrollItem, ...]


class TaxBreakdown(NamedTuple):
    """Full liability for one gross wage in one location.

    Carries the breakdown as well as the total so a page can show where the
    money actually goes rather than one opaque number.
    """

    gross: float
    federal: float
    fica: float
    state_income: float
    state_payroll: float
    state_payroll_detail: Tuple[PayrollItem, ...]
    local: float
    total: float
    net: float
    effective_rate: float


def progressive_tax(taxable_income: float, brackets: Sequence[Bracket]) -> float:
    """Marginal progressive tax over ascending brackets.

    Each bracket is charged only on the slice of income that falls inside it, so
    crossing a boundary never produces a discontinuity in take-home pay.
    """
    if not brackets or taxable_income <= 0:
        return 0.0

    tax = 0.0
    for i, bracket in enumerate(brackets):
        if taxable_income <= bracket.lower:
            break
        upper = brackets[i + 1].lower if i + 1 < len(brackets) else math.inf
        tax += (min(taxable_income, upper) - bracket.lower) * bracket.rate
    return tax


def fica_tax(gross: float) -> float:
    """Social Security capped at the annual wage base, Medicare uncapped, plus
    the 0.9% Additional Medicare Tax on wages above a statutory threshold.
    """
    if gross <= 0:
        return 0.0

    social_security = min(gross, SOCIAL_SECURITY_WAGE_BASE) * SOCIAL_SECURITY_RATE
    medicare = gross * MEDICARE_RATE
    additional_medicare = (
        max(0.0, gross - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE
    )

    return social_security + medicare + additional_medicare


def federal_tax(gross: float) -> float:
    return progressive_tax(max(0.0, gross - FEDERAL_STANDARD_DEDUCTION), FEDERAL_BRACKETS)


def state_taxable_income(gross: float, state_code: str) -> float:
    state = STATES.get(state_code)
    return max(0.0, gross - (state.standard_deduction if state else 0.0))


def state_tax(gross: float, state_code: str) -> StateTax:
    """State income tax plus employee-side payroll levies.

    The two are assessed on different bases: income tax on income after the
    state's own deduction, payroll levies on gross wages.
    """
    state = STATES.get(state_code)
    if state is None:
        raise ValueError("Unknown state: {}".format(state_code))
    if gross <= 0:
        return StateTax(0.0, 0.0, 0.0, ())

    income_tax = progressive_tax(state_taxable_income(gross, state_code), state.brackets)

    payroll_detail = tuple(
        PayrollItem(levy.label, min(gross, math.inf if levy.cap is None else levy.cap) * levy.rate)
        for levy in state.payroll
    )
    payroll_tax = sum(item.amount for item in payroll_detail)

    return StateTax(income_tax, payroll_tax, income_tax + payroll_tax, payroll_detail)


def local_tax(gross: float, local_code: Optional[str], state_code: str) -> float:
    """City income tax (NYC, Philadelphia). Zero when the metro levies none."""
    if not local_code:
        return 0.0

    local = LOCAL.get(local_code)
    if local is None:
        raise ValueError("Unknown locality: {}".format(local_code))
    if gross <= 0:
        return 0.0

    base = gross if local.base == "gross" else state_taxable_income(gross, state_code)

    return progressive_tax(base, local.brackets)


def total_tax(gross: float, state: str, local: Optional[str] = None) -> TaxBreakdown:
    federal = federal_tax(gross)
    fica = fica_tax(gross)
    state_result = state_tax(gross, state)
    local_amount = local_tax(gross, local, state)

    total = federal + fica + state_result.total + local_amount

    return TaxBreakdown(
        gross=gross,
        federal=federal,
        fica=fica,
        state_income=state_result.income_tax,
        state_payroll=state_result.payroll_tax,
        state_payroll_detail=state_result.payroll_detail,
        local=local_amount,
        total=total,
        net=gross - total,
        effective_rate=total / gross if gross > 0 else 0.0,
    )
