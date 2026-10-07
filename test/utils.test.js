import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTimeToPostByBail, normalizeName } from '../utils.js';

const BUCKETS = [
  { label: 'low',  min: 0,    max: 1000 },
  { label: 'high', min: 1000, max: Infinity },
];

test('summarizeTimeToPostByBail buckets by bail with an inclusive upper bound', () => {
  const rows = [
    { bailAmt: 1000, heldMins: 60 },   // exactly at the boundary → low
    { bailAmt: 1001, heldMins: 3000 }, // just over → high
  ];
  const [low, high] = summarizeTimeToPostByBail(rows, BUCKETS);
  assert.equal(low.count, 1);
  assert.equal(high.count, 1);
  assert.equal(low.medianMins, 60);
  assert.equal(high.medianMins, 3000);
});

test('summarizeTimeToPostByBail computes median, quartiles and within-24h share', () => {
  const rows = [100, 200, 300, 400, 2000].map(heldMins => ({ bailAmt: 500, heldMins }));
  const [low] = summarizeTimeToPostByBail(rows, BUCKETS);
  assert.equal(low.count, 5);
  assert.equal(low.p25Mins, 200);
  assert.equal(low.medianMins, 300);
  assert.equal(low.p75Mins, 400);
  assert.equal(low.within24hPct, 80);
});

test('summarizeTimeToPostByBail returns zeroed buckets when empty and skips non-positive times', () => {
  const [low, high] = summarizeTimeToPostByBail([{ bailAmt: 500, heldMins: 0 }], BUCKETS);
  assert.deepEqual(low, { label: 'low', count: 0, p25Mins: 0, medianMins: 0, p75Mins: 0, within24hPct: 0 });
  assert.equal(high.count, 0);
});

test('normalizeName trims and upper-cases so booking and release names line up', () => {
  assert.equal(normalizeName('SOTOCASTRO, DIEGO '), 'SOTOCASTRO, DIEGO');
  assert.equal(normalizeName('Greene, Chad A'), 'GREENE, CHAD A');
  assert.equal(normalizeName(null), '');
});
