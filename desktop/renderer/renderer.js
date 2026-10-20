/* global api */
const state = {
  info: null,
  profiles: [],
  runs: [],
  selectedProfileId: null,
  view: 'empty', // empty | profile | edit | run
  viewRunId: null,
  liveLog: '',
  checked: new Set(), // profile ids ticked for "Run selected"
  progress: {}, // runId -> { done, total, estimated, percent } for runs in flight
};

const $ = (sel) => document.querySelector(sel);

// tiny DOM builder; strings go through textContent so profile names can't inject markup
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

// 'partial' = the run finished but some items errored; say how many
const statusLabel = (r) => (r.status === 'partial' && r.summary ? `partial (${r.summary.errors} error${r.summary.errors === 1 ? '' : 's'})` : r.status);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtDuration = (run) => {
  if (!run.finishedAt) return '';
  return fmtSeconds(Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000));
};
// live elapsed time for a running run, repainted every second by the ticker below
const elapsedEl = (run) => h('span', { class: 'mono', 'data-elapsed': run.startedAt }, fmtSeconds(Math.max(0, Math.round((Date.now() - new Date(run.startedAt)) / 1000))));
setInterval(() => {
  for (const el of document.querySelectorAll('[data-elapsed]')) el.textContent = fmtSeconds(Math.max(0, Math.round((Date.now() - new Date(el.dataset.elapsed)) / 1000)));
}, 1000);
// one count cell: live done/total while the run is going, the final number after
const countCell = (r, cat, finalValue) => {
  if (r.status !== 'running') return h('td', {}, r.summary ? String(finalValue) : '–');
  const c = state.progress[r.id] && state.progress[r.id].cats && state.progress[r.id].cats[cat];
  return h('td', { 'data-count': r.id, 'data-cat': cat }, c && c.total ? `${c.done}/${c.total}` : '–');
};
// what a profile generates: Voice (any category on), Video, or both
const hasVoice = (p) => p.categories.length > 0;
const kindPills = (p) => h('div', { class: 'pills' },
  tierBadge(p.tier),
  kindBadge(p),
  hasVoice(p) && h('span', { class: 'pill voice', title: 'Generates Voice data' }, 'Voice'),
  p.videoEnabled && h('span', { class: 'pill video', title: 'Generates Video rooms' }, 'Video'));
const runnableNow = (p) => p.credentialsStored;
// environment and account type use the same pill as Voice/Video
const tierBadge = (tier) => h('span', { class: `pill tier ${tier}`, title: `${tier} environment` }, tier);
const kindBadge = (p) => {
  const label = { main: 'Parent', sub: 'Subaccount' }[p.accountKind];
  return label ? h('span', { class: `pill kind ${p.accountKind}`, title: p.accountName ? `${label} account: ${p.accountName}` : `${label} account` }, label) : null;
};
const CHECKED_KEY = 'checkedProfiles';
const loadChecked = () => {
  try { return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY)) || []); } catch (e) { return new Set(); }
};
const saveChecked = () => {
  try { localStorage.setItem(CHECKED_KEY, JSON.stringify([...state.checked])); } catch (e) { /* convenience only */ }
};
// profiles the bulk button acts on: the ticked ones, or every runnable one if none are ticked
const runTitle = (p) => (!p.credentialsStored ? 'Re-enter credentials first' : 'Run this profile');
const runnableProfiles = () => state.profiles.filter((p) => runnableNow(p) && !busy(p));
const bulkTargets = () => {
  const ticked = runnableProfiles().filter((p) => state.checked.has(p.id));
  return ticked.length ? ticked : runnableProfiles();
};

const selected = () => state.profiles.find((p) => p.id === state.selectedProfileId) || null;
const runningRuns = (profileId) => state.runs.filter((r) => r.status === 'running' && (!profileId || r.profileId === profileId));
const spinner = (title) => h('span', { class: 'spinner', role: 'status', 'aria-label': title || 'Running', title: title || 'Running' });
// Progress bar + label for one run. Painted in place from `paintProgress`, so a
// log line arriving never re-renders a whole view.
const progressLabel = (p) => (p ? `${p.percent}%` : '');
const progressEl = (runId, { detail = false } = {}) =>
  h('span', { class: 'progress', 'data-progress': runId, 'data-detail': detail ? '1' : '' },
    h('span', { class: 'bar' }, h('i')), h('span', { class: 'pct' }));
