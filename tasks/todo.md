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

## County picker, state filter, and the site footer

- [x] **The county `<datalist>` became a real combobox.** A datalist cannot
      control what a row says, so a county could only ever be a bare string —
      no state, no metro, and no indication that the rent basis selected
      publishes nothing for it. Its matching is also the browser's: Chrome
      matches anywhere in the string, Safari only at the start, so "Seattle"
      found King County in one browser and nothing in the other. And it only
      fires `change` on an exact match, so Enter on a half-typed name did
      nothing. Replaced with the ARIA 1.2 combobox pattern in
      `assets/combobox.js`: `aria-activedescendant`, arrows/Home/End/PageUp/
      PageDown, Enter to commit, Escape to revert, Tab takes the highlighted
      row, blur restores. Rows carry name, postal code, state, metro, and the
      rent on the current basis — so a county with no data on that basis is
      visible as such *before* it is chosen.
- [x] **Ranked search, not a substring filter.** "king" matches King County WA,
      Kings County NY, Kingfisher County OK and every county whose metro merely
      contains the word. Scoring puts a leading name match above a word-start
      above a substring above a state or metro hit, so the obvious answer is
      first rather than wherever the alphabet puts it.
- [x] **A state control, as a filter.** Nothing in the data ranks the counties
      of a state — there is no population figure anywhere in the repo — so
      choosing a state does not choose a county on the user's behalf. It
      narrows the list, opens it already narrowed, and zooms the map to the
      state (`zoomToState` in `map.js`, using the state's own path geometry).
      A query with no match inside the chosen state offers "Search all states
      instead" as a row, because an empty list with nothing explaining the
      filter is the dead end this design would otherwise create.
- [x] **Selects stopped looking like the operating system.** `appearance: none`
      plus a chevron drawn from two borders on a rotated square, so the four
      controls in the row read as four of the same thing. The rent-basis option
      labels shortened to the source name; the hint below already carries the
      coverage difference.
- [x] **A real site footer**, identical on all three pages: what the site is,
      where to go, and every source credited with *what it supplies* rather
      than as a bare list of institutions. The freshness line is filled from
      the committed data by `assets/footer.js`, so a stale month cannot be
      baked into three pages at once.
- [x] **Fancier without being louder.** A wash across the top of every page, and
      a folio numeral in the corner of each numbered step, drawn from a CSS
      counter so a reordered panel renumbers itself.

## Verified

131 unit + 45 browser tests (7 new: list behaviour, ranking, keyboard-only
selection, Escape/blur restore, the state filter, the no-match escape hatch, and
the footer on all three pages). Contrast measured on the combobox rows in both
states and on every footer element: lowest is 5.10:1, floor is 4.5. Both fuzz
sweeps clean.

Two bugs found while building, both by the new tests:

- The footer grid's three column minimums do not collapse, so on a 390px phone
  the footer alone forced the document 334px wider than the screen. The layout
  test named the width and the page. Rewritten mobile-first with explicit
  breakpoints.
- With zero matches the popup hid itself, which looks identical to a popup that
  never worked — and it took Escape's only affordance with it, so a query that
  matched nothing could not be backed out of. The list now says "No county
  matches …", and Escape reverts whether or not anything is open.

A third was avoided by measurement rather than found: the hero wash was first
built as a pseudo-element bleeding past the measure with negative `vw` insets.
`overflow: clip` hides the result but `scrollWidth` still grows, which the
layout test measures — and it is a real horizontal scrollbar in any browser
without `clip`. It is a background layer on `body` instead, which can overflow
nothing.

## Modern pass: texture, motion, and a bigger display voice

- [x] **Paper grain over the whole page.** An inline SVG turbulence filter used
      as a *mask* over a flat ink, not as an image — which is what lets its
      colour come from a `light-dark()` token and follow the theme, with no
      texture file to serve and no third-party request.
- [x] **Display type went up a step.** The headline is now
      `clamp(2.5rem, 5.8vw, 4.15rem)` at optical size 144 with tighter tracking,
      and the stat numerals at opsz 72. A probe of the shipped subset confirmed
      it exposes `opsz` and `wght` only — the `"SOFT" 0` in the old h1 rule was
      naming an axis that is not in the file and did nothing.
- [x] **The verdict looks like an answer.** It was typeset as one more paragraph
      with a coloured edge; it now takes the band colour as a wash across the
      block, a heavier chip and a step of type.
- [x] **Read-progress hairline** on the nav and **panel fades** on entry, both on
      scroll/view timelines — no scroll listener, no observer, no JS.
- [x] Scrollbars, `::selection`, panel and tile hover elevation, chip press
      states, `text-wrap: balance` on headings.

## Verified

131 unit + 47 browser tests, and the whole suite run three times over
(`--repeat-each=3`, 144/144) because the new work is timing-sensitive.

Three things the measurements changed:

- **The grain compresses every contrast ratio on the site**, because it
  composites over text and background alike rather than darkening one against
  the other. Nothing in the stylesheet says which pairs that endangers, and the
  token audit cannot see it at all — it reads declared colours, not rendered
  ones. Measured across all 964 text nodes on three pages in both themes with
  the grain at *full* alpha (the mask averages about half): 0 failures, tightest
  4.76:1 against a 4.5 floor. Now a test.
- **The panel entry animation translated 26px, and that was wrong.** A panel is
  up to a thousand pixels of map and chart, and sliding it moves a target out
  from under a pointer already reaching for it. It also made every test that
  drives the mouse by coordinate racy — the same defect wearing a lab coat.
  Opacity only now, asserted by a test that fails if a transform reappears.
- **Print has no scroll**, so a view timeline never advances and every panel
  below the first would have come out of the printer blank.

Two false alarms worth recording, both in the measuring rather than the page:

- `color-mix()` computes to `color(srgb r g b / a)` with channels in 0-1, and
  round-tripping through the `color` property does not normalise it. Read as
  0-255 that is near-black, which reported the perfectly legible nav as failing
  at 1.10:1.
- After a `color-scheme` flip, Chromium does not refresh every `light-dark()`
  consumer promptly — anchors lagged a palette behind for longer than two
  animation frames, reporting eighteen contrast failures that do not exist.
  Clicking the real toggle and waiting gives the correct colours, so the page is
  fine and the measurement needed to settle.

---

## Review: production readiness pass (2026-07-26)

Everything in this pass was requested in one batch: production review, product
name, clean URLs, bug hunt, field check, commit consolidation, repo metadata.

### Done

- [x] **Product name kept.** Brainstormed alternatives (Countywise, What It
      Takes, Priced In, Salary Floor) and researched collisions: "salary floor"
      is an established HR term for an employer's pay minimum, which is a
      different quantity from what this site computes. Name stays as it is.
- [x] **Clean URLs without a server.** Pages moved to `states/index.html`,
      `timing/index.html`, `method/index.html`, served at `/states/` etc.
      Flask was rejected: Pages runs no process. React was rejected: it adds a
      build step to a project whose selling point is not having one.
- [x] `assets/data.js` resolves data paths against the module, not the document,
      so one path works at every page depth.
- [x] Redirect stubs at `timing.html` and `method.html`, the two URLs that were
      already public.
- [x] `scripts/serve.mjs` now does directory indexes and the trailing-slash
      redirect, so local serving matches Pages.
- [x] Method page: `Reproducing it` replaced with a claim-to-file map. New
      section documenting how a state gets a number, which was undocumented.
- [x] README: full reproduction guide, pipeline in dependency order.
- [x] History: 20 commits to 15, trivial ci/docs commits folded into parents.
- [x] Repo description, homepage and 14 topics set.
- [x] Open Graph, Twitter card and canonical URL on all four pages; 404 page.

### Bugs found and fixed in this pass

- The weekly refresh workflow updated the map's rent data but never rebuilt
  `rent-history.json` from the same feed, so the timing page would have drifted
  to naming an older month than the rest of the site.
- `scripts/fetch-living-wage.mjs` and `data/living-wage.json` were dead. The
  county ingest superseded them and nothing had read them since.
- The timing and method pages were missing the skip link the other two had.
- `npm run refresh` pulled the annual ACS source on a monthly cadence.
- README cited ACS table B25064; the ingest has used B25031 since it superseded
  B25064.

### Verified, not assumed

- 144 unit + 52 browser tests pass. Two new browser tests cover the redirects
  and assert every internal link on every page resolves.
- Every count printed on the method page checked against the committed data:
  3,142 basemap counties, 3,123 ACS, 2,920 with a 1BR figure, 3,133 living wage,
  1,359 ZORI, 51 states plus DC.
- CI green on the rewritten history, including the Pages deploy.

### Not done

- Repo is still private. Making it public is the user's call.
- ACS B25058, B25077, Zillow ZHVI and ZORI-by-ZIP remain unapproved and
  unstarted.

## Review: a map on the By state page (2026-07-26)

Asked for: "By state should also have a state heat map. And more focused on
county or cities."

### What shipped

A map in a new **Step two** on `/states/`, with two views behind one toggle.
The existing steps renumbered (tax is now three, "Inside <state>" is four).

- **Every county** (default). County fills on the needs-share ramp, exactly the
  encoding the explore page uses, and framed on the selected state rather than
  on the whole country. Clicking a county moves the entire page to its state.
  This is the "more focused on county" half.
- **Whole states**. A genuine state choropleth, shaded by the **spread** between
  a state's dearest and cheapest county. Opens at 1x, because comparing states
  is the point. Clicking a state selects it.

### Why the state view shades spread and not cost

The site's standing rule is that a choropleth is only honest when one value
stands for the whole shaded area, which is why nothing here has ever shaded a
state. Cost still fails that test. Spread passes it: "the two ends of this state
are 1.7x apart" is a statement about the state, not a figure imputed to every
square mile in it. It is also this page's own argument drawn as a picture, since
the darker a state, the less its name told you.

Class breaks are round and fixed: 15, 25, 35, 45, 60, 80 percent dearer. Fixed
across both rent bases on purpose, so switching the basis shows a change in the
data rather than a change in the scale under it. On ACS that fills all seven
steps: 3 / 3 / 13 / 8 / 12 / 8 / 2.

### Bugs found and fixed in this pass

- **A one-county state was painted "most uniform".** `rollUpState` gives a
  single county a spread of exactly 1.00, which lands in the lightest class and
  claims the state was measured and found uniform. DC is permanently in that
  position. Now checked on `roll.n > 1` and drawn as no-data. Caught by a test
  written before the code was right, not after.
- **`.map-hint` was 11.5px** between 561 and 620px wide, missed by the earlier
  mobile pass because it inherits from `.map-status` rather than setting its own
  size. Pre-existing on the explore page.

### Verified

- 144 unit + 55 browser tests pass, up from 53. The two new ones assert the
  county view is the default and is a county fill, that the frame opens on the
  selected state, that a county click moves the page, that all 51 states take a
  fill spanning the ramp, that DC is no-data, that the legend names what the
  fill means, and that leaving state view clears the state fills.
- Both views checked on both rent bases, in light and dark, at 1280px and 390px:
  no console errors, no horizontal overflow, no tap target under 24px.
- Switching the rent basis no longer re-frames the map, so a reader comparing
  two sources keeps their place.

### Copy corrected

Three places asserted "no state fill anywhere", which is no longer true: the
states page footnote, the method page's "Why counties, and why not states", and
the README. Each now says what the one state fill encodes and why it qualifies.

## Review: rename, and a subdomain of its own (2026-07-26)

Moved the site off `varadmore.me/Tech-affordability-index/` and onto
`affordability-index.varadmore.me`, renamed to **Affordability Index**, and
audited it for going public.

### Why the name changed

Both words in the old name had drifted from the product. **"Tech"** describes 7
reference offers and 21 hubs bolted onto a tool that covers all 3,142 counties
and any salary typed in. **"Index"** promises a single composite score, and the
site's strongest opinion is a refusal to produce one — it will not even shade a
state by cost, on the grounds that no one number stands for a whole place. The
first word was dropped. The second was kept: it was the user's call, and the
subdomain reads better for it.

### Why a subdomain is better than a project path

Not cosmetic. A project page under an apex domain cannot own `/`, so it can have
no `robots.txt` and no `sitemap.xml` — both belong to whoever owns the root, and
that was the portfolio. Both now exist here.

It also closed a standing dev/prod divergence: `npm run serve` has always served
from a root while production served from `/Tech-affordability-index/`, which is
exactly why `404.html`'s absolute links were correct in production and dead
locally, and why nothing caught it. The two now resolve every path identically.

### Decisions

**No `<lastmod>` in the sitemap.** A hand-written date is wrong within a week of
the next data refresh and nothing would catch it — the same failure mode this
project refuses everywhere else. Crawlers discount lastmod they cannot trust.

**The old URL gets a redirect, not a 404.** `docs/portfolio-redirect/` holds one
stub for the portfolio repo. It carries a canonical, which is the part that
actually transfers ranking; the refresh and the script only move humans. One
file covers all four paths because it rewrites the prefix from the path it was
served from rather than hardcoding a destination.

**Held the push until DNS exists.** The apex is on GitHub's four A records and
`www` is a CNAME, but there is no wildcard, so the new host resolved to nothing.
Pushing would have taken the portfolio's live link down with nothing to replace
it — the rename and the domain move are coupled, since a project page's path is
derived from the repo name.

### Verified

- 144 unit + **56** browser tests pass, up from 55.
- 69 references rewritten across 8 files; a grep for the old name and old URL
  returns nothing outside this log, where the old name is history rather than a
  claim.
- No secrets, no credentials, no personal data anywhere in the tree. MIT licence
  present. 25 MB working tree, largest tracked file 728 KB.
- `assets/og-card.jpg` needed no regeneration — it is a crop of the hero taken
  below the nav, so the brand name never appears in it.

### New test

**`every canonical and share URL names the deployed domain`** reads `CNAME` —
the file that actually decides where the site lives — and requires every
canonical, `og:url` and `og:image` to agree with it, stubs included. This is the
one class of bug a rendering test cannot see: a canonical pointing at a domain
the site no longer occupies looks perfect on screen while telling search engines
the page duplicates something that no longer exists.

`404.html` also joined the internal-link test, which was only possible once the
site owned a domain root.

### The `.html` stubs went too

`timing.html` and `method.html` were kept "because those two URLs were public
before the move" — but the move they referred to was the clean-URL move on the
*old* domain. On `affordability-index.varadmore.me` those addresses have never
existed, nothing links to them, and they are not in the sitemap. They preserved
nothing, so they are deleted and a test now pins their absence: the tempting fix
for a stray `.html` link is to add the alias back rather than correct the link.

This forced a fix in `docs/portfolio-redirect/`. Its script had been forwarding
the old path verbatim, which for `timing.html` would now land on a 404. It maps
`.html` addresses onto the clean ones instead.

## Review: the Flask port (2026-07-26)

Converted the site from static files on GitHub Pages to a Flask application.
205 pytest + 59 Node + 56 browser tests pass. The JavaScript engine is deleted.

### How the port was made safe

The bracket tables were **generated, not retyped**. Fifty states and 156
brackets is exactly where hand-transcription puts a silent numeric bug, and a
wrong digit in a marginal rate is invisible in review and wrong in every figure
downstream.

Then it was **proved rather than reviewed**. `tests/fixtures/tax-parity.json`
holds 2,067 cases dumped from the JavaScript engine immediately before deletion,
weighted to where a progressive engine goes wrong. All 16,536 compared figures
came back bit-exact, so the assertion is equality rather than a tolerance — a
tolerance would quietly absorb a real arithmetic change.

### Bugs found

- **The server ignored the unit-size selector.** The explore page defaults to
  ACS one-bedroom and the API always answered all-bedroom: $222/month on King
  County, in the map fill as well as the panel.
- **The map and the tooltip disagreed over city tax.** Pre-existing. The fill
  used state-only tax while the tooltip included the city's, so Manhattan read
  one way in the map and another on hover — a $468/month gap at $156k.
- **`/api/meta` flattened the state table** to `{code: name}`, so
  `STATES[code].name` was undefined on two pages and the By-state tax panel
  threw on a bracket table that was not there.
- **The By-state heatmap built its columns at module scope** from a category
  list that arrives at boot, capturing an empty array.
- **Both pages wrote load failures into an already-hidden element.** That is why
  the three above stayed invisible: the page looked fine and was half-drawn.
- **pytest never imported the Flask app.** Every other test imports a maths
  module directly, so a NameError in `app/datasets.py` passed the entire unit
  suite and surfaced only in the browser tests. `tests/test_app.py` closes it.

### Performance

Measured, not guessed. `lru_cache` on `priced_counties` and on the `gross_for_net`
bisection took `/api/state/TX` from **44ms to 1.1ms** — Texas needs 254
bisections, one per county. Hand-rolled gzip takes the snapshot from 178 KB to
49 KB; it is fetched on every salary change, and managed platforms do not all
compress at the edge.

43 MB resident per worker with every dataset loaded.

### Known gap

Nothing is deployed. Pages cannot run Flask, so the site is currently live
nowhere. `render.yaml` and the `Procfile` are ready; the host and the DNS record
are not.

---

## Review: back to static, and actually live (2026-07-26)

Closes the gap the previous section ended on. The site is serving at
**https://affordability-index.varadmore.me/** — four pages, HTTPS, a valid
certificate, no console errors.

### Why the previous plan could not work

The subdomain CNAMEs to GitHub Pages, and **Pages serves files; it runs no
code.** Flask needs a process. Two separate faults were stacked:

1. No repository claimed the domain. `dist/CNAME` had been deleted during the
   port, so GitHub answered 404 for a hostname that resolved to it perfectly.
2. Even claimed, Pages could never have executed the application.

`render.yaml` and the `Procfile` were my answer to (2), and they were the wrong
answer to the question actually being asked, which was "keep this on Pages".

### The idea that made static viable

A reader types any salary, so the answers cannot be precomputed; and
reimplementing the tax engine in JavaScript would put fifty states of brackets
in a second language. Neither was necessary, because of a property of the tax
code:

> Every component of the liability is **piecewise linear in gross wages**, and
> every kink is a known constant — bracket edges, the Social Security wage base,
> the Additional Medicare threshold, payroll caps.

So Python evaluates the engine at each kink and publishes the knot points; the
browser interpolates. Exact, not approximate — between two knots the function
genuinely is a straight line. 733 knots, ~20 KB, and the browser holds one
multiply and one add.

Verified before a line was built on it: 111,440 samples across all 53
jurisdictions, worst error 3.7e-9 dollars.

### What that bought

| | Before (Flask API) | After (static) |
|---|---|---|
| Salary change | 178 KB round trip | no network at all |
| Per rent basis | — | 50–88 KB, fetched once |
| Browser suite | 4.6 min | 19 s |
| Hosting | a Python process, cold starts | files |

### Bugs found and fixed in this pass

- **New York has a real $25,000,000 bracket edge**, which sat above the fixed
  sentinel knot and left the knot array unsorted. Every binary search over it
  was silently wrong.
- **`Locality` carried no state**, so the city-tax curve had to hardcode the
  NYC/PHL mapping to find the right standard deduction. A third city would have
  silently taken New York's.
- **A duplicate `"local"` key** in the fixture generator: the tax amount
  overwrote the jurisdiction code.
- **`affordability()` evaluated the engine while the browser evaluated the
  curve**, so they disagreed in the last bit. Python now has one evaluation path.
- **A data refresh could never have reached the site.** GitHub deliberately does
  not let a push made with `GITHUB_TOKEN` trigger another workflow, so the weekly
  ingest would have committed new rents and published nothing — the exact
  staleness this project exists to complain about.

### Verified, not assumed

- **582 tests**: 460 pytest, 59 Node, 63 browser. All green in CI.
- **The browser's arithmetic is proved against Python**, not reviewed: 1,284
  cases, compared **exactly**, bit for bit. Both ends pinned, so neither can be
  edited into agreement.
- **One test asserts the negative** — that no tax constant appears in any shipped
  JavaScript outside a comment.
- **The browser suite runs against `dist/`**, the artefact Pages publishes, with
  Pages' own redirect and 404 behaviour reproduced locally.
- **Live checks**: all four pages 200, `/states` → 301, unknown path → the site's
  own 404, canonical tags and CNAME agreeing.

### Not done, deliberately

- **No rate limiting.** There is nothing left to rate-limit: the site is files.
  This is now solved by the architecture rather than deferred.
- **`tasks/todo.md` is still tracked.** It is an internal log, and this entry is
  the first that describes the architecture that actually ships.
