# Affordability Index

### → **[Live site](https://affordability-index.varadmore.me/)** · **[By state](https://affordability-index.varadmore.me/states/)** · **[When to move](https://affordability-index.varadmore.me/timing/)** · **[Method](https://affordability-index.varadmore.me/method/)**

**What salary does a place actually need, and does your offer clear it?**

Cost-of-living calculators go stale and quietly compare *gross* salaries, as if a
$156k offer meant the same thing in Austin and Manhattan. This works out what a
county costs to live in, rent **plus** everything else, and the salary that
covers it, measured against **take-home pay** after federal, state, city and
payroll tax.

Every US county. Current tax law. Sources you can check.

![Rent burden by metro](docs/preview-bars.svg)

---

## The question it answers

Most tools answer a *relative* question: given a salary, where does it stretch
furthest? That produces a ranking, but a ranking never says whether anything on
it is affordable. Two places with an identical 28% rent burden are not equally
livable if one has materially higher transport and medical costs.

So the model here is **absolute**:

```
needs = rent + everything else       (monthly, after tax)
```

and three salary thresholds fall out of it, each anchored to a published
budgeting standard rather than a number chosen because it looked reasonable:

| Threshold | Rule | Standard |
|---|---|---|
| **Survival** | needs = 100% of take-home | MIT living wage, a subsistence budget with no savings |
| **Getting by** | needs = 70% of take-home | the 70/20/10 budget |
| **Comfortable** | needs = 50% of take-home | the 50/30/20 rule |

Those salaries are found by **inverting the tax engine** numerically, so they
stay correct for every state, bracket, payroll levy and city tax automatically,
including the kinks at the Social Security wage cap and the Additional Medicare
threshold, which have no closed form.

## Data

| What | Source | Coverage | Refresh |
|---|---|---|---|
| Rent, current | Zillow ZORI | 1,359 counties + 21 metros | weekly, by CI |
| Rent, complete | Census ACS B25031 | 3,123 of 3,142 counties | annual |
| Everything else | MIT Living Wage Calculator | 3,133 counties | annual |
| Tax | Tax Foundation / IRS / SSA | all 50 states + DC | yearly |
| Compensation | Levels.fyi | 7 entry-level packages | dated snapshot |
| Boundaries + names | us-atlas + Census gazetteer | 3,142 counties | static |

**The two rent measures are never mixed into one number.** A single national
ZORI/ACS multiplier was tested against the 1,351 counties carrying both and
rejected: correlation 0.675, median error 11%, 90th-percentile error 27%, with
Pitkin County (Aspen) off by a factor of nine. You switch between them; the site
never converts one into the other.

## What it shows

| View | Answers |
|---|---|
| **Salary ladder** | What does survival cost here, and what does comfortable cost? |
| **Cost breakdown** | Where does the money actually go: groceries, transport, healthcare? |
| **County map** | Where in the country does this salary go furthest? |
| **Ranked bars** | Across the 21 tech hubs, where does rent eat least of monthly pay? |
| **Heatmap** | How do all 21 hubs compare across every reference offer at once? |
| **Small multiples** | How does it change over four years as equity vests? |
| **By state** | What does this state cost, from its cheapest county to its dearest? |
| **Seasonality** | Which month is a lease cheapest to sign here, and is the swing worth planning around? |

## Running it

**A Flask application.** Every figure is computed in Python and fetched; the
browser renders and does no arithmetic. No database — the datasets are committed
JSON, loaded once at boot.

**Requires Python 3.9+ and Node 22+.** Python runs the application. Node runs
the ingests, which are build-time only and never execute in a request.

```bash
git clone https://github.com/varad-more/affordability-index
cd affordability-index

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
npm install                    # Playwright, for the browser tests

npm run serve                  # http://localhost:4173
```

### Why two languages

The engine moved to Python; the ingests did not. They fetch, parse and commit
the datasets on a schedule, they are already tested, and nothing they do happens
inside a request. Rewriting working build-time code to make a language count
tidier is not a reason.

One consequence is named rather than hidden: `src/seasonality.js` and
`app/seasonality.py` are the same decomposition in two languages, because the
build script computes the index and the application prices it. They are pinned
to each other by `tests/test_derived_parity.py`, which asserts the Python
reproduces the JavaScript bit-for-bit on real committed series.

### Tests

```bash
npm run test:py      # 165 engine tests: tax, bands, affordability, seasonality, rollups, parity
npm test             #  59 ingest tests: projection, CSV parsing, dataset shape
npm run test:e2e     #  56 browser tests: asserts the charts actually drew
npm run test:all     # all three
```

`npm run test:e2e` boots the Flask app itself if nothing is already listening.
On a fresh clone Playwright needs its browser once:
`npx playwright install chromium`.

