import test from 'node:test';
import assert from 'node:assert/strict';

import { medianBy, rollUpState, rollUpStates } from '../src/state-rollup.js';

const county = (name, state, needs) => ({ name, state, needs });

test('medianBy', async (t) => {
  await t.test('returns a real element, never an interpolated one', () => {
    const list = [county('a', 'CA', 10), county('b', 'CA', 20)];
    const mid = medianBy(list, (c) => c.needs);
    assert.ok(list.includes(mid), 'median is not one of the inputs');
  });

  await t.test('is the middle by value, not by input order', () => {
    const list = [county('c', 'CA', 90), county('a', 'CA', 10), county('b', 'CA', 50)];
    assert.equal(medianBy(list, (c) => c.needs).name, 'b');
  });

  await t.test('an empty list has no median', () => {
    assert.equal(medianBy([], (c) => c.needs), null);
  });
});

test('rollUpState', async (t) => {
  const texas = [
    county('Loving', 'TX', 1800),
    county('Travis', 'TX', 3600),
    county('Bexar', 'TX', 2400),
  ];

  await t.test('names the two ends and the middle', () => {
    const roll = rollUpState(texas);
    assert.equal(roll.cheapest.name, 'Loving');
    assert.equal(roll.dearest.name, 'Travis');
    assert.equal(roll.median.name, 'Bexar');
    assert.equal(roll.n, 3);
  });

  await t.test('spread is the ratio of the ends, which is the point of the page', () => {
    assert.equal(rollUpState(texas).spread, 2);
  });

  await t.test('a one-county state is its own median and has no spread', () => {
    const roll = rollUpState([county('Kalawao', 'HI', 2100)]);
    assert.equal(roll.median.name, 'Kalawao');
    assert.equal(roll.cheapest, roll.dearest);
    assert.equal(roll.spread, 1);
  });

  await t.test('a state with nothing published rolls up to nothing, not to zero', () => {
    // The distinction matters on screen: "no data" and "$0 a month" are very
    // different claims, and only one of them is true.
    assert.equal(rollUpState([]), null);
  });

  await t.test('does not mutate the caller\'s array', () => {
    const before = texas.map((c) => c.name);
    rollUpState(texas);
    assert.deepEqual(texas.map((c) => c.name), before);
  });
});

test('rollUpStates', async (t) => {
  const all = [
    county('Loving', 'TX', 1800),
    county('Travis', 'TX', 3600),
    county('King', 'WA', 3200),
  ];

  await t.test('buckets by state and rolls each up', () => {
    const out = rollUpStates(all);
    assert.deepEqual([...out.keys()].sort(), ['TX', 'WA']);
    assert.equal(out.get('TX').n, 2);
    assert.equal(out.get('WA').median.name, 'King');
  });

  await t.test('a state with no counties in the input is absent, not empty', () => {
    assert.equal(rollUpStates(all).has('CA'), false);
  });
});
