// Pure helpers: validate a profile and turn it into wizard.py's unattended
// CLI. No Electron imports, so it is unit-testable with plain node.
//
// Everything here maps onto flags wizard.py already has. The desktop app has
// no second implementation of "how to generate data" or "what is allowed on
// prod": wizard.py (-> gen/safety.py) remains the only place that enforces it.

const TIERS = ['prod', 'stage', 'dev'];
const CATEGORIES = ['calls', 'recordings_transcriptions', 'conferences'];
// Console host per environment. Only these fixed URLs are ever opened (the
// renderer sends a profile id, never a URL). Stage/dev hosts are assumed to
// mirror the API hosts (api.stage.twilio.com -> console.stage.twilio.com).
const CONSOLE_URLS = {
  prod: 'https://console.twilio.com/',
  stage: 'https://console.stage.twilio.com/',
  dev: 'https://console.dev.twilio.com/',
};
const REGIONS = ['us1', 'us2', 'au1', 'br1', 'ie1', 'jp1', 'sg1', 'de1', 'in1'];

const DEFAULTS = {
  calls: '10-30',
  callDuration: '1s-3m',
  recordingsTranscriptions: '5-10',
  conferences: '5-10',
  // Video: empty rooms (REST) and recorded rooms with participants (headless browser)
  videoRooms: '5-10',
  videoRecRooms: '2-3',
  videoParticipants: '2-6',
  videoHold: '5-15',
  videoPrefix: 'telefono',
};
const VIDEO_ROOM_TYPES = ['group', 'group-small', 'peer-to-peer'];

const SID_RE = /^AC[0-9a-f]{32}$/i;
const COUNT_RE = /^(\d+)(?:-(\d+))?$/;
const DURATION_TOKEN = '\\d+(?:\\.\\d+)?[sm]?';
const DURATION_RE = new RegExp(`^(${DURATION_TOKEN})-(${DURATION_TOKEN})$`);

const validateCount = (label, spec) => {
  const m = COUNT_RE.exec(String(spec).trim());
  if (!m) return `${label}: use a number, a "min-max" range, or 0 to skip.`;
  if (m[2] !== undefined && Number(m[1]) > Number(m[2])) return `${label}: min is greater than max.`;
  return null;
};

const validateDuration = (spec) => {
  const s = String(spec).trim();
  if (s === '0') return null;
  // core.parse_duration_range_spec requires a range ("1s-3m"), a single value crashes it.
  if (!DURATION_RE.test(s)) return 'Call duration: use a range like 1s-3m or 30-90, or 0 to disable.';
  return null;
};

const PREFIX_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HOLD_RE = /^\d+[sm]?-\d+[sm]?$/;
const positive = (spec) => Number(String(spec).trim().split('-').pop()) >= 1;
const validateVideo = (p) => {
  const errors = [];
  const roomsErr = validateCount('Video rooms', p.videoRooms);
  if (roomsErr) errors.push(roomsErr);
  if (!roomsErr && !positive(p.videoRooms) && !p.videoRecordingsEnabled) errors.push('Video: set rooms above 0 or enable recordings.');
  if ((p.videoRoomTypes || []).some((t) => !VIDEO_ROOM_TYPES.includes(t))) errors.push('Unknown video room type.');
  if (!PREFIX_RE.test(String(p.videoPrefix).trim())) errors.push('Video room prefix: letters, digits, - and _ only (max 40).');
  if (p.videoRecordingsEnabled) {
    for (const [label, spec] of [['Video participants', p.videoParticipants], ['Video recorded rooms', p.videoRecRooms]]) {
      const err = validateCount(label, spec);
      if (err) errors.push(err);
      else if (!positive(spec)) errors.push(`${label}: must be at least 1.`);
    }
    if (!HOLD_RE.test(String(p.videoHold).trim())) errors.push('Video hold time: use a range like 5-15 (seconds).');
  }
  return errors;
};

// Returns an array of human-readable problems, empty when the profile is runnable.
const validateProfile = (p) => {
  const errors = [];
  if (!p.name || !p.name.trim()) errors.push('Name is required.');
  if (!TIERS.includes(p.tier)) errors.push('Pick an environment (prod, stage or dev).');
  const cats = p.categories || [];
  if (cats.length === 0 && !p.videoEnabled) errors.push('Enable Voice (with at least one category) or Video.');
  if (cats.some((c) => !CATEGORIES.includes(c))) errors.push('Unknown category.');

  const checks = [
    ['calls', 'Calls', () => validateCount('Calls', p.calls)],
    ['calls', 'Call duration', () => validateDuration(p.callDuration)],
    ['recordings_transcriptions', 'Recordings', () => validateCount('Recordings/transcriptions', p.recordingsTranscriptions)],
    ['conferences', 'Conferences', () => validateCount('Conferences', p.conferences)],
  ];
  for (const [cat, , check] of checks) {
    if (!cats.includes(cat)) continue;
    const err = check();
    if (err) errors.push(err);
  }
  if ((p.regions || []).some((r) => !REGIONS.includes(r))) errors.push('Unknown conference region.');
  if (p.videoEnabled) errors.push(...validateVideo(p));
  return errors;
};

const validateCredentials = ({ sid, token }) => {
  const errors = [];
  if (!SID_RE.test((sid || '').trim())) errors.push('Account SID must look like AC followed by 32 hex characters.');
  if (!(token || '').trim()) errors.push('Auth Token is required.');
  return errors;
};

