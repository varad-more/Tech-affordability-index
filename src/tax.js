/**
 * Tax engine — single filer, standard deduction, wage income only.
 *
 * Holds no constants: every figure comes from `tax-data.js`, so rolling to a new
 * tax year never touches this file.
 */

import { FEDERAL, FICA, STATES, LOCAL } from './tax-data.js';

/**
 * Marginal progressive tax over ascending `{ from, rate }` brackets.
 *
 * Each bracket is charged only on the slice of income that falls inside it, so
 * crossing a bracket boundary never produces a discontinuity in take-home pay.
 */
export function progressiveTax(taxableIncome, brackets) {
  if (!brackets?.length || taxableIncome <= 0) return 0;

  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const { from, rate } = brackets[i];
    if (taxableIncome <= from) break;

    const upper = i + 1 < brackets.length ? brackets[i + 1].from : Infinity;
    tax += (Math.min(taxableIncome, upper) - from) * rate;
  }
  return tax;
}

/**
 * FICA: Social Security capped at the annual wage base, Medicare uncapped, plus
 * the 0.9% Additional Medicare Tax on wages above a statutory threshold.
 */
export function ficaTax(gross) {
  if (gross <= 0) return 0;

  const socialSecurity =
    Math.min(gross, FICA.socialSecurityWageBase) * FICA.socialSecurityRate;
  const medicare = gross * FICA.medicareRate;
  const additionalMedicare =
    Math.max(0, gross - FICA.additionalMedicareThreshold) * FICA.additionalMedicareRate;

  return socialSecurity + medicare + additionalMedicare;
}

export function federalTax(gross) {
  return progressiveTax(Math.max(0, gross - FEDERAL.standardDeduction), FEDERAL.brackets);
}

function stateTaxableIncome(gross, stateCode) {
  const state = STATES[stateCode];
  return Math.max(0, gross - (state?.standardDeduction ?? 0));
}

/**
 * State income tax plus employee-side payroll levies.
 *
 * The two are assessed on different bases: income tax on income after the
 * state's own deduction, payroll levies on gross wages.
 */
export function stateTax(gross, stateCode) {
  const state = STATES[stateCode];
  if (!state) throw new Error(`Unknown state: ${stateCode}`);
  if (gross <= 0) return { incomeTax: 0, payrollTax: 0, total: 0, payrollDetail: [] };

  const incomeTax = progressiveTax(stateTaxableIncome(gross, stateCode), state.brackets);

  const payrollDetail = state.payroll.map((levy) => ({
    label: levy.label,
    amount: Math.min(gross, levy.cap ?? Infinity) * levy.rate,
  }));
  const payrollTax = payrollDetail.reduce((sum, l) => sum + l.amount, 0);

  return { incomeTax, payrollTax, total: incomeTax + payrollTax, payrollDetail };
}

/** City income tax (NYC, Philadelphia). Returns 0 when the metro has none. */
export function localTax(gross, localCode, stateCode) {
  if (!localCode) return 0;

  const local = LOCAL[localCode];
  if (!local) throw new Error(`Unknown locality: ${localCode}`);
  if (gross <= 0) return 0;

  const base =
    local.base === 'gross' ? gross : stateTaxableIncome(gross, stateCode);

  return progressiveTax(base, local.brackets);
}

/**
 * Full liability for a gross wage income in one location.
 *
 * Returns the breakdown as well as the total, so the UI can show where the money
 * actually goes rather than just a single opaque number.
 */
export function totalTax(gross, { state, local = null } = {}) {
  const federal = federalTax(gross);
  const fica = ficaTax(gross);
  const stateResult = stateTax(gross, state);
  const localAmount = localTax(gross, local, state);

  const total = federal + fica + stateResult.total + localAmount;

  return {
    gross,
    federal,
    fica,
    stateIncome: stateResult.incomeTax,
    statePayroll: stateResult.payrollTax,
    statePayrollDetail: stateResult.payrollDetail,
    local: localAmount,
    total,
    net: gross - total,
    effectiveRate: gross > 0 ? total / gross : 0,
  };
}