const paintProgress = (runId) => {
  const p = state.progress[runId];
  for (const el of document.querySelectorAll(`[data-progress="${runId}"]`)) {
    el.querySelector('i').style.width = `${p ? p.percent : 0}%`;
    const detail = el.dataset.detail && p ? `  ${p.done}/${p.total}${p.estimated ? ' (estimated total)' : ''}` : '';
    el.querySelector('.pct').textContent = progressLabel(p) + detail;
  }
  for (const el of document.querySelectorAll(`[data-count="${runId}"]`)) {
    const c = p && p.cats && p.cats[el.dataset.cat];
    el.textContent = c && c.total ? `${c.done}/${c.total}` : '–';
  }
  for (const btn of document.querySelectorAll(`[data-run-btn="${runId}"]`)) btn.textContent = progressLabel(p) || '0%';
};
const canRun = () => Boolean(state.info && state.info.pythonPath);

// ------------------------------------------------------------ sidebar ----

// A profile with a run in flight shows its progress inside the (disabled) Run button, at a fixed width.
const busy = (p) => runningRuns(p.id).length > 0;
const runButton = (p, { label, small, onClick }) => {
  const run = runningRuns(p.id)[0];
  const size = small ? 'small' : 'big';
  if (run) {
    return h('button', { class: `primary run-btn running ${size}`, disabled: true, 'data-run-btn': run.id, title: 'Run in progress' },
      progressLabel(state.progress[run.id]) || '0%');
  }
  return h('button', { class: `primary run-btn ${size}`, disabled: !canRun() || !runnableNow(p), title: runTitle(p), onClick }, label);
};

const renderSidebar = () => {
  const list = $('#profile-list');
  list.replaceChildren(
    ...state.profiles.map((p) =>
      h('li', { class: p.id === state.selectedProfileId ? 'selected' : '', onClick: () => selectProfile(p.id) },
        h('input', {
          type: 'checkbox', class: 'pick', 'aria-label': `Select ${p.name}`, title: runnableNow(p) ? 'Include in Run selected' : 'No credentials',
          checked: runnableNow(p) && state.checked.has(p.id), disabled: !runnableNow(p),
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => {
            if (e.target.checked) state.checked.add(p.id); else state.checked.delete(p.id);
            saveChecked();
            renderSidebar();
          },
        }),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, p.name),
          kindPills(p)),
        p.credentialsStored ? null : h('span', { class: 'badge warn', title: 'Credentials missing from the Keychain' }, 'no creds'),
        runButton(p, { label: 'Run', small: true, onClick: (e) => { e.stopPropagation(); requestRun(p); } }))));
  const runnable = runnableProfiles();
  const ticked = runnable.filter((p) => state.checked.has(p.id));
  const all = $('#run-all');
  all.disabled = !canRun() || runnable.length === 0;
  all.textContent = ticked.length ? `Run selected (${ticked.length})` : runnable.length ? `Run all (${runnable.length})` : 'Run all';
  $('#env-note').textContent = state.info && !state.info.pythonPath ? 'python3 not found. Runs are disabled.' : '';
};

// --------------------------------------------------------- main views ----

const renderMain = () => {
  renderMainInner();
  for (const id of Object.keys(state.progress)) paintProgress(id);
};

const renderMainInner = () => {
  const main = $('#main');
  if (state.view === 'edit') return main.replaceChildren(editView(selectedForEdit));
  if (state.view === 'run') return main.replaceChildren(runView());
  const p = selected();
  if (state.view === 'profile' && p) return main.replaceChildren(profileView(p));
  main.replaceChildren(h('div', { class: 'empty' },
    h('h2', {}, 'No profile selected'),
    h('p', {}, 'A profile stores an environment, credentials and a plan, so a recurring batch is one click.'),
    h('button', { class: 'primary', onClick: () => startEdit(null) }, 'Create a profile')));
};

// Full Account SID, read from the Keychain on demand (profiles.json only keeps the last 4).
// Shows the short form until it arrives, or if there is nothing stored.
const sidCache = {};
const accountSid = (p) => {
  const el = h('span', { class: 'mono sid' }, sidCache[p.id] || `AC…${p.sidHint || '????'}`);
  if (p.credentialsStored && !sidCache[p.id]) {
    api.getProfileSid(p.id).then((sid) => {
      if (!sid) return;
      sidCache[p.id] = sid;
      el.textContent = sid;
    });
  }
  return el;
};

