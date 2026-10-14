const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { createStore } = require('./lib/store');
const keychain = require('./lib/keychain');
const { createRunner } = require('./lib/runner');
const { TIERS, CATEGORIES, REGIONS, DEFAULTS, validateProfile, validateCredentials } = require('./lib/args');

const PYTHON_FALLBACKS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

// A Finder-launched app doesn't inherit the shell PATH, so ask a login shell
// (picks up pyenv/homebrew) and fall back to the usual locations.
const findPython = () =>
  new Promise((resolve) => {
    if (process.env.VOICEGEN_PYTHON) return resolve(process.env.VOICEGEN_PYTHON); // override, used for UI tests
    const fallback = () => resolve(PYTHON_FALLBACKS.find((p) => fs.existsSync(p)) || null);
    execFile('/bin/zsh', ['-lc', 'command -v python3'], { timeout: 5000 }, (err, stdout) => {
      const found = !err && stdout.trim().split('\n').pop();
      if (found && fs.existsSync(found)) resolve(found);
      else fallback();
    });
  });

const pythonSourceDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'py') : path.join(__dirname, '..'));

let win = null;
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const PROFILE_FIELDS = [
  'id', 'name', 'tier', 'categories', 'calls', 'callDuration',
  'recordingsTranscriptions', 'conferences', 'regions', 'noProdCap',
];
const pickProfile = (p) => Object.fromEntries(PROFILE_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));

const main = async () => {
  await app.whenReady();
  const store = createStore(app.getPath('userData'));
  const pythonPath = await findPython();
  const wizardPath = path.join(pythonSourceDir(), 'wizard.py');
  const runner = createRunner({ store, keychain, pythonPath, wizardPath, send });
  app.on('before-quit', () => runner.stopAll());
  // a run still marked running at startup was killed with the app; don't leave a spinner on it forever
  for (const r of store.listRuns()) {
    if (r.status === 'running') store.saveRun({ ...r, status: 'interrupted', finishedAt: new Date().toISOString() });
  }

  ipcMain.handle('app:info', () => ({
    pythonPath, wizardPath, TIERS, CATEGORIES, REGIONS, DEFAULTS,
  }));

  // credentialsStored lets the UI flag a profile whose Keychain item is gone (deleted in Keychain Access, new Mac, ...)
  ipcMain.handle('profiles:list', () =>
    Promise.all(store.listProfiles().map(async (p) => ({ ...p, credentialsStored: Boolean(await keychain.getCredentials(p.id)) }))));

  // credentials: { sid, token } on create; on edit, leave token blank to keep the stored one.
  ipcMain.handle('profiles:save', async (_e, { profile, credentials }) => {
    const clean = pickProfile(profile);
    const errors = validateProfile(clean);
    const existing = clean.id ? store.getProfile(clean.id) : null;
    const hasStored = existing ? Boolean(await keychain.getCredentials(clean.id)) : false;
    // a profile whose stored credentials went missing must get them re-entered, not silently saved without
    const wantsCreds = !existing || !hasStored || (credentials && (credentials.sid || credentials.token));
    if (wantsCreds) errors.push(...validateCredentials(credentials || {}));
    if (errors.length) throw new Error(errors.join(' '));

    if (wantsCreds) clean.sidHint = credentials.sid.trim().slice(-4);
    const saved = store.saveProfile(clean);
    if (wantsCreds) await keychain.setCredentials(saved.id, { sid: credentials.sid.trim(), token: credentials.token.trim() });
    return saved;
  });

  ipcMain.handle('profiles:delete', async (_e, id) => {
    store.deleteProfile(id);
    await keychain.deleteCredentials(id);
  });

  // The caller asks the user whether to copy credentials; they are never copied implicitly.
  ipcMain.handle('profiles:duplicate', async (_e, { id, copyCredentials }) => {
    const src = store.getProfile(id);
    if (!src) throw new Error('Profile not found.');
    const creds = copyCredentials ? await keychain.getCredentials(id) : null;
    if (copyCredentials && !creds) throw new Error('This profile has no stored credentials to copy.');
    const { id: _id, createdAt, updatedAt, sidHint, ...rest } = src;
    const copy = store.saveProfile({ ...rest, name: `${src.name} (copy)`, ...(creds ? { sidHint } : {}) });
    if (creds) await keychain.setCredentials(copy.id, creds);
    return copy;
  });

  ipcMain.handle('runs:list', () => store.listRuns());
  ipcMain.handle('runs:get', (_e, id) => ({
    run: store.listRuns().find((r) => r.id === id) || null,
    log: store.readLog(id),
  }));

  ipcMain.handle('run:start', (_e, { profileId, confirmProd }) => runner.start(profileId, { confirmProd: confirmProd === true }));
  ipcMain.handle('run:stop', (_e, runId) => runner.stop(runId));

  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Voice Test Data Gen',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
};

app.on('window-all-closed', () => {
  app.quit();
});

main();