const envNames = (tier) => ({
  sidEnv: `VOICEGEN_SID_${tier.toUpperCase()}`,
  tokenEnv: `VOICEGEN_TOKEN_${tier.toUpperCase()}`,
  videoKeyEnv: `VOICEGEN_VKEY_${tier.toUpperCase()}`,
  videoSecretEnv: `VOICEGEN_VSECRET_${tier.toUpperCase()}`,
});

// whether a run of this profile needs a stored API key (recordings with temporary keys turned off)
const needsVideoKey = (p) => Boolean(p.videoEnabled && p.videoRecordingsEnabled && p.videoTempKeys === false);

// the --categories list for a profile: Voice ones plus whichever Video parts are on
const categoriesFor = (p) => [
  ...p.categories,
  ...(p.videoEnabled && positive(p.videoRooms) ? ['video_rooms'] : []),
  ...(p.videoEnabled && p.videoRecordingsEnabled ? ['video_recordings'] : []),
];

// Quick tests: one item of one kind, run through the normal path (same prod confirmation, caps and
// credentials). The stored profile is untouched; only this run's copy is overridden.
const QUICK_TESTS = {
  call: 'Call',
  recording: 'Recording + transcription',
  conference: 'Conference',
  video_room: 'Video room',
  video_recording: 'Video recording',
  video_composition: 'Video recording + composition',
};
const VOICE_OFF = { categories: [], calls: '0', recordingsTranscriptions: '0', conferences: '0' };
const VIDEO_OFF = { videoEnabled: false, videoRecordingsEnabled: false, videoComposeEnabled: false };
const quickProfile = (profile, kind) => {
  const base = { ...profile, ...VOICE_OFF, ...VIDEO_OFF, quickTest: kind };
  switch (kind) {
    case 'call': return { ...base, categories: ['calls'], calls: '1', callDuration: '10-20', callMix: 'completed' };
    case 'recording': return { ...base, categories: ['recordings_transcriptions'], recordingsTranscriptions: '1' };
    case 'conference': return { ...base, categories: ['conferences'], conferences: '1' };
    case 'video_room': return { ...base, videoEnabled: true, videoRooms: '1', videoRoomTypes: [] };
    case 'video_recording': case 'video_composition':
      return { ...base, videoEnabled: true, videoRooms: '0', videoRoomTypes: [], videoRecordingsEnabled: true,
        videoRecRooms: '1', videoParticipants: '1', videoHold: '5-8', videoComposeEnabled: kind === 'video_composition' };
    default: throw new Error('Unknown quick test.');
  }
};

// opts: { wizardPath, resultsPath, confirmProd }
// Credential VALUES are never part of argv, only the names of the env vars the
// runner will set on the child process.
const buildWizardArgs = (profile, { wizardPath, resultsPath, confirmProd = false }) => {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(errors.join(' '));

  const { sidEnv, tokenEnv, videoKeyEnv, videoSecretEnv } = envNames(profile.tier);
  const args = [
    '-u', wizardPath,
    '--sid-env', sidEnv,
    '--token-env', tokenEnv,
    '--tier', profile.tier,
    '--categories', categoriesFor(profile).join(','),
    '--calls', String(profile.calls).trim(),
    '--call-duration', String(profile.callDuration).trim(),
    ...(profile.callMix === 'completed' ? ['--call-mix', 'completed'] : []),
    '--recordings-transcriptions', String(profile.recordingsTranscriptions).trim(),
    '--conferences', String(profile.conferences).trim(),
    '--mode', 'run',
    '--results-path', resultsPath,
  ];
  if (profile.regions && profile.regions.length) args.push('--regions', profile.regions.join(','));
  if (profile.videoEnabled) {
    args.push('--video-rooms', String(profile.videoRooms).trim(), '--video-room-prefix', String(profile.videoPrefix).trim());
    if (profile.videoRoomTypes && profile.videoRoomTypes.length) args.push('--video-room-types', profile.videoRoomTypes.join(','));
    if (profile.videoRecordingsEnabled) {
      args.push('--video-recordings', String(profile.videoParticipants).trim(), '--video-rec-rooms', String(profile.videoRecRooms).trim(),
        '--video-hold', String(profile.videoHold).trim());
      if (profile.videoComposeEnabled) args.push('--video-compose');
      // API key values reach the child only as env vars named here, same as the account credentials
      if (needsVideoKey(profile)) args.push('--video-key-env', videoKeyEnv, '--video-secret-env', videoSecretEnv);
    }
  }

  if (profile.tier === 'prod') {
    // --confirm-prod only ever comes from a per-run confirmation the caller
    // collected (the UI makes the user type PROD). It is never inferred from
    // a stored profile. --no-prod-cap is a stored, explicit per-profile choice
    // and never implies --confirm-prod.
    if (!confirmProd) throw new Error('Production runs need an explicit confirmation each time.');
    args.push('--confirm-prod');
    if (profile.noProdCap) args.push('--no-prod-cap');
  }
  return args;
};

module.exports = {
  TIERS, CATEGORIES, REGIONS, CONSOLE_URLS, VIDEO_ROOM_TYPES, DEFAULTS,
  QUICK_TESTS, quickProfile, validateProfile, validateCredentials, envNames, needsVideoKey, categoriesFor, buildWizardArgs,
};
