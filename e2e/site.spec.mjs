import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const rents = JSON.parse(readFileSync(new URL('../data/rents.json', import.meta.url), 'utf8'));
const profiles = JSON.parse(readFileSync(new URL('../data/profiles.json', import.meta.url), 'utf8'));

const HUB_COUNT = rents.hubs.length;
const PROFILE_COUNT = profiles.profiles.length;

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

test.describe('affordability index', () => {
  test('loads and renders every view without console errors', async ({ page }) => {
    const errors = watchForErrors(page);

    await page.goto('/');
    await expect(page.locator('.stat')).toHaveCount(4);

    // Freshness badge must show the real observation month, not a placeholder.
    const month = new Date(`${rents.asOf}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    await expect(page.locator('#freshness')).toContainText(month);
    await expect(page.locator('#freshness')).toContainText(String(HUB_COUNT));

    // One bar per metro, one heatmap cell per metro x offer, one panel per offer.
    await expect(page.locator('#bars .bar-row')).toHaveCount(HUB_COUNT);
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * PROFILE_COUNT);
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);
    await expect(page.locator('#table tbody tr')).toHaveCount(HUB_COUNT);

    expect(errors).toEqual([]);
  });

  test('bars are ranked ascending and the 30% threshold is drawn', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#bars .bar-row').first()).toBeVisible();

    const values = await page.locator('#bars .value-label').allTextContents();
    const nums = values.map((v) => parseFloat(v));

    expect(nums.length).toBe(HUB_COUNT);
    // Cheapest rent burden first.
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));

    await expect(page.locator('#bars .threshold-line')).toHaveCount(1);
    await expect(page.locator('#bars .threshold-label')).toContainText('30%');
  });

  test('no cell is left unlabelled (the relief rule for low-contrast ramp steps)', async ({ page }) => {
    await page.goto('/');
    const labels = await page.locator('#heatmap .cell-value').allTextContents();

    expect(labels).toHaveLength(HUB_COUNT * PROFILE_COUNT);
    for (const label of labels) expect(label).toMatch(/^\d+\.\d%$/);
  });

  test('switching preset recomputes the numbers', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#bars .bar-row').first()).toBeVisible();

    const before = await page.locator('#bars .value-label').first().textContent();
    const baseBefore = await page.locator('#base').inputValue();

    // Startup profile: different base, and equity discounted to zero.
    await page.getByRole('button', { name: /Startup/ }).click();

    await expect(page.locator('#base')).not.toHaveValue(baseBefore);
    await expect(page.locator('#haircut')).toHaveValue('0');
    await expect(page.locator('#bars .value-label').first()).not.toHaveText(before);
  });

  test('editing salary recomputes and marks the offer custom', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#bars .bar-row').first()).toBeVisible();

    const before = parseFloat(await page.locator('#bars .value-label').first().textContent());

    // Halving pay must make rent a strictly larger share of it.
    await page.locator('#base').fill('90000');
    await expect(async () => {
      const after = parseFloat(await page.locator('#bars .value-label').first().textContent());
      expect(after).toBeGreaterThan(before);
    }).toPass();

    // No preset should still read as selected once the numbers are edited.
    await expect(page.locator('.presets button[aria-pressed="true"]')).toHaveCount(0);
  });

  test('a zero-income-tax metro nets more than California at equal pay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#table tbody tr')).toHaveCount(HUB_COUNT);

    const netOf = async (city) => {
      const row = page.locator('#table tbody tr').filter({ hasText: city }).first();
      const text = await row.locator('td').nth(4).textContent();
      return Number(text.replace(/[$,]/g, ''));
    };

    // Same gross salary; the gap is state tax alone.
    expect(await netOf('Austin')).toBeGreaterThan(await netOf('San Francisco'));
    expect(await netOf('Austin')).toBeGreaterThan(await netOf('New York'));
  });

  test('dark mode redraws without errors', async ({ page }) => {
    const errors = watchForErrors(page);

    await page.goto('/');
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * PROFILE_COUNT);

    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The heatmap re-renders on toggle because its label ink depends on the mode.
    await expect(page.locator('#heatmap .cell-value')).toHaveCount(HUB_COUNT * PROFILE_COUNT);
    expect(errors).toEqual([]);
  });

  test('vesting panels share one scale and actually show shape', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.multiple')).toHaveCount(PROFILE_COUNT);

    // Every panel must plot on the same vertical scale, or comparing the shapes
    // across panels is meaningless.
    await expect(page.locator('#multiples-caption')).toContainText('share one vertical scale');

    const dotYs = async (company) => {
      const panel = page.locator('.multiple').filter({ hasText: company }).first();
      return panel
        .locator('.spark-dot')
        .evaluateAll((dots) => dots.map((d) => Number(d.getAttribute('cy'))));
    };

    // Google's grant vests 33/33/22/12, so pay falls over time and the curve
    // must visibly climb. A flat line here means the y-domain collapsed and the
    // panel is showing nothing.
    const google = await dotYs('Google');
    expect(google.length).toBe(4);
    expect(
      Math.max(...google) - Math.min(...google),
      'front-loaded vesting curve is flat — y-domain collapsed',
    ).toBeGreaterThan(15);

    // Meta and the startup are both perfectly flat but at very different levels.
    // If each panel self-scaled, both would render mid-panel at the same height;
    // a shared domain forces them apart. This is the real shared-scale check.
    const [meta, startup] = [await dotYs('Meta'), await dotYs('Startup')];
    expect(Math.abs(meta[0] - startup[0]), 'panels are not on a shared scale').toBeGreaterThan(20);

    // A shared domain inside each SVG is not enough: the plot areas must also
    // line up on the page. Descriptions differ in length, and without a common
    // baseline a longer one pushes its chart down so a panel can look lower than
    // a neighbour whose value is actually higher.
    const tops = await page.locator('.multiple .plot svg').evaluateAll((svgs) =>
      svgs.map((s) => Math.round(s.getBoundingClientRect().top)),
    );
    expect(tops).toHaveLength(PROFILE_COUNT);
    expect(
      Math.max(...tops) - Math.min(...tops),
      'plot areas are not vertically aligned across panels',
    ).toBeLessThanOrEqual(2);

    // And on the page, a higher ratio must sit visually higher.
    const pageY = async (company) => {
      const panel = page.locator('.multiple').filter({ hasText: company }).first();
      return panel.locator('.spark-dot').first().evaluate((d) => d.getBoundingClientRect().top);
    };
    // Amazon's year-1 share exceeds Meta's, so its mark must render above Meta's.
    expect(await pageY('Amazon')).toBeLessThan(await pageY('Meta'));
  });

  test('tooltips appear on hover', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#bars .bar-row').first()).toBeVisible();

    await page.locator('#bars .bar-row').first().hover();
    const tip = page.locator('#tooltip');
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText('Take-home');
  });

  test('the page never scrolls horizontally', async ({ page }) => {
    // Wide content (bars, heatmap) must scroll inside its own container.
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.locator('.stat')).toHaveCount(4);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test('charts carry accessible names and a table alternative', async ({ page }) => {
    await page.goto('/');

    // Identity is never colour-alone: a table view backs every chart.
    await expect(page.locator('#bars svg')).toHaveAttribute('aria-label', /rent/i);
    await expect(page.locator('#heatmap svg')).toHaveAttribute('aria-label', /rent/i);
    await expect(page.locator('details.table-view')).toBeVisible();

    // Marks are keyboard reachable.
    await expect(page.locator('#bars .bar-row').first()).toHaveAttribute('tabindex', '0');
  });
});
