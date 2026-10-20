// Runs one wizard.py batch at a time as a child process, streams its output,
// and records the outcome in the run history.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { buildWizardArgs, envNames, needsVideoKey, quickProfile, QUICK_TESTS } = require('./args');
const { createProgress, expectedCounts, percent } = require('./progress');

const summarize = (results) => {
  if (!results) return null;
  const count = (list) => (list || []).length;
  const failed = (list) => (list || []).filter((e) => e && e.error).length;
  return {
    calls: count(results.calls),
    recordings: count(results.recordings_transcriptions),
    conferences: count(results.conferences),
    videoRooms: count(results.video_rooms),
    videoRecordings: count(results.video_recordings),
    videoCompositions: count(results.video_compositions),
    errors: failed(results.calls) + failed(results.recordings_transcriptions) + failed(results.conferences) + failed(results.video_rooms)
      + failed(results.video_recordings) + failed(results.video_compositions),
  };
};

// Exit code 0 only means wizard.py finished. Item-level errors decide the rest:
// some failed and some worked = partial; every item failed = failed.
const resolveStatus = (status, summary) => {
  if (status !== 'success' || !summary || summary.errors === 0) return status;
  const items = summary.calls + summary.recordings + summary.conferences + summary.videoRooms + (summary.videoRecordings || 0) + (summary.videoCompositions || 0);
  return summary.errors >= items ? 'failed' : 'partial';
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

  const launch = async (profileId, { confirmProd = false, quick = null }) => {
    const stored = store.getProfile(profileId);
    if (!stored) throw new Error('Profile not found.');
    if (quick && !QUICK_TESTS[quick]) throw new Error('Unknown quick test.');
    const profile = quick ? quickProfile(stored, quick) : stored;
    if (!pythonPath) throw new Error('python3 was not found on this machine.');
    const creds = await keychain.getCredentials(profile.id);
    if (!creds) throw new Error('No credentials stored for this profile. Edit it and re-enter them.');

    const id = crypto.randomUUID();
    const paths = store.paths(id);
    const args = buildWizardArgs(profile, { wizardPath, resultsPath: paths.results, confirmProd });
    const { sidEnv, tokenEnv, videoKeyEnv, videoSecretEnv } = envNames(profile.tier);
    const videoKey = needsVideoKey(profile) ? await keychain.getCredentials(`${profile.id}:videokey`) : null;
    if (needsVideoKey(profile) && !videoKey) throw new Error('This profile needs a Video API key but none is stored. Edit it and enter one, or use temporary keys.');

    const run = {
      id,
      profileId: profile.id,
      profileName: profile.name,
      tier: profile.tier,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      ...(quick ? { quickTest: quick } : {}),
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
      const snap = { ...tracker.snapshot(), cats: tracker.breakdown() };
      const key = JSON.stringify(snap);
      if (key !== lastProgress) {
        lastProgress = key;
        send('run:progress', { runId: id, ...snap, percent: percent(snap) });
      }
    };

    const child = spawn(pythonPath, args, {
      env: {
        ...process.env, [sidEnv]: creds.sid, [tokenEnv]: creds.token, PYTHONUNBUFFERED: '1',
        ...(videoKey ? { [videoKeyEnv]: videoKey.sid, [videoSecretEnv]: videoKey.token } : {}),
      },
      cwd: require('node:path').dirname(paths.log),
    });
    const entry = { child, stopped: false };
    active.set(id, entry);

    const finish = (status, exitCode) => {
      if (run.finishedAt) return; // 'error' and 'close' can both fire
      run.finishedAt = new Date().toISOString();
      run.exitCode = exitCode;
      run.summary = summarize(store.readResults(id));
      // exit code 0 only means wizard.py finished; item-level errors (e.g. rejected Video rooms) make it partial
      run.status = resolveStatus(status, run.summary);
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

module.exports = { createRunner, summarize, resolveStatus };