const profileView = (p) => {
  const runs = state.runs.filter((r) => r.profileId === p.id);
  const stats = [
    ['Account SID', accountSid(p), true],
    ['Environment', tierBadge(p.tier)],
    ['Calls', p.categories.includes('calls') ? `${p.calls}  (duration ${p.callDuration})` : 'off'],
    ['Recordings / transcriptions', p.categories.includes('recordings_transcriptions') ? p.recordingsTranscriptions : 'off'],
    ['Conferences', p.categories.includes('conferences')
      ? `${p.conferences}${p.regions && p.regions.length ? `  (${p.regions.join(', ')})` : ''}` : 'off'],
    ['Video rooms', p.videoEnabled
      ? `${p.videoRooms}  (${p.videoRoomTypes && p.videoRoomTypes.length ? p.videoRoomTypes.join(', ') : 'group only'}; prefix ${p.videoPrefix})` : 'off'],
    ['Video recordings', p.videoEnabled && p.videoRecordingsEnabled
      ? `${p.videoParticipants} participants in ${p.videoRecRooms} rooms, hold ${p.videoHold}s (${p.videoTempKeys === false ? 'own API key' : 'temporary API keys'})` : 'off'],
  ];
  if (p.tier === 'prod') stats.push(['Prod caps', p.noProdCap ? 'lifted (--no-prod-cap)' : '30 per category, 5m per call']);

  return h('div', {},
    h('div', { class: 'row spread' },
      h('div', { class: 'row' }, h('h2', {}, p.name), tierBadge(p.tier), kindBadge(p), runningRuns(p.id).length > 0 && h('span', { class: 'running-tag' }, spinner(), `${runningRuns(p.id).length} running`)),
      h('div', { class: 'row' },
        runButton(p, { label: 'Run now', onClick: () => requestRun(p) }),
        h('button', { onClick: () => startEdit(p) }, 'Edit'),
        h('button', { disabled: !p.credentialsStored || !canRun(), title: p.credentialsStored ? 'Read whether this is a parent or a subaccount' : 'No credentials', onClick: (e) => checkAccount(p, e.currentTarget) }, 'Check account'),
        h('button', { title: `Open the ${p.tier} Twilio console in your browser (log in as this account)`, onClick: () => api.openConsole(p.id) }, 'Open account in 1C'),
        h('button', { onClick: () => confirmDuplicate(p) }, 'Duplicate'),
        h('button', { class: 'danger', onClick: () => confirmDelete(p) }, 'Delete'))),
    p.credentialsStored ? null : h('div', { class: 'callout mt-14' },
      'The Account SID and Auth Token for this profile are not in the Keychain, so it cannot run. ',
      h('a', { href: '#', onClick: (e) => { e.preventDefault(); startEdit(p); } }, 'Edit the profile and enter them again.')),
    h('div', { class: 'card mt-16' },
      h('div', { class: 'grid' }, stats.map(([k, v, wide]) => h('div', { class: wide ? 'span-all' : '' }, h('div', { class: 'muted small' }, k), h('div', {}, v))))),
    h('p', { class: 'muted small' }, 'Ranges like 10-30 are re-rolled fresh on every run, never frozen.'),
    h('h3', {}, 'Run history'),
    runs.length === 0 ? h('p', { class: 'muted' }, 'No runs yet.') : runsTable(runs));
};

const runsTable = (runs) =>
  h('div', { class: 'card tight' },
    h('table', {},
      h('thead', {}, h('tr', {}, ['Started', 'Status', 'Duration', 'Calls', 'Rec.', 'Conf.', 'Rooms', 'Video rec.', 'Errors'].map((t) => h('th', {}, t)))),
      h('tbody', {}, runs.map((r) => {
        const s = r.summary;
        return h('tr', { onClick: () => openRun(r.id) },
          h('td', {}, fmtTime(r.startedAt)),
          h('td', { class: `status-${r.status}` }, r.status === 'running' ? h('span', { class: 'row gap-6' }, spinner(), progressEl(r.id)) : statusLabel(r)),
          h('td', {}, r.status === 'running' ? elapsedEl(r) : fmtDuration(r)),
          countCell(r, 'calls', s && s.calls),
          countCell(r, 'rec_trans', s && s.recordings),
          countCell(r, 'conf', s && s.conferences),
          countCell(r, 'video_rooms', s && (s.videoRooms || 0)),
          countCell(r, 'video_recordings', s && (s.videoRecordings || 0)),
          h('td', {}, s ? String(s.errors) : '–'));
      }))));

const runView = () => {
  const run = state.runs.find((r) => r.id === state.viewRunId);
  const live = run && run.status === 'running';
  const log = h('pre', { class: 'log', id: 'log' }, state.liveLog || (live ? 'Starting…' : '(no output)'));
  queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  return h('div', { class: 'run-view' },
    h('div', { class: 'row spread' },
      h('div', { class: 'row' },
        h('h2', {}, run ? run.profileName : 'Run'),
        run && tierBadge(run.tier),
        run && h('span', { class: `status-${run.status}` }, live ? h('span', { class: 'row gap-6' }, spinner(), 'running') : statusLabel(run))),
      
      h('div', { class: 'row' },
        live && h('button', { class: 'danger', onClick: () => api.stopRun(run.id) }, 'Stop'),
        h('button', { onClick: () => { state.view = selected() ? 'profile' : 'empty'; renderMain(); } }, 'Back'))),
    live && h('div', { class: 'progress-block' }, progressEl(run.id, { detail: true })),
    run && h('p', { class: 'muted small' },
      `Started ${fmtTime(run.startedAt)}`, run.finishedAt ? ` · took ${fmtDuration(run)}` : live ? [' · elapsed ', elapsedEl(run)] : ''),
    log);
};

