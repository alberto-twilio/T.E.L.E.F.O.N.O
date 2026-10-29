const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { createStore } = require('./lib/store');
const keychain = require('./lib/keychain');
const { createRunner } = require('./lib/runner');
const { describeAccount } = require('./lib/describe');
const { resolveCredentialIntent } = require('./lib/credintent');
const { TIERS, CATEGORIES, REGIONS, consoleUrl, VIDEO_ROOM_TYPES, VIDEO_AUDIO_ONLY, AUTH_KINDS, QUICK_TESTS, DEFAULTS, needsVideoKey, validateProfile, validateCredentials } = require('./lib/args');

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
  'id', 'name', 'tier', 'authKind', 'categories', 'calls', 'callDuration',
  'recordingsTranscriptions', 'conferences', 'regions', 'noProdCap',
  'videoEnabled', 'videoRooms', 'videoRoomTypes', 'videoAudioOnly', 'videoPrefix',
  'videoRecordingsEnabled', 'videoComposeEnabled', 'videoRecRooms', 'videoParticipants', 'videoHold', 'videoTempKeys', 'videoKeyHint',
];
const pickProfile = (p) => Object.fromEntries(PROFILE_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));

// The userData folder (profiles, run history) predates the TELEFONO name; pin it so a
// rename never hides existing data. Tests still override it with --user-data-dir.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'voice-test-data-gen-desktop'));
}

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
    pythonPath, wizardPath, TIERS, CATEGORIES, REGIONS, VIDEO_ROOM_TYPES, VIDEO_AUDIO_ONLY, AUTH_KINDS, QUICK_TESTS, DEFAULTS,
  }));

  // credentialsStored lets the UI flag a profile whose Keychain item is gone (deleted in Keychain Access, new Mac, ...)
  ipcMain.handle('profiles:list', () =>
    Promise.all(store.listProfiles().map(async (p) => ({
      ...p,
      credentialsStored: Boolean(await keychain.getCredentials(p.id)),
      videoKeyStored: Boolean(await keychain.getCredentials(`${p.id}:videokey`)),
    }))));

  // credentials: { sid, token, keySid? } on create (keySid when authKind is 'apikey', token is then the key's secret); on edit, leave token blank to keep the stored one.
  // videoKey: { sid, secret } for a Video API key; blank on edit keeps the stored one. Stored in the Keychain like the account credentials.
  ipcMain.handle('profiles:save', async (_e, { profile, credentials, videoKey }) => {
    const clean = pickProfile(profile);
    const errors = validateProfile(clean);
    const existing = clean.id ? store.getProfile(clean.id) : null;
    const hasStored = existing ? Boolean(await keychain.getCredentials(clean.id)) : false;
    // a profile whose stored credentials went missing must get them re-entered, not silently saved without
    const stored = existing && hasStored ? await keychain.getCredentials(clean.id) : null;
    const intent = resolveCredentialIntent({ existing, stored, credentials, authKind: clean.authKind || 'token' });
    const { wantsCreds, creds } = intent;
    errors.push(...intent.errors);
    if (wantsCreds) errors.push(...validateCredentials(creds, clean.authKind || 'token'));
    const newKey = videoKey && videoKey.sid && videoKey.sid.trim() && videoKey.secret && videoKey.secret.trim() ? { sid: videoKey.sid.trim(), token: videoKey.secret.trim() } : null;
    if (needsVideoKey(clean)) {
      const keyStored = clean.id ? Boolean(await keychain.getCredentials(`${clean.id}:videokey`)) : false;
      if (!newKey && !keyStored) errors.push('Enter the Video API Key SID and secret, or turn on temporary API keys.');
      if (newKey && !/^SK[0-9a-f]{32}$/i.test(newKey.sid)) errors.push('The API Key SID must look like SK followed by 32 hex characters.');
    }
    if (newKey) clean.videoKeyHint = newKey.sid.slice(-4);
    if (errors.length) throw new Error(errors.join(' '));

    if (wantsCreds) {
      clean.sidHint = creds.sid.trim().slice(-4);
      // main vs subaccount is read once, when the account is added (or its token replaced); also verifies the credentials on that tier
      const info = await describeAccount({ pythonPath, wizardPath, tier: clean.tier, creds: { sid: creds.sid.trim(), token: creds.token.trim(), ...(clean.authKind === 'apikey' ? { keySid: creds.keySid.trim() } : {}) } });
      clean.accountKind = info.kind;
      clean.accountName = info.friendlyName;
    }
    const saved = store.saveProfile(clean);
    if (wantsCreds) await keychain.setCredentials(saved.id, { sid: creds.sid.trim(), token: creds.token.trim(), ...(clean.authKind === 'apikey' ? { keySid: creds.keySid.trim() } : {}) });
    if (newKey) await keychain.setCredentials(`${saved.id}:videokey`, newKey);
    return saved;
  });

  // Only the SID is returned to the UI, never the token. The full SID lives in the Keychain, not in profiles.json.
  ipcMain.handle('profiles:sid', async (_e, id) => {
    const creds = await keychain.getCredentials(id);
    return creds ? creds.sid : null;
  });

  // Re-reads parent/subaccount for an existing profile with its stored credentials (read-only lookup via wizard.py).
  // Opens the account's page in the console; falls back to the console home if the SID is not readable.
  ipcMain.handle('profiles:console', async (_e, id) => {
    const profile = store.getProfile(id);
    if (!profile) return false;
    const creds = await keychain.getCredentials(id);
    const url = consoleUrl(profile.tier, creds && creds.sid && creds.sid.trim());
    if (!url) return false;
    shell.openExternal(url);
    return true;
  });
  ipcMain.handle('profiles:describe', async (_e, id) => {
    const profile = store.getProfile(id);
    if (!profile) throw new Error('Profile not found.');
    const creds = await keychain.getCredentials(id);
    if (!creds) throw new Error('No credentials stored for this profile. Edit it and re-enter them.');
    const info = await describeAccount({ pythonPath, wizardPath, tier: profile.tier, creds });
    const saved = store.saveProfile({ id, accountKind: info.kind, accountName: info.friendlyName });
    return { profile: saved, status: info.status };
  });

  ipcMain.handle('profiles:delete', async (_e, id) => {
    store.deleteProfile(id);
    await keychain.deleteCredentials(id);
    await keychain.deleteCredentials(`${id}:videokey`);
  });

  // The caller asks the user whether to copy credentials; they are never copied implicitly.
  ipcMain.handle('profiles:duplicate', async (_e, { id, copyCredentials }) => {
    const src = store.getProfile(id);
    if (!src) throw new Error('Profile not found.');
    const creds = copyCredentials ? await keychain.getCredentials(id) : null;
    if (copyCredentials && !creds) throw new Error('This profile has no stored credentials to copy.');
    const { id: _id, createdAt, updatedAt, sidHint, accountKind, accountName, ...rest } = src;
    const copy = store.saveProfile({ ...rest, name: `${src.name} (copy)`, ...(creds ? { sidHint, accountKind, accountName } : {}) });
    if (creds) await keychain.setCredentials(copy.id, creds);
    const key = copyCredentials ? await keychain.getCredentials(`${id}:videokey`) : null;
    if (key) await keychain.setCredentials(`${copy.id}:videokey`, key);
    return copy;
  });

  ipcMain.handle('runs:list', () => store.listRuns());
  ipcMain.handle('runs:get', (_e, id) => ({
    run: store.listRuns().find((r) => r.id === id) || null,
    log: store.readLog(id),
  }));

  // Runs still executing are never deleted: their log and results are being written.
  const deletableIds = (ids) => {
    const active = new Set(runner.activeRunIds());
    return ids.filter((id) => !active.has(id));
  };
  ipcMain.handle('runs:delete', (_e, ids) => store.deleteRuns(deletableIds(Array.isArray(ids) ? ids : [])));
  ipcMain.handle('runs:clear', (_e, profileId) =>
    store.deleteRuns(deletableIds(store.listRuns().filter((r) => r.profileId === profileId).map((r) => r.id))));

  ipcMain.handle('run:start', (_e, { profileId, confirmProd, quick }) => runner.start(profileId, { confirmProd: confirmProd === true, quick: typeof quick === 'string' ? quick : null }));
  ipcMain.handle('run:stop', (_e, runId) => runner.stop(runId));

  win = new BrowserWindow({
    width: 1360,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'T.E.L.E.F.O.N.O.',
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