**Two fixtures pin the port.** `tests/fixtures/tax-parity.json` holds 2,067
cases generated from the JavaScript engine immediately before it was deleted —
every federal bracket edge and a dollar either side, the Social Security wage
cap, the Additional Medicare threshold, all 51 states, both city taxes. All
16,536 compared figures are bit-exact, so the assertion is equality rather than
a tolerance: a tolerance would quietly absorb a real arithmetic change, which
for a tax engine is the whole thing worth catching.

`tests/fixtures/derived-parity.json` covers the layers with actual numerical
behaviour — the bisection that inverts the tax engine, and the seasonal
decomposition where an off-by-one in the centring shifts every month by half a
year and still returns twelve plausible numbers.

## Refreshing the data

Every dataset is committed, so a clone is immediately runnable and no ingest is
needed to see the site. Run these only to pull newer figures.

**Order matters.** `build-basemap` writes the county list that three of the other
scripts read, so it goes first on a from-scratch rebuild.

| Step | Command | Writes | When to run |
|---|---|---|---|
| 1 | `npm run build-basemap` | `data/us-basemap.json` | Once. Only if county boundaries or names change. |
| 2 | `npm run fetch-rents` | `data/rents.json` | Monthly. Zillow metro ZORI, the 21 hubs. |
| 3 | `npm run fetch-county-rents` | `data/county-rents.json` | Monthly. Zillow county ZORI. |
| 4 | `npm run build-rent-history` | `data/rent-history.json` | With step 3. Re-reads the same feed's full history for the timing page. |
| 5 | `npm run fetch-acs-rents` | `data/county-acs-rents.json` | Annually, when a new ACS vintage lands. |
| 6 | `npm run fetch-county-living-wage` | `data/county-living-wage.json` | Annually, when MIT updates. Takes about ten minutes. |

`npm run refresh` runs steps 2 through 4, which is the monthly cadence and what
CI does on a schedule.

Step 6 is **resumable**: it loads the existing file first and fetches only the
counties missing from it, so a run interrupted at county 900 picks up at 900.

After any refresh, run **both** unit suites — `npm test` and `npm run test:py`.
The ingest suite checks the shape of what landed; the engine suite checks the
claims the pages make against the data they now hold, so a refresh that breaks a
sentence on the site fails the build rather than shipping quietly.

### Every ingest fails loudly

If a source is unreachable, changes format, drops a tracked metro, or returns
data older than what is already committed, the script exits non-zero and writes
nothing. The last good data stays committed: stale numbers, still labelled with
their real date. No script substitutes placeholders, because a pipeline that
silently falls back to hardcoded values looks identical to a working one for as
long as nobody checks. That is not hypothetical. It is exactly what this project
did before the rewrite, for its entire existence.

## How it stays current

Two GitHub Actions workflows, both in `.github/workflows`:

- **`ci.yml`** runs the engine tests, the ingest tests and the browser tests.
  **It does not deploy.** The site ran on GitHub Pages until the Flask port, and
  Pages serves static files only — it cannot run this. `render.yaml` and the
  `Procfile` are ready for a Python host; wiring the job to one is the remaining
  step. An unwired job beats a job that pretends to deploy.
- **`refresh-data.yml`** runs the rent ingests weekly, re-runs the unit tests
  against the new figures, and commits only if the data actually moved. Zillow's
  monthly release date drifts, so polling weekly catches it without waiting an
  extra month; the commit step no-ops the rest of the time.

The git history of `data/` **is** the freshness record. Every refresh is a dated,
diffable commit, which makes the claim that these numbers are current auditable
rather than asserted.

**Deploying your own:** any host that runs a Python web process. `render.yaml`
is a Render blueprint; the `Procfile` works on Render, Railway and anything
Heroku-shaped. Both start the same command:

```
gunicorn wsgi:app --bind 0.0.0.0:$PORT --workers 2 --threads 4
```

Set **`SITE_ORIGIN`** to the origin the deploy actually answers on. It is what
the canonical tags, the Open Graph URLs, `robots.txt` and `sitemap.xml` are
rendered from, and a staging deploy that inherits the production value will
publish canonical tags pointing at a host it does not control.

Two workers, four threads each. Each process holds about 2 MB of datasets and
every request is CPU-light but never I/O-blocked — nothing here talks to a
database or a third party — so threads are cheap and workers are what cost
memory.

Rolling to a new tax year means editing `src/tax-data.js` and nothing else.

## Things worth knowing about the code

**The map projection is hand-rolled and verified.** The site loads no CDN, so
Albers USA is implemented from scratch in `src/projection.js`. To be sure that
"from scratch" did not mean "subtly wrong", it was checked against `d3-geo`
across 27 named locations and 4,982 grid points, including the antimeridian,
where the Aleutians cross from +179° to −179°. Agreement was exact to
floating-point precision, and the fixtures are committed so the tests keep
pinning it.