// --------------------------------------------------------- edit form -----

let selectedForEdit = null;

const startEdit = (p) => {
  selectedForEdit = p;
  state.view = 'edit';
  renderMain();
};

const editView = (existing) => {
  const D = state.info.DEFAULTS;
  const p = existing || {
    name: '', tier: 'stage', categories: [...state.info.CATEGORIES], calls: D.calls, callDuration: D.callDuration,
    recordingsTranscriptions: D.recordingsTranscriptions, conferences: D.conferences, regions: [], noProdCap: false,
    videoEnabled: false,
  };
  const V = (k) => (p[k] != null ? p[k] : D[k]);
  const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint && h('div', { class: 'hint' }, hint));
  const text = (id, value, type = 'text') => h('input', { type, id, value: value ?? '', autocomplete: 'off', spellcheck: 'false' });

  // detail fields are always folded away by default (new and existing profiles), so the form stays short
  const customize = (...children) => h('details', { class: 'customize' }, h('summary', {}, 'Customize'), ...children);

  const tier = h('select', { id: 'f-tier' }, state.info.TIERS.map((t) => h('option', { value: t, selected: t === p.tier }, t)));
  const checks = (name, all, chosen, labels = {}) =>
    h('div', { class: 'row' }, all.map((v) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: v, checked: chosen.includes(v) }), labels[v] || v)));

  // The Account SID is fixed once a profile has stored credentials: another account means another profile.
  const sidLocked = Boolean(existing && p.credentialsStored);
  const sidInput = text('f-sid', sidLocked ? (sidCache[p.id] || `AC…${p.sidHint}`) : '');
  if (sidLocked) {
    sidInput.disabled = true; // greyed out: the SID is fixed once a profile has credentials
    sidInput.classList.add('mono');
    if (!sidCache[p.id]) api.getProfileSid(p.id).then((sid) => { if (sid) { sidCache[p.id] = sid; sidInput.value = sid; } });
  }
  const sidField = field('Account SID', sidInput, sidLocked
    ? 'Fixed for this profile. To use another account, create a new profile. Enter a new Auth Token below to replace the token.'
    : existing && p.sidHint ? `Re-enter the SID this profile was created with (ending ${p.sidHint}).` : 'AC followed by 32 hex characters. It cannot be changed afterwards.');

  // The stored token is never read back into the UI; asterisks are a placeholder, so empty still means "keep".
  const tokenInput = text('f-token', '', 'password');
  if (sidLocked) tokenInput.setAttribute('placeholder', '*'.repeat(32));

  const errorBox = h('ul', { class: 'errors', id: 'form-errors' });
  const noCap = h('div', { id: 'nocap-wrap' },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'f-nocap', checked: Boolean(p.noProdCap) }),
      'Lift the prod caps (30 per category, 5m per call)'),
    h('div', { class: 'hint' }, 'Only lifts the caps. Every prod run still needs you to type PROD.'));
  const syncNoCap = () => { noCap.style.display = tier.value === 'prod' ? '' : 'none'; };
  tier.addEventListener('change', syncNoCap);
  queueMicrotask(syncNoCap);

  // Voice and Video are independent sections; each has an on/off checkbox, and fields that don't apply are disabled.
  const voiceOn = h('input', { type: 'checkbox', id: 'f-voice-on', checked: p.categories.length > 0 });
  const catBoxes = checks('categories', state.info.CATEGORIES, p.categories.length ? p.categories : state.info.CATEGORIES,
    { recordings_transcriptions: 'recordings/transcriptions' });
  const voiceInputs = {
    calls: [text('f-calls', p.calls), text('f-duration', p.callDuration)],
    recordings_transcriptions: [text('f-rec', p.recordingsTranscriptions)],
    conferences: [text('f-conf', p.conferences)],
  };
  const regionBoxes = checks('regions', state.info.REGIONS, p.regions || []);
  const catChecked = (c) => Boolean(catBoxes.querySelector(`input[value=${c}]`).checked);
  const syncVoice = () => {
    const on = voiceOn.checked;
    for (const box of catBoxes.querySelectorAll('input')) box.disabled = !on;
    for (const [cat, inputs] of Object.entries(voiceInputs)) for (const i of inputs) i.disabled = !(on && catChecked(cat));
    for (const box of regionBoxes.querySelectorAll('input')) box.disabled = !(on && catChecked('conferences'));
  };
  voiceOn.addEventListener('change', syncVoice);
  catBoxes.addEventListener('change', syncVoice);
  queueMicrotask(syncVoice);
  const voiceSection = h('div', { class: 'section' },
    h('h3', {}, 'Voice'),
    h('label', { class: 'check' }, voiceOn, 'Generate Voice data (calls, recordings, conferences)'),
    h('div', { class: 'hint' }, 'With the defaults every category runs with random counts and durations.'),
    customize(
      h('div', { class: 'mt-12' }, catBoxes),
      h('div', { class: 'grid mt-12' },
        field('Calls', voiceInputs.calls[0], 'Number, min-max range, or 0.'),
        field('Call duration', voiceInputs.calls[1], 'Range like 1s-3m. Applies to completed calls.'),
        field('Recordings / transcriptions', voiceInputs.recordings_transcriptions[0]),
        field('Conferences', voiceInputs.conferences[0])),
      h('div', { class: 'mt-12' }, h('label', {}, 'Conference regions (optional)'), regionBoxes)));

  const videoOn = h('input', { type: 'checkbox', id: 'f-video-on', checked: Boolean(p.videoEnabled) });
  const recOn = h('input', { type: 'checkbox', id: 'f-video-rec-on', checked: p.videoRecordingsEnabled === true });
  const tempKeys = h('input', { type: 'checkbox', id: 'f-video-tempkeys', checked: p.videoTempKeys !== false });
  const videoText = {
    rooms: text('f-video-rooms', V('videoRooms')),
    recRooms: text('f-video-recrooms', V('videoRecRooms')),
    participants: text('f-video-participants', V('videoParticipants')),
    hold: text('f-video-hold', V('videoHold')),
    prefix: text('f-video-prefix', V('videoPrefix')),
    keySid: text('f-video-keysid', ''),
    keySecret: text('f-video-keysecret', '', 'password'),
  };
  videoText.keySid.placeholder = p.videoKeyStored ? `SK…${p.videoKeyHint || ''} (stored)` : 'SKxxxxxxxx…';
  videoText.keySecret.placeholder = p.videoKeyStored ? '•••••••• (stored; leave blank to keep)' : 'API key secret';
  const videoTypeBoxes = checks('videoRoomTypes', state.info.VIDEO_ROOM_TYPES, p.videoRoomTypes || [],
    { 'group-small': 'group-small (legacy)', 'peer-to-peer': 'peer-to-peer (legacy)' });
  const keyFields = h('div', { class: 'grid mt-12' },
    field('API Key SID', videoText.keySid, 'Stored in the macOS Keychain, never in the profile file.'),
    field('API Key secret', videoText.keySecret));
  const videoNote = h('div', { class: 'hint', id: 'video-note' });
  const syncVideo = () => {
    const prod = tier.value === 'prod';
    const on = videoOn.checked;
    const rec = on && recOn.checked;
    recOn.disabled = !on;
    tempKeys.disabled = !rec;
    for (const i of [videoText.rooms, videoText.prefix, ...videoTypeBoxes.querySelectorAll('input')]) i.disabled = !on;
    for (const i of [videoText.recRooms, videoText.participants, videoText.hold]) i.disabled = !rec;
    keyFields.style.display = rec && !tempKeys.checked ? '' : 'none';
    for (const i of [videoText.keySid, videoText.keySecret]) i.disabled = !(rec && !tempKeys.checked);
    videoNote.textContent = (prod ? 'On prod, each Video category is capped at 30 per run unless the profile lifts the caps, and every run asks for PROD confirmation. ' : '')
      + 'Creates empty rooms, and optionally rooms where participants join a headless browser so Twilio records them (needs Playwright).';
  };
  tier.addEventListener('change', syncVideo);
  videoOn.addEventListener('change', syncVideo);
  recOn.addEventListener('change', () => {
    syncVideo();
    if (!recOn.checked) return;
    showNotice('notice.playwright', 'Playwright is required', [
      h('p', {}, 'Video recordings need participants to join the rooms from a headless browser, which uses Playwright. Without it these items fail and the run ends as partial.'),
      h('p', {}, 'Install it once for the python3 this app uses:'),
      h('pre', { class: 'log' }, 'pip3 install playwright'),
      h('p', { class: 'muted small' }, 'It reuses a Chromium already in ~/Library/Caches/ms-playwright; otherwise also run: python3 -m playwright install chromium')],
    () => showNotice('notice.macos-permissions', 'macOS may ask for permissions', [
      h('p', {}, 'The first time you run it, macOS may ask permission for "Electron" (this app) to:'),
      h('ul', {},
        h('li', {}, 'Find devices on local networks: choose Allow. Stage and dev servers sit on private VPN addresses, and without it participants may not be able to connect.'),
        h('li', {}, 'Use the microphone or camera: it uses a fake camera and mic and records nothing from your machine, so either answer is fine.')),
      h('p', {}, 'You can change them later in System Settings > Privacy & Security.')]));
  });
  tempKeys.addEventListener('change', syncVideo);
  queueMicrotask(syncVideo);
  const videoSection = h('div', { class: 'section' },
    h('h3', {}, 'Video'),
    h('label', { class: 'check' }, videoOn, 'Generate Video (rooms and recordings)'),
    videoNote,
    customize(
      h('div', { class: 'grid mt-12' },
        field('Empty rooms', videoText.rooms, 'Number or min-max range, 0 to skip. Re-rolled every run.'),
        field('Room name prefix', videoText.prefix, 'Rooms are named <prefix>-<stamp>-<n>.')),
      h('div', { class: 'mt-12' }, h('label', {}, 'Room types for empty rooms (none ticked = group only). Legacy types fail with error 53126 on accounts that started using Video after Oct 21 2024.'), videoTypeBoxes),
      h('label', { class: 'check mt-12' }, recOn, 'Rooms with participants and recordings'),
      h('div', { class: 'grid mt-12' },
        field('Recorded rooms', videoText.recRooms),
        field('Participants', videoText.participants, 'Spread over the recorded rooms. Each yields a video and an audio recording.'),
        field('Hold time (s)', videoText.hold, 'How long each participant stays connected.')),
      h('label', { class: 'check mt-12' }, tempKeys, 'Generate temporary API keys (created for the run, deleted after)'),
      keyFields));

  const form = h('div', { class: 'card mt-16' },
    h('div', { class: 'grid' },
      field('Name', text('f-name', p.name)),
      field('Environment', tier, 'The environment these credentials belong to. Never guessed.')),
    noCap,
    h('h3', {}, existing ? 'Credentials (stored in the macOS Keychain)' : 'Credentials (stored in the macOS Keychain)'),
    h('div', { class: 'grid' },
      sidField,
      field('Auth Token', tokenInput, existing && p.credentialsStored ? 'Leave blank to keep the stored one.' : 'The account type (parent or subaccount) is read from Twilio when you save.')),
    voiceSection,
    videoSection,
    errorBox);

  const collect = () => {
    const checked = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
    const val = (id) => $(id).value;
    return {
      profile: {
        ...(existing ? { id: existing.id } : {}),
        name: val('#f-name').trim(), tier: tier.value, categories: voiceOn.checked ? checked('categories') : [],
        calls: val('#f-calls').trim(), callDuration: val('#f-duration').trim(),
        recordingsTranscriptions: val('#f-rec').trim(), conferences: val('#f-conf').trim(),
        regions: checked('regions'), noProdCap: tier.value === 'prod' && $('#f-nocap').checked,
        videoEnabled: videoOn.checked,
        videoRooms: val('#f-video-rooms').trim(), videoRoomTypes: checked('videoRoomTypes'),
        videoPrefix: val('#f-video-prefix').trim(),
        videoRecordingsEnabled: recOn.checked, videoRecRooms: val('#f-video-recrooms').trim(),
        videoParticipants: val('#f-video-participants').trim(), videoHold: val('#f-video-hold').trim(),
        videoTempKeys: tempKeys.checked,
        ...(existing && existing.videoKeyHint ? { videoKeyHint: existing.videoKeyHint } : {}),
      },
      videoKey: tempKeys.checked ? null : { sid: val('#f-video-keysid').trim(), secret: val('#f-video-keysecret').trim() },
      credentials: { sid: val('#f-sid').trim(), token: val('#f-token').trim() },
    };
  };

  const save = async () => {
    errorBox.replaceChildren();
    try {
      const saved = await api.saveProfile(collect());
      delete sidCache[saved.id]; // SID may have changed
      await reload();
      selectProfile(saved.id);
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      errorBox.replaceChildren(...msg.split(/(?<=\.)\s+/).map((m) => h('li', {}, m)));
    }
  };

  return h('div', {},
    h('div', { class: 'row spread' }, h('h2', {}, existing ? `Edit ${existing.name}` : 'New profile'),
      h('div', { class: 'row' },
        h('button', { onClick: () => { state.view = selected() ? 'profile' : 'empty'; renderMain(); } }, 'Cancel'),
        h('button', { class: 'primary', onClick: save }, 'Save'))),
    form);
};

