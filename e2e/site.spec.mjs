import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';


const read = (name) =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

const rents = read('rents.json');
const profiles = read('profiles.json');
const basemap = read('us-basemap.json');

const HUB_COUNT = rents.hubs.length;
const PROFILE_COUNT = profiles.profiles.length;
const COUNTY_COUNT = basemap.counties.length;

/**
 * Fails the test on any console error or uncaught exception.
 *
 * The page renders entirely from client-side ES modules, so a broken import or
 * a thrown error produces a blank panel that still returns HTTP 200. Asset
 * checks alone cannot catch that; only a real browser can.
 */
function watchForErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  return errors;
}

/**
 * Scroll a panel fully into view and wait for its entry fade to complete.
 *
 * Panels fade in on a scroll-driven view timeline, so one sitting at the bottom
 * edge of the viewport is part-way through. The fade moves no geometry, so a
 * coordinate read is safe either way — this exists so that what a test measures
 * is the settled state rather than a frame of the transition.
 */
async function settled(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForFunction((sel) => {
    const panel = document.querySelector(sel)?.closest('section.panel');
    return !panel || Number(getComputedStyle(panel).opacity) === 1;
  }, selector);
}

/** The app is hidden behind a loading panel until every dataset has arrived. */
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#map .map-county').first()).toBeVisible({ timeout: 30_000 });
  // The map is built before its fills are fetched, so being present is not the
  // same as being painted. Every assertion downstream reads real figures.
  await expect(page.locator('#map')).toHaveAttribute('data-painted', 'true', { timeout: 30_000 });
  await expect(page.locator('.stat')).toHaveCount(4);
}

