/* global api */
const state = {
  info: null,
  profiles: [],
  runs: [],
  selectedProfileId: null,
  view: 'empty', // empty | profile | edit | run
  viewRunId: null,
  liveLog: '',
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

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtDuration = (run) => {
  if (!run.finishedAt) return '';
  const s = Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const tierBadge = (tier) => h('span', { class: `badge ${tier}` }, tier);
const specSummary = (p) => {
  const parts = [];
  if (p.categories.includes('calls')) parts.push(`calls ${p.calls}`);
  if (p.categories.includes('recordings_transcriptions')) parts.push(`rec ${p.recordingsTranscriptions}`);
  if (p.categories.includes('conferences')) parts.push(`conf ${p.conferences}`);
  return parts.join(' · ');
};

const selected = () => state.profiles.find((p) => p.id === state.selectedProfileId) || null;
const runningRuns = (profileId) => state.runs.filter((r) => r.status === 'running' && (!profileId || r.profileId === profileId));
const spinner = (title) => h('span', { class: 'spinner', role: 'status', 'aria-label': title || 'Running', title: title || 'Running' });
// Progress bar + label for one run. Painted in place from `paintProgress`, so a
// log line arriving never re-renders a whole view.
const progressLabel = (p) => (p ? `${p.estimated ? '≈' : ''}${p.percent}%` : '');
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
};
const canRun = () => Boolean(state.info && state.info.pythonPath);

// ------------------------------------------------------------ sidebar ----

const sidebarSpinner = (p) => {
  const n = runningRuns(p.id).length;
  if (n === 0) return null;
  const single = n === 1 ? progressLabel(state.progress[runningRuns(p.id)[0].id]) : null;
  return h('span', { class: 'running-tag' }, spinner(`${n} running`), n > 1 ? String(n) : single);
};

const renderSidebar = () => {
  const list = $('#profile-list');
  list.replaceChildren(
    ...state.profiles.map((p) =>
      h('li', { class: p.id === state.selectedProfileId ? 'selected' : '', onClick: () => selectProfile(p.id) },
        h('div', { class: 'info' },
          h('div', { class: 'name' }, p.name),
          h('div', { class: 'muted small' }, specSummary(p))),
        sidebarSpinner(p),
        p.credentialsStored ? null : h('span', { class: 'badge warn', title: 'Credentials missing from the Keychain' }, 'no creds'),
        tierBadge(p.tier),
        h('button', {
          class: 'primary small', title: p.credentialsStored ? 'Run this profile' : 'Re-enter credentials first',
          disabled: !canRun() || !p.credentialsStored,
          onClick: (e) => { e.stopPropagation(); requestRun(p); },
        }, 'Run'))));
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

const profileView = (p) => {
  const runs = state.runs.filter((r) => r.profileId === p.id);
  const stats = [
    ['Environment', tierBadge(p.tier)],
    ['Account', h('span', { class: 'mono' }, `AC…${p.sidHint || '????'}`)],
    ['Calls', p.categories.includes('calls') ? `${p.calls}  (duration ${p.callDuration})` : 'off'],
    ['Recordings / transcriptions', p.categories.includes('recordings_transcriptions') ? p.recordingsTranscriptions : 'off'],
    ['Conferences', p.categories.includes('conferences')
      ? `${p.conferences}${p.regions && p.regions.length ? `  (${p.regions.join(', ')})` : ''}` : 'off'],
  ];
  if (p.tier === 'prod') stats.push(['Prod caps', p.noProdCap ? 'lifted (--no-prod-cap)' : '30 per category, 5m per call']);

  return h('div', {},
    h('div', { class: 'row spread' },
      h('div', { class: 'row' }, h('h2', {}, p.name), tierBadge(p.tier), runningRuns(p.id).length > 0 && h('span', { class: 'running-tag' }, spinner(), `${runningRuns(p.id).length} running`)),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !canRun() || !p.credentialsStored, onClick: () => requestRun(p) }, 'Run now'),
        h('button', { onClick: () => startEdit(p) }, 'Edit'),
        h('button', { onClick: () => confirmDuplicate(p) }, 'Duplicate'),
        h('button', { class: 'danger', onClick: () => confirmDelete(p) }, 'Delete'))),
    p.credentialsStored ? null : h('div', { class: 'callout mt-14' },
      'The Account SID and Auth Token for this profile are not in the Keychain, so it cannot run. ',
      h('a', { href: '#', onClick: (e) => { e.preventDefault(); startEdit(p); } }, 'Edit the profile and enter them again.')),
    h('div', { class: 'card mt-16' },
      h('div', { class: 'grid' }, stats.map(([k, v]) => h('div', {}, h('div', { class: 'muted small' }, k), h('div', {}, v))))),
    h('p', { class: 'muted small' }, 'Ranges like 10-30 are re-rolled fresh on every run, never frozen.'),
    h('h3', {}, 'Run history'),
    runs.length === 0 ? h('p', { class: 'muted' }, 'No runs yet.') : runsTable(runs));
};

