# Tech Affordability Index

### → **[Live site](https://varadmore.me/Tech-affordability-index/)**

**What share of your take-home pay does rent actually take, city by city?**

Tech hubs shift, and engineers weighing a relocation get served cost-of-living
calculators that are months or years stale and quietly compare *gross* salaries —
as if a $185k offer meant the same thing in Austin and Manhattan.

This computes rent against **take-home pay** — after federal, FICA, state, city
and payroll tax — across 21 metros, on rent data that refreshes every month.

![Rent burden by metro](docs/preview-bars.svg)

---

## Why the numbers here are different

**Rent is live.** A GitHub Action pulls the Zillow Observed Rent Index on the 20th
of each month and commits the result. The git history of `data/rents.json` *is* the
freshness record — every refresh is a dated, diffable commit.

**Tax is current and complete.** Federal brackets, the standard deduction and the
Social Security wage base for the current tax year; each state's own brackets and
deduction; state payroll levies (CA SDI, WA PFML, WA Cares); and city income tax
in New York City and Philadelphia. Every constant in `src/tax-data.js` carries its
source URL.

**Equity is discounted, not counted at face value.** Unvested stock is not cash.
Public RSUs take a haircut for price risk; private company shares default to a 0%
haircut, because you cannot pay rent with illiquid paper.

**The headline uses base salary only.** Total comp flatters the number exactly
where a relocation decision can least afford it: a sign-on bonus is one lump in
January, and RSUs vest quarterly at a price nobody can predict. Equity and bonuses
get their own views instead.

## What it shows

| View | Answers |
|---|---|
| **Ranked bars** | Where does rent eat least of my monthly pay? Marked against HUD's 30% cost-burdened line. |
| **Heatmap** | How do all 21 metros compare across every reference offer at once? |
| **Small multiples** | How does it change over four years as equity vests? |

The vesting view is where the offers separate: a front-loaded grant pays rent now,
a back-loaded one has a year-3 cliff that a single total-comp number hides entirely.

## Running it

No dependencies, no build step, no database.

```bash
npm run serve        # http://localhost:4173
npm test             # 53 tests over the tax and ingestion logic
npm run fetch-rents  # refresh data/rents.json from Zillow
```

Deploying: enable GitHub Pages with **GitHub Actions** as the source. `ci.yml`
tests and publishes on every push to `main`.

## Layout

```
index.html            page shell
assets/               rendering — charts.js is hand-rolled SVG, zero deps
src/tax.js            tax engine (holds no constants)
src/tax-data.js       every bracket and rate, each with its source
src/affordability.js  the ratio math
src/hubs.js           curated metro -> tax jurisdiction mapping
scripts/fetch-rents.mjs   ZORI ingest
data/rents.json       committed monthly by CI
test/                 node --test
```

Rolling to a new tax year means editing `src/tax-data.js` and nothing else.

## Method and caveats

- **Rent** is ZORI: smoothed asking rents, metro level, **all home types**. Zillow
  publishes no bedroom-level metro series, so this is not a one-bedroom median and
  is not labelled as one.
- **Metro, not neighbourhood.** "San Francisco" spans the whole MSA and so reads
  lower than a downtown listing.
- **Assumes** a single filer taking the standard deduction — no dependents, no
  401(k) deferral, no itemising. Your real number will differ.
- The **Washington, DC** metro spans three tax jurisdictions and is modelled as
  Northern Virginia, where most of the region's tech employment sits.
- Compensation profiles are **illustrative reference offers**, not a live feed.
  They are starting points you overwrite with your own numbers.

**The ingest fails loudly.** If Zillow is unreachable or the feed is malformed, the
script exits non-zero and the last good data stays committed — stale numbers still
labelled with their real date. It never substitutes placeholders, which is how a
broken pipeline stays invisible.

## Sources

- [Zillow Research — ZORI](https://www.zillow.com/research/data/)
- [Tax Foundation — 2026 federal brackets](https://taxfoundation.org/data/all/federal/2026-tax-brackets/)
- [Tax Foundation — 2026 state brackets](https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/)
- [SSA — contribution and benefit base](https://www.ssa.gov/oact/cola/cbb.html)
- [City of Philadelphia — wage tax](https://www.phila.gov/services/payments-assistance-taxes/taxes/income-taxes/earnings-tax-employees/)

## Licence

MIT.
