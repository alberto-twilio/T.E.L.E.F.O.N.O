// Profiles and run history, as plain JSON under the app's userData dir.
// Profiles hold specs ("10-30"), never rolled numbers, and no credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RUNS = 200;

const createStore = (dir) => {
  const profilesFile = path.join(dir, 'profiles.json');
  const runsFile = path.join(dir, 'runs.json');
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  };
  // write-then-rename so a crash mid-write can't leave half a file
  const writeJson = (file, data) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };

  const listProfiles = () => readJson(profilesFile, []);

  const saveProfile = (profile) => {
    const profiles = listProfiles();
    const now = new Date().toISOString();
    const existing = profile.id ? profiles.findIndex((p) => p.id === profile.id) : -1;
    if (existing >= 0) {
      profiles[existing] = { ...profiles[existing], ...profile, updatedAt: now };
      writeJson(profilesFile, profiles);
      return profiles[existing];
    }
    const created = { ...profile, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    profiles.push(created);
    writeJson(profilesFile, profiles);
    return created;
  };

  const deleteProfile = (id) => writeJson(profilesFile, listProfiles().filter((p) => p.id !== id));

  const getProfile = (id) => listProfiles().find((p) => p.id === id) || null;

  const listRuns = () => readJson(runsFile, []);

  const paths = (runId) => ({
    log: path.join(runsDir, `${runId}.log`),
    results: path.join(runsDir, `${runId}.results.json`),
  });

  const saveRun = (run) => {
    const runs = listRuns();
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = run;
    else runs.unshift(run);
    const dropped = runs.splice(MAX_RUNS);
    for (const r of dropped) {
      for (const f of Object.values(paths(r.id))) fs.rmSync(f, { force: true });
    }
    writeJson(runsFile, runs);
  };

  const readLog = (runId) => {
    try {
      return fs.readFileSync(paths(runId).log, 'utf8');
    } catch (e) {
      return '';
    }
  };

  const readResults = (runId) => readJson(paths(runId).results, null);

  return {
    listProfiles, saveProfile, deleteProfile, getProfile,
    listRuns, saveRun, readLog, readResults, paths,
  };
};

module.exports = { createStore };
