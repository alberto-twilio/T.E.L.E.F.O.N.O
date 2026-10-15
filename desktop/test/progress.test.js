const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgress, expectedCounts, expectedFromSpec, percent } = require('../lib/progress');

const profile = (over = {}) => ({
  tier: 'stage', categories: ['calls', 'recordings_transcriptions', 'conferences'],
  calls: '10-30', recordingsTranscriptions: '5-10', conferences: '5-10', noProdCap: false, ...over,
});

test('expected counts use range midpoints, 0 for disabled categories, prod cap only when not lifted', () => {
  assert.deepEqual(expectedCounts(profile()), { calls: 20, rec_trans: 8, conf: 8 });
  assert.deepEqual(expectedCounts(profile({ categories: ['conferences'] })), { calls: 0, rec_trans: 0, conf: 8 });
  assert.equal(expectedCounts(profile({ tier: 'prod', calls: '50-60' })).calls, 30);
  assert.equal(expectedCounts(profile({ tier: 'prod', calls: '50-60', noProdCap: true })).calls, 55);
  assert.equal(expectedFromSpec('12'), 12);
  assert.equal(expectedFromSpec('junk'), 0);
});

test('every item weighs the same: a call, a recording and a conference each count as 1', () => {
  const t = createProgress({ calls: 0, rec_trans: 0, conf: 0 });
  t.feed('[plan] calls=2\n[call 1/2] completed sid=CA1\n[call 2/2] failed sid=CA2\n');
  t.feed('[plan] rec_trans=1\n[rec/trans 1/1] call_sid=CA3\n[plan] conf=1\n[conf 1/1] room=r\n');
  assert.deepEqual(t.snapshot(), { done: 4, total: 4, estimated: false });
});

test('total starts as an estimate and is replaced by the real roll when a category announces it', () => {
  const t = createProgress({ calls: 20, rec_trans: 8, conf: 8 });
  assert.deepEqual(t.snapshot(), { done: 0, total: 36, estimated: true });
  t.feed('[plan] calls=12\n');
  assert.deepEqual(t.snapshot(), { done: 0, total: 28, estimated: true });
  t.feed('[call 1/12] completed\n');
  assert.equal(t.snapshot().done, 1);
  t.feed('[plan] rec_trans=5\n[plan] conf=6\n');
  assert.deepEqual(t.snapshot(), { done: 1, total: 23, estimated: false });
});

test('lines split across chunks are not miscounted', () => {
  const t = createProgress({ calls: 3, rec_trans: 0, conf: 0 });
  t.feed('[plan] calls=3\n[call 1/');
  assert.equal(t.snapshot().done, 0);
  t.feed('3] completed\n[call 2/3] failed\n');
  assert.equal(t.snapshot().done, 2);
});

test('a category rolled to 0 contributes nothing; unrelated output is ignored', () => {
  const t = createProgress({ calls: 20, rec_trans: 0, conf: 0 });
  t.feed('Confirmed: Acct tier=stage\n[plan] calls=0\nDone generating.\n');
  assert.deepEqual(t.snapshot(), { done: 0, total: 0, estimated: false });
});

test('percent never hits 100 while running, and is 100 once finished', () => {
  assert.equal(percent({ done: 0, total: 0 }), 0);
  assert.equal(percent({ done: 5, total: 20 }), 25);
  assert.equal(percent({ done: 20, total: 20 }), 99);
  assert.equal(percent({ done: 25, total: 20 }), 99); // roll came in lower than the estimate
  assert.equal(percent({ done: 20, total: 20 }, true), 100);
});