const runsTable = (runs) =>
  h('div', { class: 'card tight' },
    h('table', {},
      h('thead', {}, h('tr', {}, ['Started', 'Status', 'Duration', 'Calls', 'Rec.', 'Conf.', 'Errors'].map((t) => h('th', {}, t)))),
      h('tbody', {}, runs.map((r) => {
        const s = r.summary;
        return h('tr', { onClick: () => openRun(r.id) },
          h('td', {}, fmtTime(r.startedAt)),
          h('td', { class: `status-${r.status}` }, r.status === 'running' ? h('span', { class: 'row gap-6' }, spinner(), progressEl(r.id)) : r.status),
          h('td', {}, fmtDuration(r)),
          h('td', {}, s ? String(s.calls) : '–'),
          h('td', {}, s ? String(s.recordings) : '–'),
          h('td', {}, s ? String(s.conferences) : '–'),
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
        run && h('span', { class: `status-${run.status}` }, live ? h('span', { class: 'row gap-6' }, spinner(), 'running') : run.status)),
      
      h('div', { class: 'row' },
        live && h('button', { class: 'danger', onClick: () => api.stopRun(run.id) }, 'Stop'),
        h('button', { onClick: () => { state.view = selected() ? 'profile' : 'empty'; renderMain(); } }, 'Back'))),
    live && h('div', { class: 'progress-block' }, progressEl(run.id, { detail: true })),
    run && h('p', { class: 'muted small' },
      `Started ${fmtTime(run.startedAt)}${run.finishedAt ? ` · took ${fmtDuration(run)}` : ''}`),
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
  };
  const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint && h('div', { class: 'hint' }, hint));
  const text = (id, value, type = 'text') => h('input', { type, id, value: value ?? '', autocomplete: 'off', spellcheck: 'false' });

  const tier = h('select', { id: 'f-tier' }, state.info.TIERS.map((t) => h('option', { value: t, selected: t === p.tier }, t)));
  const checks = (name, all, chosen, labels = {}) =>
    h('div', { class: 'row' }, all.map((v) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: v, checked: chosen.includes(v) }), labels[v] || v)));

  const errorBox = h('ul', { class: 'errors', id: 'form-errors' });
  const noCap = h('div', { id: 'nocap-wrap' },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'f-nocap', checked: Boolean(p.noProdCap) }),
      'Lift the prod caps (30 per category, 5m per call)'),
    h('div', { class: 'hint' }, 'Only lifts the caps. Every prod run still needs you to type PROD.'));
  const syncNoCap = () => { noCap.style.display = tier.value === 'prod' ? '' : 'none'; };
  tier.addEventListener('change', syncNoCap);
  queueMicrotask(syncNoCap);

  const form = h('div', { class: 'card mt-16' },
    h('div', { class: 'grid' },
      field('Name', text('f-name', p.name)),
      field('Environment', tier, 'The environment these credentials belong to. Never guessed.')),
    noCap,
    h('h3', {}, existing ? 'Credentials (stored in the macOS Keychain)' : 'Credentials (stored in the macOS Keychain)'),
    h('div', { class: 'grid' },
      field('Account SID', text('f-sid', ''), existing && p.credentialsStored ? `Currently AC…${p.sidHint}. Leave both blank to keep.` : 'AC followed by 32 hex characters.'),
      field('Auth Token', text('f-token', '', 'password'), existing && p.credentialsStored ? 'Leave blank to keep the stored one.' : undefined)),
    h('h3', {}, 'Plan'),
    checks('categories', state.info.CATEGORIES, p.categories, { recordings_transcriptions: 'recordings/transcriptions' }),
    h('div', { class: 'grid mt-12' },
      field('Calls', text('f-calls', p.calls), 'Number, min-max range, or 0.'),
      field('Call duration', text('f-duration', p.callDuration), 'Range like 1s-3m. Applies to completed calls.'),
      field('Recordings / transcriptions', text('f-rec', p.recordingsTranscriptions)),
      field('Conferences', text('f-conf', p.conferences))),
    h('div', { class: 'mt-12' }, h('label', {}, 'Conference regions (optional)'),
      checks('regions', state.info.REGIONS, p.regions || [])),
    errorBox);

  const collect = () => {
    const checked = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
    const val = (id) => $(id).value;
    return {
      profile: {
        ...(existing ? { id: existing.id } : {}),
        name: val('#f-name').trim(), tier: tier.value, categories: checked('categories'),
        calls: val('#f-calls').trim(), callDuration: val('#f-duration').trim(),
        recordingsTranscriptions: val('#f-rec').trim(), conferences: val('#f-conf').trim(),
        regions: checked('regions'), noProdCap: tier.value === 'prod' && $('#f-nocap').checked,
      },
      credentials: { sid: val('#f-sid').trim(), token: val('#f-token').trim() },
    };
  };

  const save = async () => {
    errorBox.replaceChildren();
    try {
      const saved = await api.saveProfile(collect());
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
  d.replaceChildren(...content);
  if (!d.open) d.showModal();
  return d;
};
const closeDialog = () => $('#dialog').close();

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
      ? h('p', {}, `Copy its Account SID and Auth Token (AC…${p.sidHint}) to the new profile, or enter different ones?`)
      : h('p', {}, 'This profile has no stored credentials, so the copy will need its own.'),
    h('div', { class: 'actions' },
      h('button', { onClick: closeDialog }, 'Cancel'),
      h('button', { class: p.credentialsStored ? '' : 'primary', onClick: () => duplicate(p, false) }, 'Enter different credentials'),
      p.credentialsStored && h('button', { class: 'primary', onClick: () => duplicate(p, true) }, 'Copy credentials')),
  ]);
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

(async () => {
  state.info = await api.info();
  await reload();
  if (state.profiles.length) selectProfile(state.profiles[0].id);
})();
