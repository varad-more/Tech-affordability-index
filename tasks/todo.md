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

---

# Visual design pass — "beautify, make it aesthetic and appealing"

Investigated by rendering the page and measuring it, not by reading the CSS.

## Defects found by looking

- [x] **Disabled map buttons are see-through.** `.map-btn:disabled { opacity: .45 }`
      fades the button's *background* too, so at 1.0× the map's blue counties show
      through the zoom-out control. The CSS comment beside that rule says a faded
      button "reads as a control that failed to render" — which is exactly what it
      does. Fade the icon, keep the surface opaque.
- [x] **The heatmap wastes 113px of vertical space** and draws its type at 0.82×.
      Measured: box 970×636, content drawn 970×523. `svg { max-width: 100% }` shrinks
      the width while `height="636"` stays put, so `preserveAspectRatio` centres the
      content and leaves dead bands above and below. It is the only chart wider than
      its container, so it is the only one affected.
- [x] **`svg { max-width: 100% }` has no `height: auto`.** That pairing is the actual
      bug class behind the above; fix it globally so no future wide chart repeats it.

## Design work

- [x] Type scale and numerals — tabular figures on every displayed figure
- [x] Hero fills its width instead of stopping mid-line at desktop
- [x] The three "Step" panels read as a numbered sequence
- [x] Stat tiles: stronger hierarchy, semantic colour on left-over / short-by
- [x] Verdict: the band colour should actually carry the answer
- [x] Inputs: currency adornment, better hover/focus
- [x] Nav, footer, method + timing pages consistent with the above

## Constraints that do not move

Zero dependencies, no CDN, no build step. Dark mode stepped from the ramps, never
flipped. Every colour still passes `scripts/validate_palette.js`. 131 unit tests and
29 browser tests stay green.

## Review

**The two defects were found by rendering the page and measuring it, not by
reading the CSS.** Both had been shipped and neither was visible in the source:

- The heatmap's dead space measured 113px — box 970×636 around 523px of drawing.
  The cause was `max-width: 100%` with no `height: auto`, and the same pairing
  was capping the chart at 82% scale, so 10.5px labels were rendering at 8.6px.
- The disabled zoom-out button was letting the map show through itself, because
  `opacity` fades an element's background along with its content.

Fixing the first properly meant confronting a thing the fixed 880px width had
been hiding: **every chart was either padding a panel or being scaled down, and
never the size it was drawn at.** Sizing them to the container fixed both ends.
The floor is now 300px rather than 880 — deliberately below a phone column,
because these forms do work at ~330px and drawing them there keeps the labels at
their design size, where the old scaling put axis text at 6.5px.

The heatmap is the exception and now says so in code: seven columns of "13.2%"
need ~700px however they are arranged, so it opts out of `max-width` and scrolls.
`.chart-scroll` finally does something — it had been dead code, since nothing
could overflow a container everything was capped to.

**What the validator changed.** The dark status pair was picked by eye first;
`validate_palette.js` put the green at L 0.713, outside the dark band's 0.67
ceiling, and it moved to `#33ad38`. It also fails red-against-green at ΔE 4.1
(light) and 2.3 (dark) under deuteranopia — no red/green pair passes that. It
stays, because the two never appear together: one tile is in one state at a time
and its label says which. That reasoning is written next to the rule rather than
here, where nobody editing the rule would find it.

The ramp's pale end fails light-end contrast at 1.29:1. That is pre-existing and
already covered — the relief is every cell carrying a printed value plus a table
view, and there is a test named for it.

**Verified:** 131 unit + 31 browser tests. The two new browser tests were each
run against the reverted code first — they catch 117px of letterboxing, 82px of
unused column, and the transparent button — because a regression test that has
never failed is not evidence of anything.

---

# Editorial redesign

Direction chosen with the user: editorial, not technical or bold.

- [x] **Fraunces, self-hosted.** One 67KB variable woff2 (wght 400-700, opsz
      9-144, latin), committed under `assets/fonts/` with its OFL. Linking it
      would have been the first third-party request the site has ever made, and
      a typeface is not the thing to break that constraint for. Verified: one
      same-origin request, `document.fonts.check` true, zero off-origin entries
      in the resource timeline.
- [x] **Warm ivory ground.** The page is text and thin marks on a large empty
      field, so the field's temperature is most of the character it has. Ink
      warmed to match; dark stepped to a brown-black rather than a blue-black so
      the two themes read as one publication at different times of day.
- [x] **One indigo family.** The interface accent and the data ramp used to be
      two unrelated blues. The ramp was re-stepped and re-validated: monotone
      lightness, adjacent ΔL, single hue at 5° spread all pass.
- [x] **Palette declared once.** Three copies of every colour — a light block, a
      `prefers-color-scheme` block and a `[data-theme]` block — collapsed into
      `light-dark()`. The last two were byte-identical duplicates that had to be
      edited in lockstep, and they had already drifted once.
- [x] Display type on headlines, the wordmark and the figures; rules and a
      numbered sequence for the steps; paint-order halos so value labels survive
      crossing the threshold rule.

## Verified

131 unit + 38 browser tests. Contrast measured on every text node of all three
pages in both themes: method and timing clean, index clean apart from heatmap
cell text, which was checked separately against each cell's own fill (147 cells,
0 under 4.5:1, both themes). Both fuzz sweeps clean. The contrast test caught a
regression in the new palette before it shipped, which is what it is for.
