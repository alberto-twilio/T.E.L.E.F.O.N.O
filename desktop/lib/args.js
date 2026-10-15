// Pure helpers: validate a profile and turn it into wizard.py's unattended
// CLI. No Electron imports, so it is unit-testable with plain node.
//
// Everything here maps onto flags wizard.py already has. The desktop app has
// no second implementation of "how to generate data" or "what is allowed on
// prod": wizard.py (-> gen/safety.py) remains the only place that enforces it.

const TIERS = ['prod', 'stage', 'dev'];
const CATEGORIES = ['calls', 'recordings_transcriptions', 'conferences'];
const REGIONS = ['us1', 'us2', 'au1', 'br1', 'ie1', 'jp1', 'sg1', 'de1', 'in1'];

const DEFAULTS = {
  calls: '10-30',
  callDuration: '1s-3m',
  recordingsTranscriptions: '5-10',
  conferences: '5-10',
  // Video (rooms + recordings). Stored on the profile; not part of a run yet.
  videoParticipants: '10',
  videoRooms: '3',
  videoHold: '5-35',
  videoPrefix: 'rec-test',
};

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

const HOLD_RE = /^(\d+)-(\d+)$/;
const PREFIX_RE = /^[A-Za-z0-9_-]{1,40}$/;
const validateVideo = (p) => {
  const errors = [];
  if (p.tier === 'prod') errors.push('Video is not available on prod.');
  for (const [label, spec] of [['Video participants', p.videoParticipants], ['Video rooms', p.videoRooms]]) {
    const err = validateCount(label, spec);
    if (err) errors.push(err);
    else if (Number(String(spec).trim().split('-').pop()) < 1) errors.push(`${label}: must be at least 1.`);
  }
  const hold = HOLD_RE.exec(String(p.videoHold).trim());
  if (!hold || Number(hold[1]) < 1 || Number(hold[1]) > Number(hold[2])) errors.push('Video hold time: use a range of seconds like 5-35.');
  if (!PREFIX_RE.test(String(p.videoPrefix).trim())) errors.push('Video room prefix: letters, digits, - and _ only (max 40).');
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
});

// opts: { wizardPath, resultsPath, confirmProd }
// Credential VALUES are never part of argv, only the names of the env vars the
// runner will set on the child process.
const buildWizardArgs = (profile, { wizardPath, resultsPath, confirmProd = false }) => {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(errors.join(' '));
  // Video is stored on the profile but nothing runs it yet; a profile with no Voice categories has nothing to spawn.
  if (profile.categories.length === 0) throw new Error('This profile only has Video enabled, and Video runs are not available yet.');

  const { sidEnv, tokenEnv } = envNames(profile.tier);
  const args = [
    '-u', wizardPath,
    '--sid-env', sidEnv,
    '--token-env', tokenEnv,
    '--tier', profile.tier,
    '--categories', profile.categories.join(','),
    '--calls', String(profile.calls).trim(),
    '--call-duration', String(profile.callDuration).trim(),
    '--recordings-transcriptions', String(profile.recordingsTranscriptions).trim(),
    '--conferences', String(profile.conferences).trim(),
    '--mode', 'run',
    '--results-path', resultsPath,
  ];
  if (profile.regions && profile.regions.length) args.push('--regions', profile.regions.join(','));

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
  TIERS, CATEGORIES, REGIONS, DEFAULTS,
  validateProfile, validateCredentials, envNames, buildWizardArgs,
};
