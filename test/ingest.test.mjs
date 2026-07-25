import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { parseCsvLine } from '../src/csv.js';
import { HUBS } from '../src/hubs.js';
import { STATES, LOCAL } from '../src/tax-data.js';

describe('parseCsvLine', () => {
  test('keeps commas inside quoted fields together', () => {
    // The exact shape ZORI uses. A naive split(',') yields 6 fields here and
    // shifts every month column by one.
    const line = '394913,1,"New York, NY",msa,NY,3573.4';
    assert.deepEqual(parseCsvLine(line), [
      '394913',
      '1',
      'New York, NY',
      'msa',
      'NY',
      '3573.4',
    ]);
  });

  test('handles unquoted fields', () => {
    assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  test('preserves empty fields, including trailing ones', () => {
    assert.deepEqual(parseCsvLine('a,,c,'), ['a', '', 'c', '']);
  });

  test('unescapes doubled quotes', () => {
    assert.deepEqual(parseCsvLine('"say ""hi""",2'), ['say "hi"', '2']);
  });

  test('handles a quoted empty string', () => {
    assert.deepEqual(parseCsvLine('"",x'), ['', 'x']);
  });
});

describe('hub definitions', () => {
  test('ids are unique', () => {
    const ids = HUBS.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every hub maps to a modelled state', () => {
    for (const hub of HUBS) {
      assert.ok(STATES[hub.state], `${hub.city} references unmodelled state ${hub.state}`);
    }
  });

  test('every declared locality exists', () => {
    for (const hub of HUBS.filter((h) => h.local)) {
      assert.ok(LOCAL[hub.local], `${hub.city} references unknown locality ${hub.local}`);
    }
  });

  test('multi-state metros carry an explanatory note', () => {
    // Washington, DC spans three tax jurisdictions; the choice must be documented
    // rather than inherited from Zillow's StateName column (which says VA).
    const dc = HUBS.find((h) => h.id === 'dc');
    assert.equal(dc.state, 'VA');
    assert.match(dc.note, /Virginia/);
  });
});

describe('ingested data/rents.json', () => {
  const path = new URL('../data/rents.json', import.meta.url);
  const present = existsSync(path);

  test('exists (run `npm run fetch-rents` if this fails)', () => {
    assert.ok(present, 'data/rents.json missing');
  });

  if (!present) return;

  const data = JSON.parse(readFileSync(path, 'utf8'));

  test('carries a real observation date and provenance', () => {
    assert.match(data.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(data.source?.url?.includes('zillow'));
    assert.ok(data.fetchedAt);
  });

  test('covers every tracked hub with a positive rent', () => {
    assert.equal(data.hubs.length, HUBS.length);

    for (const hub of HUBS) {
      const row = data.hubs.find((h) => h.id === hub.id);
      assert.ok(row, `missing ${hub.city}`);
      assert.ok(row.rent > 0, `${hub.city} has non-positive rent`);
      assert.equal(row.state, hub.state);
    }
  });

  test('rents are in a plausible monthly range', () => {
    for (const row of data.hubs) {
      assert.ok(
        row.rent > 800 && row.rent < 10000,
        `${row.city} rent ${row.rent} looks wrong for a monthly figure`,
      );
    }
  });

  test('does not claim to measure something it does not', () => {
    // Zillow publishes no bedroom-level metro series; the metric must not be
    // labelled as a 1-bedroom median.
    assert.doesNotMatch(data.source.metric, /1\s*-?\s*bed/i);
  });
});