// --------------------------------------------------------- dialogs -------

const showDialog = (content) => {
  const d = $('#dialog');
  d.replaceChildren(...content.filter(Boolean));
  if (!d.open) d.showModal();
  return d;
};
const closeDialog = () => $('#dialog').close();

// An informational popup with a "Don't show this again" box (remembered per notice in localStorage).
// `then` runs once it closes, however it was closed, so notices can be chained one popup at a time.
const noticeHidden = (key) => {
  try { return localStorage.getItem(key) === 'hidden'; } catch (e) { return false; }
};
const showNotice = (key, title, body, then) => {
  if (noticeHidden(key)) { if (then) then(); return; }
  const dontShow = h('input', { type: 'checkbox', id: 'notice-dont-show' });
  const d = showDialog([h('h2', {}, title), ...body,
    h('label', { class: 'check mt-12' }, dontShow, "Don't show this again"),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'Got it'))]);
  d.addEventListener('close', () => {
    if (dontShow.checked) { try { localStorage.setItem(key, 'hidden'); } catch (e) { /* convenience only */ } }
    if (then) then();
  }, { once: true });
};

const checkAccount = async (p, btn) => {
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const { profile, status } = await api.describeProfile(p.id);
    await reload();
    const label = { main: 'Parent account', sub: 'Subaccount' }[profile.accountKind] || 'Account type unknown';
    showDialog([h('h2', {}, 'Account checked'),
      h('p', {}, `${label}${profile.accountName ? `: ${profile.accountName}` : ''}${status ? ` (${status})` : ''}.`),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'OK'))]);
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    btn.disabled = false;
    btn.textContent = 'Check account';
    showDialog([h('h2', {}, 'Could not check the account'), h('p', {}, msg),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'OK'))]);
  }
};

