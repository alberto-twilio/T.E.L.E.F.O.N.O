const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/store');

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telefono-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore(dir);
};

const addRun = (store, id) => {
  store.saveRun({ id, profileId: 'p', status: 'success' });
  for (const f of Object.values(store.paths(id))) fs.writeFileSync(f, 'x');
};

test('deleteRuns removes the entries and their log/results files, and leaves the rest', (t) => {
  const store = setup(t);
  ['a', 'b', 'c'].forEach((id) => addRun(store, id));
  assert.equal(store.deleteRuns(['a', 'c', 'nope']), 2);
  assert.deepEqual(store.listRuns().map((r) => r.id), ['b']);
  assert.ok(!fs.existsSync(store.paths('a').log) && !fs.existsSync(store.paths('c').results));
  assert.ok(fs.existsSync(store.paths('b').log));
});

test('deleteRuns with nothing to delete changes nothing', (t) => {
  const store = setup(t);
  addRun(store, 'a');
  assert.equal(store.deleteRuns([]), 0);
  assert.equal(store.listRuns().length, 1);
});
