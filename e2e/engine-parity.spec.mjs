import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Proves the browser's arithmetic against Python's, case for case.
 *
 * The static build moved a little computation into JavaScript — evaluating the
 * published tax curves, dividing needs by take-home, and comparing against
 * thresholds Python published. No tax constant moved, but the code did, and two
 * implementations of anything is how a map and a verdict start disagreeing.
 *
 * `e2e/fixtures/derivation.json` records what Python answers for a grid of
 * cases. `tests/test_derivation_parity.py` keeps that file honest against
 * Python; this file makes the deployed JavaScript answer the same questions.
 * Both ends are pinned, so neither can be quietly edited into agreement.
 *
 * The comparison is EXACT. Every value involved comes from +, -, * and / on
 * doubles, all of which IEEE 754 pins exactly, and both sides deliberately
 * perform them in the same order — see the note above `interpolate` in
 * assets/engine.js. A tolerance here would absorb precisely the class of change
 * worth catching in a tax engine.
 *
 * This runs against the real module the site loads, from the frozen `dist/`,
 * not against a copy of it.
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/derivation.json', import.meta.url), 'utf8'),
);

/** Load the engine inside the page and let it boot against the real bundle. */
async function engineOn(page) {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 30_000 });
  // The page already imported and booted this module; ES modules are cached per
  // document, so this is the same instance with META already populated.
  await page.evaluate(async () => {
    window.__engine = await import('/assets/engine.js');
    if (!window.__engine.META) await window.__engine.boot();
  });
}