const duplicate = async (p, copyCredentials) => {
  closeDialog();
  try {
    const copy = await api.duplicateProfile({ id: p.id, copyCredentials });
    await reload();
    selectProfile(copy.id);
    // not copying means the new profile has none yet: go straight to entering them
    if (!copyCredentials) startEdit(state.profiles.find((x) => x.id === copy.id));
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    showDialog([h('h2', {}, 'Could not duplicate'), h('p', {}, msg),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'OK'))]);
  }
};

const confirmDuplicate = (p) => {
  showDialog([
    h('h2', {}, `Duplicate "${p.name}"`),
    p.credentialsStored
      ? h('p', {}, 'Copy authentication data?')
      : h('p', {}, 'This profile has no stored credentials, so the copy will need its own.'),
    h('div', { class: 'actions' },
      h('button', { onClick: closeDialog }, 'Cancel'),
      h('button', { class: p.credentialsStored ? '' : 'primary', onClick: () => duplicate(p, false) }, "Don't copy"),
      p.credentialsStored && h('button', { class: 'primary', onClick: () => duplicate(p, true) }, 'Copy')),
  ]);
};

// Run every profile that can run, in parallel. One dialog covers the whole click:
// it names each profile, and if any is prod, PROD must be typed (that is what
// passes --confirm-prod for those runs). Profiles without credentials are skipped.
const requestRunAll = () => {
  const targets = bulkTargets();
  const usingSelection = targets.some((p) => state.checked.has(p.id));
  const skipped = usingSelection ? [] : state.profiles.filter((p) => !p.credentialsStored);
  if (!targets.length) return;
  const prod = targets.filter((p) => p.tier === 'prod');

  const go = h('button', { class: 'primary', disabled: prod.length > 0, onClick: () => { closeDialog(); doRunAll(targets); } },
    `Run ${targets.length}`);
  const content = [
    h('h2', {}, `Run ${usingSelection ? 'the ' : ''}${targets.length} ${usingSelection ? 'selected ' : ''}profile${targets.length > 1 ? 's' : ''} at once?`),
    h('ul', { class: 'run-all-list' }, targets.map((p) => h('li', {}, p.name, h('span', { class: `badge ${p.tier} tag` }, p.tier)))),
    skipped.length ? h('p', { class: 'muted small' }, `Skipped (no credentials): ${skipped.map((p) => p.name).join(', ')}`) : null,
  ];
  let input = null;
  if (prod.length) {
    input = h('input', { type: 'text', id: 'prod-confirm', autocomplete: 'off', spellcheck: 'false', placeholder: 'PROD' });
    input.addEventListener('input', () => { go.disabled = input.value !== 'PROD'; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
    content.push(
      h('p', {}, `${prod.length} of these ${prod.length > 1 ? 'are' : 'is'} PRODUCTION: real calls, real numbers, real cost.`),
      h('label', { for: 'prod-confirm' }, 'Type PROD in capitals to continue'),
      input);
  }
  content.push(h('div', { class: 'actions' }, h('button', { onClick: closeDialog }, 'Cancel'), go));
  showDialog(content);
  if (input) input.focus();
};

const doRunAll = async (targets) => {
  const results = await Promise.allSettled(
    targets.map((p) => api.startRun({ profileId: p.id, confirmProd: p.tier === 'prod' })));
  await reload();
  const failed = results
    .map((res, i) => (res.status === 'rejected' ? `${targets[i].name}: ${String(res.reason.message || res.reason).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` : null))
    .filter(Boolean);
  if (failed.length) {
    showDialog([h('h2', {}, 'Some runs could not start'), h('ul', {}, failed.map((f) => h('li', {}, f))),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'OK'))]);
  }
};