test.describe('affordability index', () => {
  test('loads and renders every view without console errors', async ({ page }) => {
    const errors = watchForErrors(page);
    await ready(page);

    // The loading panel must actually go away — a CSS `display` rule can beat
    // the `hidden` attribute and leave it stranded over the content.
    await expect(page.locator('#loading')).toBeHidden();

    const month = new Date(`${rents.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    await expect(page.locator('#freshness')).toContainText(month);

    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * PROFILE_COUNT);
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);
    await expect(page.locator('#table tbody tr')).toHaveCount(HUB_COUNT);

    expect(errors).toEqual([]);
  });

  test('the map draws every county in the country', async ({ page }) => {
    await ready(page);

    // Every county is drawn, including the ones with no data — a map missing a
    // third of the country would still look plausible.
    await expect(page.locator('#map .map-county')).toHaveCount(COUNTY_COUNT);
    await expect(page.locator('#map .map-state')).toHaveCount(51);

    // Most counties must actually be shaded, not left on the no-data fill.
    const shaded = await page.locator('#map .map-county').evaluateAll((nodes) =>
      nodes.filter((n) => !n.getAttribute('fill').includes('nodata')).length,
    );
    expect(shaded, 'almost nothing on the map got a value').toBeGreaterThan(3000);
  });

  test('clicking a county selects it and updates the panel', async ({ page }) => {
    await ready(page);
    const before = await page.locator('#county-picker').inputValue();

    // Los Angeles County — large enough to hit reliably, and always has data.
    await page.locator('#map .map-county[data-fips="06037"]').click({ force: true });

    await expect(page.locator('#county-picker')).toHaveValue(/Los Angeles/);
    expect(await page.locator('#county-picker').inputValue()).not.toBe(before);
    await expect(page.locator('#verdict')).toContainText('Los Angeles');
    // The selection outline follows the click.
    await expect(page.locator('#map .map-selected')).toHaveAttribute('d', /^M/);
  });

  test('a costly county demands a higher salary than a cheap one', async ({ page }) => {
    await ready(page);

    const comfortable = async (label) => {
      await page.locator('#county-picker').fill(label);
      await page.locator('#county-picker').dispatchEvent('change');
      await expect(page.locator('#verdict')).toContainText(label.split(' County')[0]);
      const ticks = await page.locator('#ladder .value-label').allTextContents();
      return Number(ticks.at(-1).replace(/[$,]/g, ''));
    };

    const sf = await comfortable('San Francisco County, CA');
    const wichita = await comfortable('Sedgwick County, KS');

    expect(sf, 'San Francisco should demand more than Wichita').toBeGreaterThan(wichita);
  });

  test('switching the rent basis changes the numbers and the coverage', async ({ page }) => {
    await ready(page);

    const rentTile = page.locator('.stat').filter({ hasText: 'Rent' }).first();
    const acsRent = await rentTile.locator('.value').textContent();
    await expect(rentTile).toContainText('Census ACS');

    await page.locator('#rent-basis').selectOption('zori');

    await expect(rentTile).not.toContainText('Census ACS');
    expect(await rentTile.locator('.value').textContent()).not.toBe(acsRent);

    // Zillow covers far fewer counties, so more of the map falls back to no-data.
    const nodata = await page.locator('#map .map-county').evaluateAll((nodes) =>
      nodes.filter((n) => n.getAttribute('fill').includes('nodata')).length,
    );
    expect(nodata, 'ZORI basis should leave many counties unshaded').toBeGreaterThan(1000);

    // The legend has to name the source that is actually silent, or a third of
    // the country reads as "cheap" rather than "unmeasured".
    await expect(page.locator('#map-legend .map-legend-item').last())
      .toHaveAttribute('title', /Zillow ZORI/);
    await page.locator('#rent-basis').selectOption('acs');
    await expect(page.locator('#map-legend .map-legend-item').last())
      .toHaveAttribute('title', /Census ACS/);
  });

  test('unit size changes the rent, and a single adult is priced as one bedroom', async ({ page }) => {
    await ready(page);

    const rentTile = page.locator('.stat').filter({ hasText: 'Rent' }).first();
    const rentValue = async () =>
      Number((await rentTile.locator('.value').textContent()).replace(/[^0-9]/g, ''));

    // Default is one bedroom, because the model prices one adult and an
    // all-bedroom median is inflated by family-sized units.
    await expect(page.locator('#unit-size')).toHaveValue('br1');
    await expect(rentTile).toContainText('1 bedroom');
    const oneBed = await rentValue();

    await page.locator('#unit-size').selectOption('br2');
    await expect(rentTile).toContainText('2 bedrooms');
    expect(await rentValue(), 'a two-bed must cost more than a one-bed').toBeGreaterThan(oneBed);

    await page.locator('#unit-size').selectOption('studio');
    await expect(rentTile).toContainText('Studio');
    expect(await rentValue(), 'a studio must cost less than a one-bed').toBeLessThan(oneBed);

    // Zillow publishes no bedroom split, so the control switches off rather than
    // silently pretending the selection still applies.
    await page.locator('#rent-basis').selectOption('zori');
    await expect(page.locator('#unit-size')).toBeDisabled();
    await expect(rentTile).toContainText('all sizes');
  });

  test('the cost breakdown adds up to the stated total', async ({ page }) => {
    await ready(page);

    const rows = page.locator('#breakdown-table tbody tr');
    await expect(rows).toHaveCount(7); // rent + six MIT categories

    const values = await rows.locator('td:nth-child(2)').allTextContents();
    const sum = values.reduce((n, v) => n + Number(v.replace(/[$,]/g, '')), 0);

    const totalText = await page.locator('#breakdown-table tfoot td').nth(1).textContent();
    const total = Number(totalText.replace(/[$,]/g, ''));

    // Each MIT category is rounded independently, so allow a few dollars of drift.
    expect(Math.abs(sum - total), `components ${sum} vs total ${total}`).toBeLessThanOrEqual(6);

    // Groceries and transport are the figures a reader is most likely to sanity-check.
    await expect(page.locator('#breakdown-table')).toContainText('Groceries');
    await expect(page.locator('#breakdown-table')).toContainText('Transport');
  });

  test('the salary ladder orders its thresholds and marks the salary', async ({ page }) => {
    await ready(page);

    const ticks = await page.locator('#ladder .value-label').allTextContents();
    const nums = ticks.map((t) => Number(t.replace(/[$,]/g, '')));

    expect(nums).toHaveLength(3);
    expect(nums, 'survival < getting by < comfortable').toEqual([...nums].sort((a, b) => a - b));
    await expect(page.locator('#ladder .ladder-marker')).toHaveCount(1);
  });

  test('bars are ranked ascending and the 30% threshold is drawn', async ({ page }) => {
    await ready(page);

    const values = await page.locator('#bars .value-label').allTextContents();
    const nums = values.map((v) => parseFloat(v));

    expect(nums.length).toBe(HUB_COUNT);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));

    await expect(page.locator('#bars .threshold-line')).toHaveCount(1);
    await expect(page.locator('#bars .threshold-label')).toContainText('30%');
  });

  test('no cell is left unlabelled (the relief rule for low-contrast ramp steps)', async ({ page }) => {
    await ready(page);
    const labels = await page.locator('#heatmap .cell-value').allTextContents();

    expect(labels).toHaveLength(HUB_COUNT * PROFILE_COUNT);
    for (const label of labels) expect(label).toMatch(/^\d+\.\d%$/);
  });

  test('switching preset recomputes the numbers', async ({ page }) => {
    await ready(page);

    const before = await page.locator('#bars .value-label').first().textContent();
    const baseBefore = await page.locator('#base').inputValue();

    await page.getByRole('button', { name: /Startup/ }).click();

    await expect(page.locator('#base')).not.toHaveValue(baseBefore);
    await expect(page.locator('#haircut')).toHaveValue('0');
    await expect(page.locator('#bars .value-label').first()).not.toHaveText(before);
  });

  test('editing salary recomputes and marks the offer custom', async ({ page }) => {
    await ready(page);

    const before = parseFloat(await page.locator('#bars .value-label').first().textContent());

    await page.locator('#base').fill('90000');
    await expect(async () => {
      const after = parseFloat(await page.locator('#bars .value-label').first().textContent());
      expect(after).toBeGreaterThan(before);
    }).toPass();

    // Typing over a preset is exactly what "Other" means, so the row has to show
    // that. Leaving every chip unpressed reads as "nothing selected", which is
    // never true — some offer is always driving the numbers on screen.
    await expect(page.locator('.presets button[aria-pressed="true"]')).toHaveText('Other');
    await expect(page.locator('#preset-note')).toContainText(/nothing here is sourced/i);
  });

  test('the Other job carries your own numbers into every comparison', async ({ page }) => {
    await ready(page);
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);

    await page.getByRole('button', { name: 'Other', exact: true }).click();

    // Your offer joins the grid and the vesting panels once it exists, and the
    // company schedule it was seeded from is replaced by a neutral assumption
    // rather than quietly inherited.
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT + 1);
    await expect(page.locator('.multiple').filter({ hasText: 'Your offer' })).toHaveCount(1);
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * (PROFILE_COUNT + 1));
    await expect(page.locator('#preset-note')).toContainText(/even quarters/i);

    // Editing a field keeps you on Other rather than bouncing back to a preset.
    await page.locator('#base').fill('123456');
    await expect(page.locator('.presets button[aria-pressed="true"]')).toHaveText('Other');
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT + 1);

    // Returning to a sourced preset drops it again, so the grid never shows a
    // stale duplicate of a package nobody selected.
    await page.getByRole('button', { name: /Netflix/ }).click();
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);
    await expect(page.locator('#preset-note')).toContainText(/Levels\.fyi/);
  });

  test('the map zooms by wheel and by button, and resets', async ({ page }) => {
    await ready(page);

    const level = page.locator('#map .map-zoom-level');
    const transform = () => page.locator('#map .map-view').getAttribute('transform');

    await expect(level).toHaveText('1.0×');
    const flat = await transform();

    await page.locator('#map .map-btn[data-act="in"]').click();
    await expect(level).not.toHaveText('1.0×');
    expect(await transform(), 'the zoom button did not move the view').not.toBe(flat);

    await page.locator('#map .map-btn[data-act="reset"]').click();
    await expect(level).toHaveText('1.0×');
    expect(await transform()).toBe(flat);

    // The wheel is the gesture most people will actually reach for, and it only
    // works if the handler is non-passive enough to preventDefault.
    await page.locator('#map .map-svg').hover({ position: { x: 240, y: 180 } });
    await page.mouse.wheel(0, -400);
    await expect(level).not.toHaveText('1.0×');
  });

  test('dragging pans the map without selecting what it started over', async ({ page }) => {
    await ready(page);
    const before = await page.locator('#county-picker').inputValue();
    const transform = () => page.locator('#map .map-view').getAttribute('transform');

    // Zoom in first: at 1x the clamp pins the transform, so a drag moves nothing
    // and a sloppy click should still select normally.
    await page.locator('#map .map-btn[data-act="in"]').click();
    await page.locator('#map .map-btn[data-act="in"]').click();
    const anchored = await transform();

    await settled(page, '#map .map-svg');
    const frame = await page.locator('#map .map-svg').boundingBox();
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 140, cy + 40, { steps: 12 });
    await page.mouse.up();

    expect(await transform(), 'the drag did not pan').not.toBe(anchored);

    // A pan ends in a click event. If that click is allowed through, every drag
    // silently reselects whichever county it began on.
    await expect(page.locator('#county-picker')).toHaveValue(before);

    // The map is focusable, so the same zoom is reachable without a pointer.
    await page.locator('#map .map-svg').focus();
    await page.keyboard.press('0');
    await expect(page.locator('#map .map-zoom-level')).toHaveText('1.0×');
  });

  test('zoom to county frames the selected county', async ({ page }) => {
    await ready(page);

    await page.locator('#county-picker').fill('Los Angeles County, CA');
    await page.locator('#county-picker').dispatchEvent('change');
    await page.locator('#map .map-btn[data-act="locate"]').click();

    const zoom = Number((await page.locator('#map .map-zoom-level').textContent()).replace('×', ''));
    expect(zoom, 'zoom to county barely moved').toBeGreaterThan(3);

    // Landing zoomed-in but somewhere else is worse than not zooming at all, so
    // the selected county has to end up near the middle of the frame.
    await settled(page, '#map .map-svg');
    const outline = await page.locator('#map .map-selected').boundingBox();
    const frame = await page.locator('#map .map-svg').boundingBox();
    const dx = outline.x + outline.width / 2 - (frame.x + frame.width / 2);
    const dy = outline.y + outline.height / 2 - (frame.y + frame.height / 2);
    expect(Math.abs(dx)).toBeLessThan(frame.width * 0.1);
    expect(Math.abs(dy)).toBeLessThan(frame.height * 0.1);
  });

  test('a lower salary pushes counties into worse bands', async ({ page }) => {
    await ready(page);

    const darkCount = () =>
      page.locator('#map .map-county').evaluateAll((nodes) =>
        // seq-5 and above are the strained classes.
        nodes.filter((n) => /seq-(5|6|7)/.test(n.getAttribute('fill'))).length,
      );

    const richly = await darkCount();
    await page.locator('#base').fill('45000');
    await expect(async () => {
      expect(await darkCount()).toBeGreaterThan(richly);
    }).toPass();
  });

  test('a zero-income-tax metro nets more than California at equal pay', async ({ page }) => {
    await ready(page);
    await expect(page.locator('#table tbody tr')).toHaveCount(HUB_COUNT);

    const netOf = async (city) => {
      const row = page.locator('#table tbody tr').filter({ hasText: city }).first();
      const text = await row.locator('td').nth(4).textContent();
      return Number(text.replace(/[$,]/g, ''));
    };

    expect(await netOf('Austin')).toBeGreaterThan(await netOf('San Francisco'));
    expect(await netOf('Austin')).toBeGreaterThan(await netOf('New York'));
  });

  test('counties with unmodelled local income tax say so', async ({ page }) => {
    await ready(page);

    // Franklin County, Ohio (Columbus) — Ohio municipalities levy an income tax
    // that this engine does not compute, and hiding that would overstate pay.
    await page.locator('#county-picker').fill('Franklin County, OH');
    await page.locator('#county-picker').dispatchEvent('change');

    await expect(page.locator('#local-tax-warning')).toBeVisible();
    await expect(page.locator('#local-tax-warning')).toContainText(/not included/i);

    // King County, WA has no local income tax, so no warning.
    await page.locator('#county-picker').fill('King County, WA');
    await page.locator('#county-picker').dispatchEvent('change');
    await expect(page.locator('#local-tax-warning')).toBeHidden();
  });

  test('dark mode redraws without errors and survives navigation', async ({ page }) => {
    const errors = watchForErrors(page);
    await ready(page);

    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * PROFILE_COUNT);

    // The choice is stored, so following a link must not silently reset it.
    await page.goto('/method/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    expect(errors).toEqual([]);
  });

  test('vesting panels share one scale and actually show shape', async ({ page }) => {
    await ready(page);
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);
    await expect(page.locator('#multiples-caption')).toContainText('share one vertical scale');

    const dotYs = async (company) => {
      const panel = page.locator('.multiple').filter({ hasText: company }).first();
      return panel
        .locator('.spark-dot')
        .evaluateAll((dots) => dots.map((d) => Number(d.getAttribute('cy'))));
    };

    // Google's grant vests 33/33/22/12, so pay falls over time and the curve must
    // visibly climb. A flat line here means the y-domain collapsed.
    const google = await dotYs('Google');
    expect(google.length).toBe(4);
    expect(
      Math.max(...google) - Math.min(...google),
      'front-loaded vesting curve is flat — y-domain collapsed',
    ).toBeGreaterThan(15);

    // Netflix and Microsoft are both perfectly flat but sit at opposite ends of
    // the range — 17.3% against 23.3% of take-home in Seattle. If each panel
    // self-scaled, two flat lines would both render mid-panel at the same height;
    // a shared domain forces them apart, and cheaper must sit lower on the plot.
    const [netflix, microsoft] = [await dotYs('Netflix'), await dotYs('Microsoft')];
    expect(
      netflix[0] - microsoft[0],
      'panels are not on a shared scale — two very different values drew at the same height',
    ).toBeGreaterThan(20);

    // A shared domain inside each SVG is not enough: the plot areas must also line
    // up on the page, or a longer description pushes its chart down and a panel
    // looks lower than a neighbour whose value is actually higher.
    //
    // The panels wrap across grid rows, so alignment is only meaningful WITHIN a
    // row — comparing a first-row panel against a second-row one just measures
    // the row height.
    const tops = await page.locator('.multiple .plot svg').evaluateAll((svgs) =>
      svgs.map((s) => Math.round(s.getBoundingClientRect().top)),
    );
    expect(tops).toHaveLength(PROFILE_COUNT);

    const rows = new Map();
    for (const top of tops) {
      const key = [...rows.keys()].find((k) => Math.abs(k - top) < 60) ?? top;
      rows.set(key, [...(rows.get(key) ?? []), top]);
    }
    expect(rows.size, 'expected the panels to wrap into at least one row').toBeGreaterThan(0);

    for (const [, row] of rows) {
      expect(
        Math.max(...row) - Math.min(...row),
        'plot areas are not vertically aligned within a row',
      ).toBeLessThanOrEqual(2);
    }
  });

  test('tooltips appear on hover, on both the bars and the map', async ({ page }) => {
    await ready(page);

    await page.locator('#bars .bar-row').first().hover();
    const tip = page.locator('#tooltip');
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText('Take-home');

    await page.locator('#map .map-county[data-fips="06037"]').hover({ force: true });
    await expect(tip).toContainText('Los Angeles');
  });

  test('no page ever scrolls horizontally', async ({ page }) => {
    // Every page, at three widths. The nav is the usual culprit: it has no
    // scroll container of its own, so adding a link can silently widen the page.
    for (const path of ['/', '/states/', '/timing/', '/method/']) {
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);

        if (path === '/') await expect(page.locator('.stat')).toHaveCount(4);
        else await expect(page.locator('h1')).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('clearing the salary to retype it does not empty the page', async ({ page }) => {
    await ready(page);
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);

    // Reported as the site "shutting down" when the salary was edited. Selecting
    // the field and deleting it leaves `value === ''`, `Number('')` is 0, and a
    // $0 salary makes every ratio undefined — so for the moment between deleting
    // the old figure and typing the new one, every chart on the page emptied.
    await page.locator('#base').fill('');
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
    await expect(page.locator('#verdict')).toContainText('$156,000');

    await page.locator('#base').fill('90000');
    await expect(page.locator('#verdict')).toContainText('$90,000');
  });

  test('a salary of zero explains itself instead of drawing nothing', async ({ page }) => {
    await ready(page);

    // Zero is a real thing to type, unlike an empty box. The charts cannot plot
    // a share of nothing, so they say so — an empty frame is indistinguishable
    // from a chart that failed to load.
    await page.locator('#base').fill('0');
    await expect(page.locator('#bars .chart-empty')).toBeVisible();
    await expect(page.locator('#bars .chart-empty')).toContainText(/take-home/i);

    await page.locator('#base').fill('150000');
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
    await expect(page.locator('#bars .chart-empty')).toHaveCount(0);
  });

  test('no input can drive a NaN into the drawing', async ({ page }) => {
    await ready(page);

    // `type="number"` accepts exponent notation, so the largest double is one
    // paste away. It is finite, but twelve times it is not.
    for (const value of ['1e999', '1.7976931348623157e308', '-5000', '0.5']) {
      await page.locator('#base').evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);

      // Scoped to the charts the salary drives. Sweeping every `svg *` would
      // also walk the basemap's 3,142 path outlines, whose `d` attributes are
      // enormous and never change with an input — thirty seconds of scanning
      // geometry that cannot be the thing under test.
      const bad = await page.evaluate(() => {
        const hits = [];
        for (const mount of document.querySelectorAll('#bars, #ladder, #breakdown, #heatmap, #multiples')) {
          for (const node of mount.querySelectorAll('svg *')) {
            for (const attr of node.attributes) {
              if (/NaN|Infinity/.test(attr.value)) hits.push(`${node.tagName}[${attr.name}]`);
            }
          }
        }
        return hits;
      });
      expect(bad, `base="${value}" produced ${bad.join(', ')}`).toEqual([]);
    }
  });

  test('a part-typed salary does not hang the page', async ({ page }) => {
    await ready(page);

    // Typing "150000" into an empty field means the salary is briefly 1, then
    // 15, then 150. Take-home is the denominator of the bar chart, so at $1 the
    // ratio is astronomical — and the gridlines were drawn with a fixed `v +=
    // 0.1` up to it, which queued millions of nodes and froze the tab for
    // eleven seconds. This is the freeze that got reported as a crash.
    for (const value of ['1', '15', '150', '150000']) {
      const { ms, gridlines } = await page.locator('#base').evaluate((el, v) => {
        el.value = v;
        const started = performance.now();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          ms: performance.now() - started,
          gridlines: document.querySelectorAll('#bars .tick-line').length,
        };
      }, value);

      expect(gridlines, `base="${value}" drew ${gridlines} gridlines`).toBeLessThan(20);
      expect(ms, `base="${value}" took ${Math.round(ms)}ms to render`).toBeLessThan(2000);
    }

    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
  });

  test('a tooltip does not outlive the mark it describes', async ({ page }) => {
    await ready(page);

    await page.locator('#bars .bar-row').first().hover();
    await expect(page.locator('#tooltip')).toHaveClass(/\bon\b/);

    // Redrawing removes the bar out from under the cursor, and `mouseleave`
    // never fires for a node that is deleted rather than left.
    await page.locator('#base').fill('99000');
    await expect(page.locator('#tooltip')).not.toHaveClass(/\bon\b/);
  });

  test('the page still works when localStorage is unavailable', async ({ page }) => {
    // Blocked cookies and some private modes throw on *access*, not just write.
    // The stored theme read sat in the load path, so one throw took out the
    // whole site rather than just the remembered preference.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new Error('localStorage is blocked'); },
      });
    });
    await ready(page);

    await expect(page.locator('.stat')).toHaveCount(4);
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
    await page.locator('#theme-toggle').click();
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
  });

  test('a chart box is the size of the chart, and fills its column', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await ready(page);

    // An SVG carrying both a width attribute and `max-width: 100%` will shrink
    // its width and keep its height, so preserveAspectRatio centres the drawing
    // and pads it with dead space. The heatmap did exactly that: a 636px box
    // around 523px of picture. The box must be the size of what is drawn in it.
    for (const sel of ['#heatmap svg', '#bars svg', '#ladder svg', '#breakdown svg']) {
      const gap = await page.locator(sel).evaluate((svg) => {
        const box = svg.getBoundingClientRect();
        const [, , vw, vh] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
        return box.height - vh * (box.width / vw);
      });
      expect(Math.abs(gap), `${sel} letterboxes ${gap}px of empty space`).toBeLessThan(2);
    }

    // And the column-width charts should use the column. Fixed at 880px inside a
    // ~1000px panel they left a ragged strip of empty surface down every panel.
    for (const sel of ['#bars', '#ladder', '#breakdown']) {
      const { chart, column } = await page.locator(sel).evaluate((mount) => ({
        chart: mount.querySelector('svg').getBoundingClientRect().width,
        column: mount.clientWidth,
      }));
      expect(column - chart, `${sel} leaves ${column - chart}px unused`).toBeLessThan(12);
    }
  });

  test('a disabled map control still looks like a control', async ({ page }) => {
    await ready(page);

    // At 1x there is nothing to zoom out to, so both buttons are disabled. Fading
    // the whole button — rather than its icon — takes the background down with it
    // and the map shows straight through the control, which reads as a rendering
    // failure rather than as an unavailable action.
    const out = page.locator('#map .map-btn[data-act="out"]');
    await expect(out).toBeDisabled();

    const alpha = (color) => {
      const m = color.match(/[\d.]+/g).map(Number);
      return m.length > 3 ? m[3] : 1;
    };
    expect(alpha(await out.evaluate((b) => getComputedStyle(b).backgroundColor))).toBe(1);
    expect(await out.evaluate((b) => Number(getComputedStyle(b).opacity))).toBe(1);
    expect(
      await out.evaluate((b) => Number(getComputedStyle(b.querySelector('svg')).opacity)),
      'the icon should be the part that fades',
    ).toBeLessThan(1);
  });

  test('small text clears the WCAG AA contrast floor', async ({ page }) => {
    await ready(page);

    // These two tokens carry almost all the small text on the site: --ink-muted
    // every eyebrow, field label, hint, table header and axis label, and --link
    // every footnote. Both sat under 4.5:1 — --ink-muted at 3.41 across 56
    // elements at once — which is invisible until someone measures it, so it
    // gets measured here rather than trusted.
    const ratios = await page.evaluate(() => {
      // Resolve through a probe element rather than reading the custom property
      // directly. The declared value is now `light-dark(#a, #b)`, and
      // `getPropertyValue` hands back that literal string — only the *computed*
      // colour tells you which branch the current theme actually took.
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const resolve = (value) => {
        probe.style.color = '';
        probe.style.color = value;
        const rgb = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
        return rgb;
      };

      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(resolve(a)), lum(resolve(b))];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };

      const out = {};
      for (const ink of ['--ink-muted', '--ink-2', '--link']) {
        for (const surface of ['--page', '--surface-1']) {
          out[`${ink} on ${surface}`] = ratio(`var(${ink})`, `var(${surface})`);
        }
      }
      // White on the fill built to carry it.
      out['white on --accent-solid'] = ratio('#ffffff', 'var(--accent-solid)');
      probe.remove();
      return out;
    });

    for (const [pair, value] of Object.entries(ratios)) {
      expect(value, `${pair} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('charts carry accessible names and a table alternative', async ({ page }) => {
    await ready(page);

    await expect(page.locator('#bars svg')).toHaveAttribute('aria-label', /rent/i);
    await expect(page.locator('#heatmap svg')).toHaveAttribute('aria-label', /rent/i);
    await expect(page.locator('#map .map-svg')).toHaveAttribute('aria-label', /county/i);
    // Every control icon is decorative; the button around it carries the name.
    await expect(page.locator('#map .map-btn svg[aria-hidden="true"]')).toHaveCount(4);
    await expect(page.locator('details.table-view').first()).toBeVisible();

    await expect(page.locator('#bars .bar-row').first()).toHaveAttribute('tabindex', '0');
  });

  test('the timing page draws the seasonal pattern and the trend', async ({ page }) => {
    const errors = watchForErrors(page);

    await page.goto('/timing/');
    await expect(page.locator('#seasonal svg')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#loading')).toBeHidden();

    // Twelve months, and the bars must straddle the zero line — a seasonal index
    // averaging 1.0 cannot be all above or all below it.
    const bars = page.locator('#seasonal .div-bar');
    await expect(bars).toHaveCount(12);

    const values = await page
      .locator('#seasonal .div-bar .value-label')
      .allTextContents();
    const nums = values.map((v) => parseFloat(v.replace('−', '-')));
    expect(Math.max(...nums), 'no month above the annual average').toBeGreaterThan(0);
    expect(Math.min(...nums), 'no month below the annual average').toBeLessThan(0);

    // The trend chart and the leaderboard both render.
    await expect(page.locator('#history svg')).toBeVisible();
    await expect(page.locator('#leaderboard .bar-row')).toHaveCount(15);

    expect(errors).toEqual([]);
  });

  test('the cheapest month named in the verdict is the lowest bar', async ({ page }) => {
    await page.goto('/timing/');
    await expect(page.locator('#seasonal svg')).toBeVisible({ timeout: 30_000 });

    const stats = page.locator('#timing-stats .stat');
    const cheapest = await stats.nth(0).locator('.value').textContent();
    const dearest = await stats.nth(1).locator('.value').textContent();

    // The prose and the chart must agree, or the page contradicts itself.
    await expect(page.locator('#verdict')).toContainText(cheapest.trim());
    await expect(page.locator('#verdict')).toContainText(dearest.trim());

    const rows = await page.locator('#seasonal-table tbody tr').allTextContents();
    expect(rows).toHaveLength(12);

    const parsed = rows.map((r) => {
      const [month, delta] = r.trim().split(/\s{2,}|\t|\n/).filter(Boolean);
      return { month, delta: parseFloat(delta.replace('−', '-')) };
    });
    const lowest = parsed.reduce((a, b) => (a.delta <= b.delta ? a : b));
    expect(lowest.month).toBe(cheapest.trim());
  });

  test('switching county on the timing page changes the pattern', async ({ page }) => {
    await page.goto('/timing/');
    await expect(page.locator('#seasonal svg')).toBeVisible({ timeout: 30_000 });

    const before = await page.locator('#seasonal-caption').textContent();

    // Suffolk County, MA runs on the academic calendar rather than the summer
    // moving season, so its pattern differs from a typical metro's.
    await page.locator('#county-picker').fill('Suffolk County, MA');
    await page.locator('#county-picker').dispatchEvent('change');

    await expect(page.locator('#seasonal-caption')).not.toHaveText(before);
    await expect(page.locator('#verdict')).toContainText('Suffolk County');
  });

  test('the method page loads and covers the limitations', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/method/');

    await expect(page.locator('h1')).toContainText('How every number');
    // The limitations section is the part that must never quietly disappear.
    await expect(page.locator('#limits')).toContainText('Local income tax is modelled for two cities only');
    await expect(page.locator('#comp')).toContainText('not location-adjusted');
    // The method page describes the data the site actually uses. It has gone
    // stale before, on exactly this claim.
    await expect(page.locator('#sources')).toContainText('B25031');
    await expect(page.locator('#sources')).toContainText('one bedroom is the default');
    await expect(page.locator('#timing')).toContainText(/centred moving average/i);
    // Absolute, not '../': the pages are routed from one root now, and the old
    // relative form only resolved by accident of how deep the file sat on disk.
    await expect(page.locator('a[href="/"]').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the county picker opens a real list, not a bare text box', async ({ page }) => {
    await ready(page);

    const input = page.locator('#county-picker');
    const list = page.locator('#county-listbox');

    await expect(list).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');

    await input.click();
    await expect(list).toBeVisible();
    await expect(input).toHaveAttribute('aria-expanded', 'true');

    // Rendering all ~3,100 counties into the DOM on every keystroke is the
    // reason this is capped; the row that says so is not itself an option.
    const rows = page.locator('.combo-row');
    await expect(rows).toHaveCount(60);
    await expect(page.locator('.combo-more')).toContainText('more');

    // A row carries what the datalist it replaced could not: where the county
    // is, and what it costs on the basis currently selected.
    const first = rows.first();
    await expect(first.locator('.combo-name')).not.toBeEmpty();
    await expect(first.locator('.combo-where')).not.toBeEmpty();
    await expect(first.locator('.combo-rent')).not.toBeEmpty();
  });

  test('searching ranks the obvious answer first', async ({ page }) => {
    await ready(page);

    await page.locator('#county-picker').fill('king');
    const names = await page.locator('.combo-row .combo-name').allTextContents();

    // "king" matches King County WA, Kings County NY, Kingfisher County OK and
    // every county whose metro merely contains the word. A plain substring
    // filter returns all of them in alphabetical order, which buries the one
    // anybody typing four letters meant.
    expect(names[0]).toMatch(/^King\b/);
    expect(names.some((n) => /Kingfisher/.test(n))).toBe(true);
    expect(names.indexOf(names.find((n) => /^King\b/.test(n))))
      .toBeLessThan(names.findIndex((n) => /Kingfisher/.test(n)));
  });

  test('the keyboard alone can pick a county', async ({ page }) => {
    await ready(page);
    const input = page.locator('#county-picker');

    await input.click();
    await input.fill('travis');
    await expect(page.locator('.combo-row').first()).toHaveAttribute('aria-selected', 'true');

    // aria-activedescendant, not focus: the caret never leaves the input, which
    // is what lets typing keep filtering while the arrows move the highlight.
    await page.keyboard.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    await page.keyboard.press('ArrowUp');

    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('Travis County, TX');
    await expect(page.locator('#verdict')).toContainText('Travis');
    await expect(page.locator('#county-listbox')).toBeHidden();
  });

  test('escape and blur both restore the committed county', async ({ page }) => {
    await ready(page);
    const input = page.locator('#county-picker');
    const committed = await input.inputValue();

    await input.fill('half-typed nonsense');
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue(committed);

    // Clicking away is the other way out, and it must not leave a query sitting
    // in a box that names the selection the rest of the page is computed from.
    await input.fill('more nonsense');
    await page.locator('h1').click();
    await expect(input).toHaveValue(committed);
    await expect(page.locator('#verdict')).toContainText(committed.split(' County')[0]);
  });

  test('choosing a state narrows the county list and moves the map', async ({ page }) => {
    await ready(page);

    await page.locator('#state-picker').selectOption('RI');
    await expect(page.locator('#state-hint')).toContainText('Rhode Island');
    await expect(page.locator('#county-picker'))
      .toHaveAttribute('placeholder', /Rhode Island/);

    // The list opens on the state's counties rather than waiting to be asked.
    await expect(page.locator('#county-listbox')).toBeVisible();
    const states = await page.locator('.combo-row .combo-st').allTextContents();
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(['RI']));

    // A state filter that changed nothing visible would read as a dead control.
    await expect(page.locator('.map-zoom-level')).not.toHaveText('1.0×');
  });

  test('a search with no match in the chosen state offers the way out', async ({ page }) => {
    await ready(page);

    await page.locator('#state-picker').selectOption('RI');
    await page.locator('#county-picker').fill('Travis');

    // The dead end this replaces: an empty list, with nothing on screen saying
    // the state filter is why.
    const row = page.locator('.combo-row').first();
    await expect(row).toContainText('Search all states instead');

    await row.click();
    await expect(page.locator('#state-picker')).toHaveValue('');
    await expect(page.locator('.combo-row .combo-name').first()).toContainText('Travis');
  });

  test('the timing page gets the same picker, filtered by state', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/timing/');
    await expect(page.locator('#seasonal svg')).toBeVisible({ timeout: 30_000 });

    // It opens on San Francisco, somewhere a reader has an intuition about,
    // rather than on whatever sorts first.
    await expect(page.locator('#county-picker')).toHaveValue('San Francisco County, CA');

    const input = page.locator('#county-picker');
    await input.click();
    await expect(page.locator('#county-listbox')).toBeVisible();

    // The right-hand figure is this page's subject, not the explore page's: how
    // big the seasonal swing is, and "no pattern" where there is too little
    // history. That is the whole reason a row is worth reading before clicking.
    const swings = await page.locator('.combo-row .combo-rent').allTextContents();
    expect(swings.length).toBeGreaterThan(0);
    for (const s of swings) expect(s).toMatch(/^(\d+\.\d%|no pattern)$/);

    await page.locator('#state-picker').selectOption('RI');
    await expect(page.locator('#state-hint')).toContainText('Rhode Island');
    const states = await page.locator('.combo-row .combo-st').allTextContents();
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(['RI']));

    // And picking one still drives the charts, which is the point of the control.
    const before = await page.locator('#seasonal-caption').textContent();
    await page.locator('.combo-row').first().click();
    await expect(page.locator('#seasonal-caption')).not.toHaveText(before);

    expect(errors).toEqual([]);
  });

  /**
   * Em dashes were swept out of the site's copy deliberately: they are the
   * single loudest tell that a machine wrote a sentence, and every one of them
   * had a comma, a colon or a full stop that read better. This asserts the
   * *rendered* text, not the source, because most of this copy is built in JS.
   */
  test('no page shows an em dash in its copy', async ({ page }) => {
    const dashes = (loc) =>
      loc.evaluate(() => {
        const out = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeValue.includes('—')) out.push(n.nodeValue.trim().slice(0, 100));
        }
        return out;
      });

    for (const path of ['/', '/states/', '/timing/', '/method/']) {
      await page.goto(path);
      await expect(page.locator('#loading')).toBeHidden({ timeout: 30_000 });
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('details')) d.open = true;
      });
      expect(await dashes(page.locator('body')), `em dash in ${path}`).toEqual([]);
    }

    // The states the copy only reaches on demand: a preset with no source, an
    // empty search, and a tooltip.
    await ready(page);
    await page.locator('.presets button').last().click();
    await page.locator('#county-picker').fill('zzzz');
    await page.locator('#bars .bar-row').first().hover();
    expect(await dashes(page.locator('body'))).toEqual([]);
  });

  test('every page ends with the same footer, and it names its sources', async ({ page }) => {
    for (const path of ['/', '/states/', '/timing/', '/method/']) {
      await page.goto(path);
      const footer = page.locator('.site-footer');
      await expect(footer, `no site footer on ${path}`).toBeVisible();

      // Every source the numbers come from is credited, and links out.
      for (const host of ['zillow.com', 'census.gov', 'livingwage.mit.edu',
                          'taxfoundation.org', 'ssa.gov', 'levels.fyi', 'us-atlas']) {
        await expect(
          footer.locator(`a[href*="${host}"]`).first(),
          `${host} is not credited on ${path}`,
        ).toHaveCount(1);
      }

      // The freshness line is filled from the committed data, not written into
      // the markup, so a stale month cannot be baked into three pages at once.
      await expect(footer.locator('#footer-freshness')).toContainText(/\d{4}/);
    }
  });

  test('the paper grain cannot push any text under the contrast floor', async ({ page }) => {
    await ready(page);

    // The grain is a flat ink laid over every pixel on the page, so it does not
    // darken text against its background — it composites over *both* and
    // compresses the ratio between them. Nothing in the stylesheet says which
    // pairs that endangers, and the token audit below cannot see it at all,
    // because it reads declared colours rather than rendered ones.
    //
    // This measures every text node on the page against its composited
    // background, then re-measures with the grain applied at FULL alpha. The
    // real mask averages about half that, so a pass here is conservative.
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);

      // Let the recalc settle before reading anything back. `light-dark()`
      // resolves at used-value time, and after a `color-scheme` flip Chromium
      // does not refresh every consumer promptly — anchors lagged a palette
      // behind for longer than two animation frames, which reported eighteen
      // contrast failures that do not exist on screen. Clicking the real toggle
      // and waiting produces the correct colours, so this is the measurement
      // settling, not the page being wrong.
      await page.waitForTimeout(400);

      const failures = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.display = 'none';
        document.body.appendChild(probe);

        const norm = (v) => {
          probe.style.color = '';
          probe.style.color = v;
          const c = getComputedStyle(probe).color;
          const m = c.match(/[\d.]+/g).map(Number);
          // `color-mix()` computes to `color(srgb r g b / a)` with channels in
          // 0-1, and round-tripping through `color` does not normalise it. Read
          // as 0-255 that is near-black, which reports the perfectly legible nav
          // as failing at 1.10:1 — a false alarm that costs more than the check.
          const scale = c.startsWith('color(') ? 255 : 1;
          return { rgb: m.slice(0, 3).map((x) => x * scale), a: m.length > 3 ? m[3] : 1 };
        };

        const lum = ([r, g, b]) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)];
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const over = (dst, src, a) => dst.map((v, i) => (1 - a) * v + a * src[i]);

        const grain = norm(getComputedStyle(document.documentElement).getPropertyValue('--grain-ink'));
        const pageBg = norm(getComputedStyle(document.body).backgroundColor).rgb;

        // Flatten the background stack to one opaque colour: the nav and several
        // tints are semi-transparent, and taking the first non-zero layer would
        // compare text against a colour nothing is actually drawn on.
        const bgOf = (el) => {
          const layers = [];
          for (let n = el; n; n = n.parentElement) {
            const c = norm(getComputedStyle(n).backgroundColor);
            if (c.a > 0) layers.push(c);
            if (c.a === 1) break;
          }
          let out = layers.length && layers.at(-1).a === 1 ? layers.pop().rgb : pageBg;
          for (const l of layers.reverse()) out = out.map((v, i) => (1 - l.a) * v + l.a * l.rgb[i]);
          return out;
        };

        const bad = [];
        for (const el of document.querySelectorAll('body *')) {
          // SVG marks are held to 3:1 as graphics and are checked against their
          // own fills elsewhere; this pass is about HTML text.
          if (el.closest('svg')) continue;
          const own = [...el.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent.trim())
            .join('');
          if (!own) continue;

          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || !el.getClientRects().length) continue;

          const size = parseFloat(cs.fontSize);
          const weight = Number(cs.fontWeight) || 400;
          const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

          const after = ratio(
            over(norm(cs.color).rgb, grain.rgb, grain.a),
            over(bgOf(el), grain.rgb, grain.a),
          );
          if (after < need) {
            bad.push(`${after.toFixed(2)}:1 (need ${need}) ${size}px "${own.slice(0, 30)}"`);
          }
        }
        probe.remove();
        return bad;
      });

      expect(failures, `contrast failures in ${theme} once the grain is composited`).toEqual([]);
    }

    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  });

  test('no panel can get stuck invisible, however it is reached', async ({ page }) => {
    await ready(page);

    // Panels rise into place on a scroll-driven view timeline. The failure mode
    // that matters is not a missing animation, it is a panel that never reaches
    // the end of one and stays at opacity 0 — a blank page that still returns
    // 200 and still passes every other test here.
    const opacities = () =>
      page.$$eval('section.panel', (els) => els.map((el) => Number(getComputedStyle(el).opacity)));

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    expect(
      (await opacities()).every((o) => o === 1),
      'a panel was still transparent after scrolling past it',
    ).toBe(true);

    // Opacity only, deliberately: a panel is up to a thousand pixels of map and
    // chart, and translating it would move a target out from under a pointer
    // already reaching for it.
    const moved = await page.$$eval('section.panel', (els) =>
      els.map((el) => getComputedStyle(el).transform).filter((t) => t !== 'none'));
    expect(moved, 'a panel is being translated by its entry animation').toEqual([]);

    // Print has no scroll at all, so the timeline never advances: without the
    // print rule every panel but the first comes out of the printer blank.
    await page.emulateMedia({ media: 'print' });
    expect(
      (await opacities()).every((o) => o === 1),
      'a panel would print blank',
    ).toBe(true);
    await page.emulateMedia({ media: 'screen' });
  });

  test('reduced motion turns the scroll animation off entirely', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ready(page);

    // Not "animates faster" — off. Every panel is fully present from the start,
    // with no animation attached to fail to finish.
    const state = await page.$$eval('section.panel', (els) =>
      els.map((el) => ({
        opacity: Number(getComputedStyle(el).opacity),
        animation: getComputedStyle(el).animationName,
      })));

    expect(state.every((s) => s.opacity === 1)).toBe(true);
    expect(state.every((s) => s.animation === 'none')).toBe(true);
  });

  test('the math section renders as maths and matches the engine', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/method/');

    // MathML is rendered by the browser itself — the site loads no CDN, so KaTeX
    // and MathJax are both out. If native support were missing the markup would
    // collapse to run-together text, which still "contains" the right words. A
    // laid-out fraction is the thing that proves it actually rendered.
    const fractionHeight = await page.locator('#math mfrac').first().evaluate(
      (n) => n.getBoundingClientRect().height,
    );
    expect(fractionHeight, 'MathML did not lay out — check for a text fallback').toBeGreaterThan(20);

    // The three places the supplied framework disagreed with the implementation.
    // Each is a claim that would be wrong if the notation were taken at face value.
    await expect(page.locator('#math')).toContainText('Not a universal 0.85');
    await expect(page.locator('#math')).toContainText(/County<?\s*,?\s*not ZIP code/i);
    await expect(page.locator('#math')).toContainText(/FICA/);

    // Constants quoted in prose must match the engine they claim to describe.
    // The method page has gone stale on exactly this kind of number before.
    //
    // Fetched rather than imported: the engine is Python now, so the only way
    // to check the page against the real constants — rather than against a
    // JavaScript copy of them that could itself drift — is to ask the server.
    const { federal: FEDERAL, fica: FICA } =
      await page.request.get('/api/meta').then((r) => r.json());

    const body = await page.locator('#math').innerText();
    for (const value of [
      FEDERAL.standardDeduction,
      FEDERAL.brackets.at(-1).from,
      FICA.socialSecurityWageBase,
      FICA.additionalMedicareThreshold,
    ]) {
      expect(body, `${value.toLocaleString('en-US')} is quoted nowhere in the math section`)
        .toContain(value.toLocaleString('en-US'));
    }
    expect(body).toContain(`${(FICA.socialSecurityRate * 100).toFixed(1)}%`);
    expect(body).toContain(`${(FEDERAL.brackets.at(-1).rate * 100).toFixed(0)}%`);

    expect(errors).toEqual([]);
  });

  test('pages are served from clean URLs, and only from clean URLs', async ({ page }) => {
    // A directory index means /timing/ is the real page. Without the trailing
    // slash the server has to redirect, or every relative link on the page
    // resolves one level too high and the whole page 404s its own assets.
    // 308, not 301: Flask issues a permanent redirect that preserves the method,
    // where the old static server hand-rolled a 301. Both are permanent and both
    // are correct; the assertion names the one the application actually sends.
    for (const dir of ['states', 'timing', 'method']) {
      const bare = await page.request.get(`/${dir}`, { maxRedirects: 0 });
      expect(bare.status(), `/${dir} should redirect to /${dir}/`).toBe(308);
      // Flask sends an absolute Location; the old static server sent a relative
      // one. Both are legal, so this asserts the destination rather than the
      // spelling of it.
      expect(new URL(bare.headers().location, 'http://localhost').pathname).toBe(`/${dir}/`);
    }

    // No page answers at a .html address. Stubs used to sit at these two,
    // forwarding the URLs the site had before the clean-URL move — but those
    // URLs belonged to the domain this site has since left, so on this host
    // they never existed and the stubs preserved nothing. Asserted rather than
    // just deleted, because the tempting fix for a stray .html link is to add
    // the alias back rather than to correct the link.
    for (const gone of ['/timing.html', '/method.html']) {
      const res = await page.request.get(gone);
      expect(res.status(), `${gone} should not be served`).toBe(404);
    }
  });

  test('on a phone, controls are tappable and nothing is set in fine print', async ({ page }) => {
    // 390px with a coarse pointer. Both halves of this have regressed before by
    // someone adding a control, so both are asserted rather than eyeballed.
    await page.setViewportSize({ width: 390, height: 780 });

    for (const path of ['/', '/states/', '/timing/', '/method/']) {
      await page.goto(path);
      await expect(page.locator('#loading')).toBeHidden({ timeout: 30_000 });

      // WCAG 2.5.8: 24px in both directions. Links sitting inside a sentence
      // are exempt, and so are marks inside a chart, which carry their own
      // hit areas and always have a table alternative.
      const small = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('a, button, select, input')) {
          if (el.closest('svg, p, li, td, .prose')) continue;
          const b = el.getBoundingClientRect();
          if (!b.width && !b.height) continue;
          if (getComputedStyle(el).display === 'none') continue;
          if (b.width < 24 || b.height < 24) {
            out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ` +
                     `${Math.round(b.width)}x${Math.round(b.height)}`);
          }
        }
        return [...new Set(out)];
      });
      expect(small, `tap targets under 24px on ${path}`).toEqual([]);

      // Nothing an adult has to read should be under 12px on a phone. SVG and
      // MathML are excluded: their type scales with the drawing, not the page.
      const fine = await page.evaluate(() => {
        const out = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const el = n.parentElement;
          if (!n.nodeValue.trim() || !el) continue;
          if (el.closest('svg, math')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const size = parseFloat(cs.fontSize);
          if (size && size < 12) out.push(`${el.tagName.toLowerCase()} ${size}px`);
        }
        return [...new Set(out)];
      });
      expect(fine, `text under 12px on ${path}`).toEqual([]);
    }
  });

  test('the state page map opens on the selected state, at county level', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/states/');
    await expect(page.locator('#state-map .map-county').first()).toBeVisible({ timeout: 30_000 });
    // Present is not painted: the fills arrive from the server a round trip later.
    await expect(page.locator('#state-map')).toHaveAttribute('data-painted', 'true', { timeout: 30_000 });

    await expect(page.locator('#state-map .map-county')).toHaveCount(COUNTY_COUNT);
    await expect(page.locator('#map-modes button[data-mode="county"]'))
      .toHaveAttribute('aria-pressed', 'true');

    // County level is the default, and it must be a county fill rather than a
    // state one: the whole argument of this page is that a state is not a place.
    const fills = await page.locator('#state-map .map-county').evaluateAll((nodes) =>
      new Set(nodes.map((n) => n.getAttribute('fill'))).size,
    );
    expect(fills, 'counties should carry several ramp steps').toBeGreaterThan(2);
    await expect(page.locator('#state-map')).not.toHaveClass(/is-state-mode/);

    // The frame opens on the selected state rather than on the whole country.
    const zoom = Number((await page.locator('#state-map .map-zoom-level').textContent()).replace('×', ''));
    expect(zoom, 'the map should open framed on California').toBeGreaterThan(1.5);
    await expect(page.locator('#state-map .map-selected')).toHaveAttribute('d', /^M/);

    // Clicking a county is a request for the state it sits in: Harris County
    // moves the page to Texas. Reset first, because a map framed on California
    // has Texas outside the frame, which is the whole point of framing it.
    await page.locator('#state-map .map-btn[data-act="reset"]').click();
    await expect(page.locator('#state-map .map-zoom-level')).toHaveText('1.0×');
    await page.locator('#state-map .map-county[data-fips="48201"]').click({ force: true });
    await expect(page.locator('#state-select')).toHaveValue('TX');
    await expect(page.locator('#inside-state')).toHaveText('Texas');

    expect(errors).toEqual([]);
  });

  test('the state view shades spread, not cost, and drives the page', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/states/');
    await expect(page.locator('#state-map .map-county').first()).toBeVisible({ timeout: 30_000 });
    // Present is not painted: the fills arrive from the server a round trip later.
    await expect(page.locator('#state-map')).toHaveAttribute('data-painted', 'true', { timeout: 30_000 });

    await page.locator('#map-modes button[data-mode="state"]').click();
    await expect(page.locator('#map-modes button[data-mode="state"]'))
      .toHaveAttribute('aria-pressed', 'true');

    // Every state carries a fill, spanning most of the ramp, and the country is
    // shown whole — the state view exists to compare states with each other.
    const painted = await page.locator('#state-map .map-state').evaluateAll((nodes) =>
      nodes.filter((n) => n.style.fill).map((n) => n.style.fill),
    );
    expect(painted).toHaveLength(51);
    expect(new Set(painted).size, 'spread should span the ramp').toBeGreaterThan(4);
    await expect(page.locator('#state-map .map-zoom-level')).toHaveText('1.0×');

    // DC is one county, so it has no two ends to compare and must not be given
    // a ramp step that implies it does.
    const dc = await page.locator('#state-map .map-state[data-state="DC"]').evaluate((n) => n.style.fill);
    expect(dc).toContain('nodata');

    // The legend has to say what the fill means, or a reader takes a state
    // choropleth to mean cost, which is the one thing it is not.
    await expect(page.locator('#state-map-legend .map-legend-caption')).toHaveText(/dearest county/i);

    // The table alternative agrees with the map, and the map is a picker.
    const rows = await page.locator('#state-map-table tbody tr').count();
    expect(rows).toBeGreaterThan(40);

    await page.locator('#state-map .map-state[data-state="NY"]').click({ force: true });
    await expect(page.locator('#state-select')).toHaveValue('NY');
    await expect(page.locator('#inside-state')).toHaveText('New York');

    // Back to counties, and the state fills must go with it, or the county
    // shading stays hidden underneath them.
    await page.locator('#map-modes button[data-mode="county"]').click();
    const cleared = await page.locator('#state-map .map-state').evaluateAll((nodes) =>
      nodes.every((n) => n.style.fill === ''),
    );
    expect(cleared, 'leaving state view should clear the state fills').toBe(true);

    expect(errors).toEqual([]);
  });

  test('every internal link on every page resolves', async ({ page }) => {
    // The clean-URL move rewrote every href by hand. A typo in one of them is
    // invisible until someone clicks it, and looks exactly like a working site.
    //
    // 404.html is in the list because its links are the only absolute ones on
    // the site — GitHub Pages serves that file for a miss at any depth, so a
    // relative href there would resolve against whatever the reader mistyped.
    // Absolute paths are only correct while the site is served from a domain
    // root, which is exactly the assumption worth pinning.
    for (const path of ['/', '/states/', '/timing/', '/method/', '/404.html']) {
      await page.goto(path);

      const links = await page.locator('a[href]').evaluateAll((nodes) =>
        nodes
          .map((n) => n.href)
          .filter((href) => href.startsWith(location.origin))
          .filter((href, i, all) => all.indexOf(href) === i),
      );
      expect(links.length, `no internal links found on ${path}`).toBeGreaterThan(3);

      for (const href of links) {
        const res = await page.request.get(href);
        expect(res.status(), `${href} is linked from ${path} but returns ${res.status()}`)
          .toBeLessThan(400);
      }
    }
  });

  test('every canonical and share URL names the deployed domain', async ({ page }) => {
    // These tags are the one part of the site a browser test cannot catch by
    // rendering: a canonical left pointing at a domain the site no longer
    // occupies looks perfect on screen and quietly tells search engines the
    // page is a duplicate of something that no longer exists. So the assertion
    // reads CNAME — the file that actually decides where the site lives — and
    // requires the head tags to agree with it.
    // The origin comes from the application rather than from a file beside it.
    // It used to be read from CNAME, which was a GitHub Pages artefact; the
    // deploy target owns its own hostname now, and /api/meta is the one place
    // that knows what it is.
    const origin = (await page.request.get('/api/meta').then((r) => r.json())).siteOrigin;
    expect(origin, 'the app must advertise an origin').toMatch(/^https:\/\/[a-z0-9.-]+$/);
    const host = origin.replace(/^https:\/\//, '');

    const pages = [
      ['/', ''],
      ['/states/', 'states/'],
      ['/timing/', 'timing/'],
      ['/method/', 'method/'],
    ];

    for (const [path, suffix] of pages) {
      await page.goto(path);
      const expected = `https://${host}/${suffix}`;

      const head = await page.evaluate(() => ({
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
        ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? null,
        ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
      }));

      expect(head.canonical, `canonical on ${path}`).toBe(expected);
      expect(head.ogUrl, `og:url on ${path}`).toBe(expected);
      expect(head.ogImage, `og:image on ${path}`).toBe(`https://${host}/assets/og-card.jpg`);
    }

    // The sitemap is the other place the domain is written down, and it is the
    // copy nobody looks at, so it is the one most likely to be left behind.
    const sitemap = await page.request.get('/sitemap.xml').then((r) => r.text());
    for (const [, suffix] of pages) {
      expect(sitemap, 'sitemap.xml').toContain(`<loc>https://${host}/${suffix}</loc>`);
    }
    expect(sitemap, 'sitemap.xml must not list a page that no longer exists')
      .not.toContain('.html');
  });
});
