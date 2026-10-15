// Runs one wizard.py batch at a time as a child process, streams its output,
// and records the outcome in the run history.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { buildWizardArgs, envNames } = require('./args');
const { createProgress, expectedCounts, percent } = require('./progress');

const summarize = (results) => {
  if (!results) return null;
  const count = (list) => (list || []).length;
  const failed = (list) => (list || []).filter((e) => e && e.error).length;
  return {
    calls: count(results.calls),
    recordings: count(results.recordings_transcriptions),
    conferences: count(results.conferences),
    errors: failed(results.calls) + failed(results.recordings_transcriptions) + failed(results.conferences),
  };
};

const createRunner = ({ store, keychain, pythonPath, wizardPath, send }) => {
  const active = new Map(); // runId -> { child, stopped }; runs are independent and may overlap
  const starting = new Set(); // profile ids mid-start: launch() awaits the keychain, so this is what stops a double-click from firing twice

  const start = async (profileId, opts = {}) => {
    if (starting.has(profileId)) throw new Error('This profile is already starting a run.');
    starting.add(profileId);
    try {
      return await launch(profileId, opts);
    } finally {
      starting.delete(profileId);
    }
  };

  const launch = async (profileId, { confirmProd = false }) => {
    const profile = store.getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    if (!pythonPath) throw new Error('python3 was not found on this machine.');
    const creds = await keychain.getCredentials(profile.id);
    if (!creds) throw new Error('No credentials stored for this profile. Edit it and re-enter them.');

    const id = crypto.randomUUID();
    const paths = store.paths(id);
    const args = buildWizardArgs(profile, { wizardPath, resultsPath: paths.results, confirmProd });
    const { sidEnv, tokenEnv } = envNames(profile.tier);

    const run = {
      id,
      profileId: profile.id,
      profileName: profile.name,
      tier: profile.tier,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      spec: {
        categories: profile.categories,
        calls: profile.calls,
        callDuration: profile.callDuration,
        recordingsTranscriptions: profile.recordingsTranscriptions,
        conferences: profile.conferences,
        regions: profile.regions,
        noProdCap: Boolean(profile.noProdCap),
      },
      summary: null,
    };
    store.saveRun(run);

    const logStream = fs.createWriteStream(paths.log, { flags: 'a' });
    const tracker = createProgress(expectedCounts(profile));
    let lastProgress = '';
    const emit = (chunk) => {
      logStream.write(chunk);
      send('run:log', { runId: id, chunk });
      tracker.feed(chunk);
      const snap = tracker.snapshot();
      const key = JSON.stringify(snap);
      if (key !== lastProgress) {
        lastProgress = key;
        send('run:progress', { runId: id, ...snap, percent: percent(snap) });
      }
    };

    const child = spawn(pythonPath, args, {
      env: { ...process.env, [sidEnv]: creds.sid, [tokenEnv]: creds.token, PYTHONUNBUFFERED: '1' },
      cwd: require('node:path').dirname(paths.log),
    });
    const entry = { child, stopped: false };
    active.set(id, entry);

    const finish = (status, exitCode) => {
      if (run.finishedAt) return; // 'error' and 'close' can both fire
      run.finishedAt = new Date().toISOString();
      run.status = status;
      run.exitCode = exitCode;
      run.summary = summarize(store.readResults(id));
      run.progress = tracker.snapshot();
      logStream.end();
      active.delete(id);
      store.saveRun(run);
      send('run:update', run);
    };

    child.stdout.on('data', (d) => emit(d.toString()));
    child.stderr.on('data', (d) => emit(d.toString()));
    child.on('error', (e) => {
      emit(`\nFailed to start python: ${e.message}\n`);
      finish('failed', null);
    });
    child.on('close', (code) => {
      finish(entry.stopped ? 'stopped' : code === 0 ? 'success' : 'failed', code);
    });

    send('run:update', run);
    send('run:progress', { runId: id, ...tracker.snapshot(), percent: 0 });
    return run;
  };

  const stop = (runId) => {
    const entry = active.get(runId);
    if (!entry) return false;
    entry.stopped = true;
    entry.child.kill('SIGTERM');
    return true;
  };

  const stopAll = () => [...active.keys()].forEach(stop);

  const activeRunIds = () => [...active.keys()];

  return { start, stop, stopAll, activeRunIds };
};

module.exports = { createRunner, summarize };