test.describe('engine parity with Python', () => {
  test.beforeEach(async ({ page }) => {
    await engineOn(page);
  });

  test('the tax liability matches at every wage in every jurisdiction', async ({ page }) => {
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.liability(want.gross, want.state, want.localCode);
        for (const key of [
          'federal', 'fica', 'stateIncome', 'statePayroll',
          'local', 'total', 'net', 'effectiveRate',
        ]) {
          if (got[key] !== want[key]) {
            out.push(
              `${want.state}${want.localCode ? ":" + want.localCode : ""} @ ${want.gross} ` +
                `${key}: python ${want[key]} browser ${got[key]}`,
            );
          }
        }
        // The tax panel prints every levy by name, so attributing the right
        // total to the wrong levy is a bug a total-only check cannot see.
        const detail = got.statePayrollDetail;
        if (detail.length !== want.statePayrollDetail.length) {
          out.push(`${want.state} @ ${want.gross}: ${want.statePayrollDetail.length} levies, got ${detail.length}`);
        } else {
          want.statePayrollDetail.forEach((levy, i) => {
            if (detail[i].label !== levy.label || detail[i].amount !== levy.amount) {
              out.push(
                `${want.state} @ ${want.gross} levy ${i}: python ` +
                  `${levy.label}=${levy.amount} browser ${detail[i].label}=${detail[i].amount}`,
              );
            }
          });
        }
      }
      return out;
    }, FIXTURE.liability);

    expect(mismatches.slice(0, 10), `${mismatches.length} of ${FIXTURE.liability.length} cases drifted`).toEqual([]);
  });

  test('the salary the ladder solves for matches', async ({ page }) => {
    // The inverse of the curve. This is the one the old bisection could only get
    // within a cent of; both sides now solve it exactly, so it compares exactly.
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.grossForNet(want.target, want.state, want.local);
        if (got !== want.gross) {
          out.push(
            `${want.state}${want.localCode ? ":" + want.localCode : ""} target ${want.target}: ` +
              `python ${want.gross} browser ${got}`,
          );
        }
      }
      return out;
    }, FIXTURE.grossForNet);

    expect(mismatches.slice(0, 10), `${mismatches.length} of ${FIXTURE.grossForNet.length} cases drifted`).toEqual([]);
  });

  test('the map class breaks fall on the same side of every boundary', async ({ page }) => {
    // An off-by-one in a `<=` moves a county one shade on the map and one
    // sentence in the verdict — a change nobody would catch by looking.
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.needsShareStep(want.share);
        if (got !== want.step) out.push(`share ${want.share}: python ${want.step} browser ${got}`);
      }
      return out;
    }, FIXTURE.steps);

    expect(mismatches).toEqual([]);
  });

  test('the verdict band matches, including at zero and negative take-home', async ({ page }) => {
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.classify(want.monthlyNet, want.needs);
        if (got.id !== want.bandId) {
          out.push(`net ${want.monthlyNet} needs ${want.needs}: python ${want.bandId} browser ${got.id}`);
        }
      }
      return out;
    }, FIXTURE.classify);

    expect(mismatches).toEqual([]);
  });

  test('the salary ladder matches for real counties on both rent bases', async ({ page }) => {
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.salaryBands(
          want.rent, want.nonHousingMonthly, want.state, want.local,
        );
        for (const key of ['monthlyNeeds', 'annualNeeds', 'survival', 'gettingBy', 'comfortable']) {
          if (got[key] !== want[key]) {
            out.push(`${want.fips}/${want.basis} ${key}: python ${want[key]} browser ${got[key]}`);
          }
        }
      }
      return out;
    }, FIXTURE.salaryBands);

    expect(mismatches).toEqual([]);
  });

  test('the relocation solve matches in both directions between every pair', async ({ page }) => {
    // The Compare page's whole output. Both readings are checked, and so are the
    // intermediates behind them: a share that drifts would move the headline
    // without moving anything else, which is the hardest version to spot.
    //
    // The identity pairs matter most. Moving nowhere has to return the salary
    // that was typed, so any asymmetry between the forward evaluation and the
    // inverse shows up here as a number that is merely close.
    const mismatches = await page.evaluate((cases) => {
      const out = [];
      for (const want of cases) {
        const got = window.__engine.equivalentSalary(
          want.salary,
          {
            rent: want.fromRent,
            nonHousingMonthly: want.fromNonHousingMonthly,
            state: want.fromState,
            local: want.fromLocal,
          },
          {
            rent: want.toRent,
            nonHousingMonthly: want.toNonHousingMonthly,
            state: want.toState,
            local: want.toLocal,
          },
        );
        for (const key of [
          'fromMonthlyNet', 'fromMonthlyNeeds', 'fromNeedsShare',
          'fromMonthlySurplus', 'toMonthlyNeeds', 'sameShare', 'sameSurplus',
        ]) {
          if (got[key] !== want[key]) {
            out.push(
              `${want.basis} ${want.from}->${want.to} @ ${want.salary} ${key}: ` +
                `python ${want[key]} browser ${got[key]}`,
            );
          }
        }
      }
      return out;
    }, FIXTURE.equivalence);

    expect(
      mismatches.slice(0, 10),
      `${mismatches.length} of ${FIXTURE.equivalence.length} cases drifted`,
    ).toEqual([]);
  });

  test('the national map agrees with the headline county for county', async ({ page }) => {
    // Two code paths reach the same answer — one solves a pair, the other solves
    // 3,000 at once off a single origin — and a page that shaded a county one way
    // while naming another number in the verdict would be indefensible. They
    // share `matchIn` precisely so this holds; this proves it still does.
    const drift = await page.evaluate(async () => {
      const engine = window.__engine;
      const from = '48453'; // Travis County, TX
      const salary = 130_000;
      const everywhere = await engine.equivalentEverywhere(from, salary, 'acs', 'all');

      const out = [];
      for (const to of ['06075', '36061', '53033', '42101', '01001', '11001', from]) {
        const pair = await engine.comparePair(from, to, salary, 'acs', 'all');
        if (!pair.available) {
          out.push(`${to}: pair unavailable`);
          continue;
        }
        const mapped = everywhere.salaries[to];
        if (mapped.sameShare !== pair.equivalence.sameShare) {
          out.push(`${to}: map ${mapped.sameShare} verdict ${pair.equivalence.sameShare}`);
        }
        if (mapped.sameSurplus !== pair.equivalence.sameSurplus) {
          out.push(`${to}: map ${mapped.sameSurplus} verdict ${pair.equivalence.sameSurplus}`);
        }
      }
      return out;
    });

    expect(drift).toEqual([]);
  });

  test('every offer ranks every hub the way Python does', async ({ page }) => {
    // The compensation model is the one derivation whose inputs are editable on
    // the page, so the browser has to compute it rather than read a precomputed
    // answer — vesting schedule, equity haircut, burden bands and all.
    const mismatches = await page.evaluate(async (cases) => {
      const out = [];
      const byProfile = new Map();
      for (const want of cases) {
        if (!byProfile.has(want.profileId)) {
          const { rows } = await window.__engine.rank(want.profileId);
          byProfile.set(
            want.profileId,
            new Map(rows.map((r) => [r.hub.city ?? r.hub.metro, r])),
          );
        }
        const got = byProfile.get(want.profileId).get(want.hub);
        if (!got) {
          out.push(`${want.profileId}: no row for ${want.hub}`);
          continue;
        }
        if (got.baseRatio !== want.baseRatio || got.baseMonthlyNet !== want.baseMonthlyNet) {
          out.push(
            `${want.profileId}/${want.hub}: python ${want.baseRatio}/${want.baseMonthlyNet} ` +
              `browser ${got.baseRatio}/${got.baseMonthlyNet}`,
          );
        }
        if (got.burden !== want.burden) {
          out.push(`${want.profileId}/${want.hub} burden: python ${want.burden} browser ${got.burden}`);
        }
        want.years.forEach((year, i) => {
          const mine = got.years[i];
          if (!mine || mine.gross !== year.gross || mine.ratio !== year.ratio) {
            out.push(
              `${want.profileId}/${want.hub} year ${year.year}: python ` +
                `${year.gross}/${year.ratio} browser ${mine?.gross}/${mine?.ratio}`,
            );
          }
        });
      }
      return out;
    }, FIXTURE.rank);

    expect(mismatches.slice(0, 10), `${mismatches.length} mismatches`).toEqual([]);
  });

  test('no tax constant reached the browser as anything but a curve', async ({ page }) => {
    // The point of the whole arrangement. If a bracket table, a standard
    // deduction or a FICA rate ever gets typed into JavaScript, the model is
    // back in two languages and this file is the only thing that would notice.
    const sources = await page.evaluate(async () => {
      const names = [
        'engine.js', 'app.js', 'states.js', 'compare.js', 'timing.js', 'method.js',
        'charts.js', 'map.js', 'county-picker.js', 'combobox.js', 'data.js',
        'footer.js', 'theme.js',
      ];
      const out = {};
      for (const name of names) {
        out[name] = await fetch(`/assets/${name}`).then((r) => r.text());
      }
      return out;
    });

    // Figures from app/tax_data.py that must exist only in the published curve.
    const forbidden = [
      ['16100', 'the federal standard deduction'],
      ['184500', 'the Social Security wage base'],
      ['0.062', 'the Social Security rate'],
      ['0.0145', 'the Medicare rate'],
      ['0.03078', "New York City's bottom rate"],
    ];

    const found = [];
    for (const [file, text] of Object.entries(sources)) {
      // Strip comments: the method page and several modules legitimately
      // *describe* these numbers in prose. Only executable code matters.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*\*.*$/gm, '');
      for (const [literal, what] of forbidden) {
        if (code.includes(literal)) found.push(`${file} contains ${literal} (${what})`);
      }
    }

    expect(found, 'tax constants must live in Python only').toEqual([]);
  });
});