const confirmDelete = (p) => {
  showDialog([
    h('h2', {}, `Delete "${p.name}"?`),
    h('p', { class: 'muted' }, 'This removes the profile and its stored credentials. Run history is kept.'),
    h('div', { class: 'actions' },
      h('button', { onClick: closeDialog }, 'Cancel'),
      h('button', { class: 'danger', onClick: async () => {
        await api.deleteProfile(p.id);
        closeDialog();
        state.selectedProfileId = null; state.view = 'empty';
        await reload();
      } }, 'Delete')),
  ]);
};

// Prod needs PROD typed on every run, mirroring gen/safety.confirm_prod. The
// check is repeated by wizard.py, which refuses to run prod without --confirm-prod.
const requestRun = (p) => {
  if (p.tier !== 'prod') return doRun(p, false);
  const input = h('input', { type: 'text', id: 'prod-confirm', autocomplete: 'off', spellcheck: 'false', placeholder: 'PROD' });
  const go = h('button', { class: 'primary', disabled: true, onClick: () => { closeDialog(); doRun(p, true); } }, 'Run on production');
  input.addEventListener('input', () => { go.disabled = input.value !== 'PROD'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  showDialog([
    h('h2', {}, `Run "${p.name}" on PRODUCTION?`),
    h('p', {}, 'Real calls, real numbers, real cost, real visibility.'),
    h('p', { class: 'muted small' }, p.noProdCap ? 'Prod caps are lifted for this profile.' : 'Capped at 30 per category and 5m per call.'),
    h('label', { for: 'prod-confirm' }, 'Type PROD in capitals to continue'),
    input,
    h('div', { class: 'actions' }, h('button', { onClick: closeDialog }, 'Cancel'), go),
  ]);
  input.focus();
};

const doRun = async (p, confirmProd) => {
  try {
    // stay on the profile page: the spinner shows it's running, and runs can be
    // started in parallel. Click a history row to follow the log.
    await api.startRun({ profileId: p.id, confirmProd });
    await reload(false);
    selectProfile(p.id);
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    showDialog([h('h2', {}, 'Could not start the run'), h('p', {}, msg),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: closeDialog }, 'OK'))]);
  }
};

