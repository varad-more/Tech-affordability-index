# County-level affordability: salary bands, FAANG presets, US map

## The gap this closed

The site answered **"I have an offer — where does it go furthest?"** That is the
*second* question a junior engineer asks. The first is **"is this offer even enough
to live there?"**, and a rent-share chart cannot answer it: 30%-of-net says nothing
about whether the other 70% covers groceries, a car and health insurance in that
specific place.

So the model became absolute — `needs = rent + everything else`, then invert the tax
engine to the salary that clears it. That turns a ranking into a verdict.

## Delivered

- [x] `src/bands.js` — survival / getting by / comfortable, via `grossForNet()` bisection
- [x] `src/projection.js` — Albers USA, **bit-exact against d3-geo** over 27 named points
      and 4,982 grid points; fixtures committed
- [x] `scripts/build-basemap.mjs` — TopoJSON + Census gazetteer → projected SVG paths
- [x] `scripts/fetch-county-rents.mjs` — county ZORI (1,359 counties)
- [x] `scripts/fetch-acs-rents.mjs` — Census ACS B25064 (3,123 counties, keyless)
- [x] `scripts/fetch-county-living-wage.mjs` — MIT, all 3,133 counties, with per-category
      breakdown, resumable
- [x] `src/tax-data.js` — expanded from 21 states to **all 50 + DC**
- [x] `data/profiles.json` — 7 real entry-level packages (Levels.fyi, dated)
- [x] County choropleth, salary ladder (bullet chart), cost breakdown (stacked bar)
- [x] `method.html` — full methodology, sources, and limitations
- [x] 111 unit tests + 20 browser tests, all passing

## Decisions worth remembering

**Rejected: calibrating ACS to ZORI.** Tested a single national multiplier on the
1,351 counties carrying both — correlation 0.675, median error 11%, p90 27%, Pitkin
County off by 9×. An 11% rent error moves the salary thresholds by the same
proportion. Shipped both bases as a toggle instead; the site never converts one into
the other.

**Rejected: modelling Maryland and Indiana county income tax.** Both are genuinely
county-level and would fit the data model, but the Comptroller's and DOR's own
schedules are PDFs that could not be read reliably, and Maryland moved two counties to
tiered rates for 2026. Transcribing 116 rates from aggregator summaries was the exact
failure mode already caught once with Philadelphia (a search summary said 2.235%; the
city publishes 3.735%). Flagged per-county on screen instead.

**Rejected: state choropleth.** Texas holds Austin *and* Dallas; California holds four
metros that disagree. Any state fill invents a number none of them supports. Counties
are the level at which one value per shaded area is actually true.

**Map paints the continuous share, not the four bands.** At $156k, 92% of counties land
in "comfortable" — a four-class map would be one colour. Class breaks are the named
standards (50/70/100%) plus three that subdivide the crowded low end.

## Not done, deliberately

- **Location-adjusted pay.** Real packages run 15–25% lower in tier-3 metros. No
  authoritative per-metro table is public and DOL's LCA disclosure data returns 403 to
  automated requests. Presets are labelled national medians; the field is editable.
- **State paid-leave payroll levies beyond CA and WA.** A dozen states run them at
  0.3–0.7% of wages; rates move yearly and several are mid-phase-in. Declared as a
  known overstatement rather than guessed.
- **Connecticut cost data.** It replaced counties with planning regions in 2022, so
  Zillow's geography and MIT's no longer join. Left unshaded rather than mapped
  approximately.
