const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/store');
const { createRunner } = require('../lib/runner');
const { DEFAULTS } = require('../lib/args');

// A stand-in for `python3 -u wizard.py ...`: echoes the env/args it was given,
// writes a results file where --results-path says, exits with $FAKE_EXIT.
const fakePython = (dir) => {
  const file = path.join(dir, 'fakepython.sh');
  fs.writeFileSync(file, `#!/bin/sh
sleep \${FAKE_SLEEP:-0}
echo "args: $@"
echo "[plan] calls=2"
echo "[call 1/2] completed sid=CA1"
echo "[call 2/2] failed sid=CA2"
echo "sid-visible: $VOICEGEN_SID_STAGE"
while [ $# -gt 0 ]; do [ "$1" = "--results-path" ] && out="$2"; shift; done
echo '{"calls":[{"sid":"CA1"},{"sid":null,"error":"boom"}],"recordings_transcriptions":[],"conferences":[{"conference_sid":"CF1"}]}' > "$out"
exit \${FAKE_EXIT:-0}
`, { mode: 0o755 });
  return file;
};

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtdg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const profile = store.saveProfile({
    name: 'p', tier: 'stage', categories: ['calls', 'conferences'], calls: DEFAULTS.calls, callDuration: DEFAULTS.callDuration,
    recordingsTranscriptions: DEFAULTS.recordingsTranscriptions, conferences: DEFAULTS.conferences, regions: [],
  });
  const events = [];
  const keychain = { getCredentials: async () => ({ sid: 'ACtest', token: 'secret-token' }) };
  const runner = createRunner({
    store, keychain, pythonPath: fakePython(dir), wizardPath: '/x/wizard.py',
    send: (channel, payload) => events.push([channel, JSON.parse(JSON.stringify(payload))]),
  });
  return { store, profile, runner, events };
};

const finished = (events) =>
  new Promise((resolve) => {
    const tick = () => {
      const done = events.filter(([c, p]) => c === 'run:update' && p.status !== 'running').pop();
      return done ? resolve(done[1]) : setTimeout(tick, 20);
    };
    tick();
  });

test('successful run: logs streamed, env passed, summary recorded, history persisted', async (t) => {
  const { store, profile, runner, events } = setup(t);
  await runner.start(profile.id);
  const run = await finished(events);
  assert.equal(run.status, 'partial'); // exit 0 but 1 item errored
  assert.deepEqual(run.summary, { calls: 2, recordings: 0, conferences: 1, videoRooms: 0, errors: 1 });
  const log = store.readLog(run.id);
  assert.match(log, /sid-visible: ACtest/);
  assert.ok(!log.includes('secret-token'));
  assert.match(log, /--tier stage/);
  assert.ok(!log.includes('--confirm-prod'));
  assert.equal(store.listRuns()[0].status, 'partial');
  assert.deepEqual(runner.activeRunIds(), []);
});

test('progress events are emitted from the log and the final snapshot is stored on the run', async (t) => {
  const { store, profile, runner, events } = setup(t);
  await runner.start(profile.id);
  const run = await finished(events);
  const progress = events.filter(([c]) => c === 'run:progress').map(([, p]) => p);
  assert.ok(progress.length >= 2);
  assert.equal(progress[0].percent, 0);
  assert.deepEqual(store.listRuns()[0].progress, { done: 2, total: 2 + 8, estimated: true }); // conferences never announced a roll in this fake run
  assert.equal(run.progress.done, 2);
});

test('non-zero exit is recorded as failed', async (t) => {
  const { profile, runner, events } = setup(t);
  process.env.FAKE_EXIT = '3';
  t.after(() => delete process.env.FAKE_EXIT);
  await runner.start(profile.id);
  const run = await finished(events);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 3);
});

test('runs can overlap, each with its own log and results', async (t) => {
  const { store, profile, runner, events } = setup(t);
  process.env.FAKE_SLEEP = '0.3';
  t.after(() => delete process.env.FAKE_SLEEP);
  const a = await runner.start(profile.id);
  const b = await runner.start(profile.id);
  assert.notEqual(a.id, b.id);
  assert.equal(runner.activeRunIds().length, 2);
  await new Promise((resolve) => {
    const tick = () => (events.filter(([c, p]) => c === 'run:update' && p.status !== 'running').length >= 2 ? resolve() : setTimeout(tick, 20));
    tick();
  });
  const runs = store.listRuns();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'partial' && r.summary.calls === 2));
  assert.notEqual(store.paths(a.id).results, store.paths(b.id).results);
  assert.deepEqual(runner.activeRunIds(), []);
});

test('stop kills only the targeted run', async (t) => {
  const { store, profile, runner, events } = setup(t);
  process.env.FAKE_SLEEP = '0.5';
  t.after(() => delete process.env.FAKE_SLEEP);
  const a = await runner.start(profile.id);
  const b = await runner.start(profile.id);
  assert.equal(runner.stop(a.id), true);
  assert.equal(runner.stop('nope'), false);
  await new Promise((resolve) => {
    const tick = () => (events.filter(([c, p]) => c === 'run:update' && p.status !== 'running').length >= 2 ? resolve() : setTimeout(tick, 20));
    tick();
  });
  const byId = Object.fromEntries(store.listRuns().map((r) => [r.id, r.status]));
  assert.equal(byId[a.id], 'stopped');
  assert.equal(byId[b.id], 'partial'); // fake results contain one errored item
});

test('a double-click on the same profile starts one run, not two', async (t) => {
  const { profile, runner, events } = setup(t);
  const results = await Promise.allSettled([runner.start(profile.id), runner.start(profile.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await finished(events);
});

test('prod needs confirmation', async (t) => {
  const { store, profile, runner } = setup(t);
  const prod = store.saveProfile({ ...profile, name: 'prod', tier: 'prod', id: undefined });
  await assert.rejects(runner.start(prod.id), /confirmation/);
});

test('resolveStatus: partial only when some items failed and some worked', () => {
  const { resolveStatus } = require('../lib/runner');
  const s = (errors, videoRooms) => ({ calls: 0, recordings: 0, conferences: 0, videoRooms, errors });
  assert.equal(resolveStatus('success', s(0, 10)), 'success');
  assert.equal(resolveStatus('success', s(3, 10)), 'partial');
  assert.equal(resolveStatus('success', s(10, 10)), 'failed');
  assert.equal(resolveStatus('stopped', s(10, 10)), 'stopped');
});