**No number is invented to fill a gap.** Where a figure cannot be obtained
honestly the site says so instead: counties with no rent data are drawn in a
no-data fill rather than shaded as cheap, Connecticut is left unshaded because
its 2022 planning regions do not join to Zillow's county geography, and no map
shades a state by what it costs, because no cost figure stands for a whole
state. The state page's map does shade whole states, but by the spread between
their dearest and cheapest county, which is a property of the state itself; DC
has one county and so is drawn as no-data rather than as the most uniform state
in the country.

**The seasonal maths is tested against synthetic series.** A classical
multiplicative decomposition is easy to get subtly wrong: a trailing average
instead of a centred one shifts every peak by six months, and subtracting the
trend instead of dividing by it reads growth as seasonality. So the tests build
series from known trend times known seasonal factors and assert the
decomposition recovers those factors, including through a strong upward trend.

**The tests pin the prose, not just the code.** The unit suite asserts the
factual claims the pages make about the reference offers: that Google's
front-loaded grant decays, that Amazon's back-loaded one climbs past it, that the
evenly-vesting offers stay flat. If the data changes so a claim stops holding,
the tests fail and flag the wording as stale. A sentence the numbers no longer
support is a correctness bug, not a wording nit.

**There are browser tests because HTTP 200 proves nothing.** The pages render
entirely from client-side ES modules; a broken import returns 200 with an empty
panel while asset checks and unit tests both pass. The Playwright suite asserts
the charts actually drew: every county painted, bars in ascending order, the
breakdown summing to its stated total, tooltips, dark mode surviving navigation,
every internal link resolving, and no horizontal overflow at three widths.

## Layout

```
wsgi.py                 gunicorn entrypoint
Procfile, render.yaml   deploy config for a Python host
app/__init__.py         create_app(), the four page routes
app/api.py              the JSON API the pages compute against
app/datasets.py         the committed data, loaded once and indexed
app/tax.py              tax engine (holds no constants)
app/tax_data.py         every bracket and rate, each with its source
app/bands.py            survival / getting by / comfortable, by inverting the tax engine
app/affordability.py    rent against take-home, base salary only in the headline
app/state_rollup.py     a state's median, cheapest and dearest county, all real places
app/seasonality.py      classical multiplicative decomposition
app/templates/          base.html plus one per page; robots.txt and sitemap.xml too
assets/                 rendering only; charts.js and map.js are hand-rolled SVG, zero deps
assets/engine.js        the client side of the API; holds no arithmetic
src/                    build-time JavaScript: projection, CSV, hub list, MIT parser
scripts/                ingests; each fails loudly, none falls back
data/                   committed, dated, diffable
tests/                  pytest — the engine
test/                   node --test — the ingests
e2e/                    playwright — the pages, against a live server
```

Routes are `/`, `/states/`, `/timing/` and `/method/`, and nothing answers at a
`.html` address at all. A test pins that absence, because the tempting fix for a
stray `.html` link is to add the alias back rather than to correct the link.

The chrome — head, nav, footer — lives once, in `base.html`. It used to exist in
four copies, which is why renaming the project took a 69-reference find-and-
replace across four identical navs.

The site is served from its own subdomain rather than as a project page under a
portfolio's apex domain. That is what lets it own `/`, `robots.txt` and
`sitemap.xml`, and it is why local development and production now resolve every
path identically — the prefix that used to differ between them is gone.
`docs/portfolio-redirect/` holds the stub that keeps the old address working.

## Known limitations

The [method page](https://affordability-index.varadmore.me/method/) carries
the full list. The ones that bite hardest:

- **Local income tax is modelled for two cities only:** New York City and
  Philadelphia, the two whose rates could be verified against the taxing
  authority. About a third of counties with data sit in states levying some local
  income tax; those carry an on-screen warning and their take-home is overstated.
- **Compensation is not location-adjusted.** Real packages run 15–25% lower in a
  tier-3 metro than in the Bay Area, but no authoritative per-metro table is
  published and DOL's filed-wage data is bot-blocked. Edit the salary field.
- **Single filer, standard deduction, county-level geography.**
- **A state's median is over counties, not people.** No population figure ships
  with this project, so a state's median county is its middle county by cost, not
  the county half its residents live below.
- **Seasonality is a historical average, not a forecast**, and the median swing
  is only about 2%. Where you move dwarfs when.
- **On the Zillow basis, utilities are missing.** ZORI excludes them and MIT puts
  them in the housing row this project discards. The Census basis includes them.

## Sources

- [Zillow Research, ZORI](https://www.zillow.com/research/data/)
- [US Census Bureau, American Community Survey](https://www.census.gov/programs-surveys/acs)
- [MIT Living Wage Calculator](https://livingwage.mit.edu/)
- [Tax Foundation, 2026 federal brackets](https://taxfoundation.org/data/all/federal/2026-tax-brackets/)
- [Tax Foundation, 2026 state brackets](https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/)
- [SSA, contribution and benefit base](https://www.ssa.gov/oact/cola/cbb.html)
- [Levels.fyi](https://www.levels.fyi/)
- [us-atlas](https://github.com/topojson/us-atlas)

## Licence

MIT.
