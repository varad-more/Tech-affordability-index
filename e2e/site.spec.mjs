import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Imported rather than transcribed: the method page quotes these figures in
// prose, and prose is what goes stale.
import { FEDERAL, FICA } from '../src/tax-data.js';

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

/** The app is hidden behind a loading panel until every dataset has arrived. */
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#map .map-county').first()).toBeVisible({ timeout: 30_000 });
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
    await page.goto('/method.html');
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
    for (const path of ['/', '/timing.html', '/method.html']) {
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
      const cs = getComputedStyle(document.documentElement);
      const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(hex(a)), lum(hex(b))];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const tok = (n) => cs.getPropertyValue(n).trim();
      const out = {};
      for (const ink of ['--ink-muted', '--ink-2', '--link']) {
        for (const surface of ['--page', '--surface-1']) {
          out[`${ink} on ${surface}`] = ratio(tok(ink), tok(surface));
        }
      }
      // White on the fill built for it.
      out['white on --accent-solid'] = ratio('#ffffff', tok('--accent-solid'));
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

    await page.goto('/timing.html');
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
    await page.goto('/timing.html');
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
    await page.goto('/timing.html');
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
    await page.goto('/method.html');

    await expect(page.locator('h1')).toContainText('How every number');
    // The limitations section is the part that must never quietly disappear.
    await expect(page.locator('#limits')).toContainText('Local income tax is modelled for two cities only');
    await expect(page.locator('#comp')).toContainText('not location-adjusted');
    // The method page describes the data the site actually uses. It has gone
    // stale before, on exactly this claim.
    await expect(page.locator('#sources')).toContainText('B25031');
    await expect(page.locator('#sources')).toContainText('one bedroom is the default');
    await expect(page.locator('#timing')).toContainText(/centred moving average/i);
    await expect(page.locator('a[href="index.html"]').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the math section renders as maths and matches the engine', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/method.html');

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
});