// --------------------------------------------------------- navigation ----

const selectProfile = (id) => {
  state.selectedProfileId = id;
  state.view = 'profile';
  renderSidebar();
  renderMain();
};

const openRun = async (id) => {
  const { log } = await api.getRun(id);
  state.viewRunId = id;
  state.liveLog = log;
  state.view = 'run';
  renderMain();
};

const reload = async (rerender = true) => {
  [state.profiles, state.runs] = await Promise.all([api.listProfiles(), api.listRuns()]);
  state.checked = new Set([...state.checked].filter((id) => state.profiles.some((p) => p.id === id)));
  renderSidebar();
  if (rerender && state.view !== 'edit' && state.view !== 'run') renderMain();
};

api.onRunLog(({ runId, chunk }) => {
  if (state.view !== 'run' || state.viewRunId !== runId) return;
  state.liveLog += chunk;
  const log = $('#log');
  if (!log) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.textContent = state.liveLog;
  if (stick) log.scrollTop = log.scrollHeight;
});

api.onRunProgress((p) => {
  state.progress[p.runId] = p;
  paintProgress(p.runId);
  renderSidebar();
});

api.onRunUpdate(async (run) => {
  if (run.status !== 'running') delete state.progress[run.id];
  await reload(false);
  // refresh header/status of whichever view is showing, but never clobber an open edit form
  if (state.view === 'run' && state.viewRunId === run.id) {
    const log = $('#log');
    const scroll = log ? log.scrollTop : 0;
    renderMain();
    if ($('#log')) $('#log').scrollTop = scroll;
  } else if (state.view === 'profile') renderMain();
});

$('#new-profile').addEventListener('click', () => startEdit(null));
$('#run-all').addEventListener('click', requestRunAll);

(async () => {
  state.info = await api.info();
  state.checked = loadChecked();
  await reload();
  if (state.profiles.length) selectProfile(state.profiles[0].id);
})();
