const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWizardArgs, quickProfile, QUICK_TESTS, validateProfile, validateCredentials, consoleUrl, VIDEO_AUDIO_ONLY, envNames, DEFAULTS } = require('../lib/args');

const base = () => ({
  name: 'Daily stage', tier: 'stage', categories: ['calls', 'recordings_transcriptions', 'conferences'],
  calls: DEFAULTS.calls, callDuration: DEFAULTS.callDuration,
  recordingsTranscriptions: DEFAULTS.recordingsTranscriptions, conferences: DEFAULTS.conferences,
  regions: ['us1', 'au1'], noProdCap: false,
});
const opts = { wizardPath: '/x/wizard.py', resultsPath: '/x/r.json' };

test('stage profile maps onto unattended wizard flags, specs untouched', () => {
  const args = buildWizardArgs(base(), opts);
  assert.deepEqual(args.slice(0, 4), ['-u', '/x/wizard.py', '--sid-env', 'VOICEGEN_SID_STAGE']);
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--calls'), '10-30');
  assert.equal(at('--call-duration'), '1s-3m');
  assert.equal(at('--regions'), 'us1,au1');
  assert.equal(at('--mode'), 'run');
  assert.equal(at('--results-path'), '/x/r.json');
  assert.ok(!args.includes('--confirm-prod'));
  assert.ok(!args.includes('--allow-purchase'));
});

test('prod refuses to build without per-run confirmation', () => {
  const p = { ...base(), tier: 'prod' };
  assert.throws(() => buildWizardArgs(p, opts), /confirmation/);
  assert.ok(buildWizardArgs(p, { ...opts, confirmProd: true }).includes('--confirm-prod'));
});

test('--no-prod-cap is only added on prod, and never implies --confirm-prod', () => {
  const stage = buildWizardArgs({ ...base(), noProdCap: true }, opts);
  assert.ok(!stage.includes('--no-prod-cap'));
  const prod = { ...base(), tier: 'prod', noProdCap: true };
  assert.throws(() => buildWizardArgs(prod, opts));
  const args = buildWizardArgs(prod, { ...opts, confirmProd: true });
  assert.ok(args.includes('--no-prod-cap') && args.includes('--confirm-prod'));
  assert.ok(!buildWizardArgs({ ...prod, noProdCap: false }, { ...opts, confirmProd: true }).includes('--no-prod-cap'));
});

test('credentials never appear in argv', () => {
  const args = buildWizardArgs(base(), opts).join(' ');
  assert.ok(!/AC[0-9a-f]{32}/i.test(args));
  assert.deepEqual(envNames('dev'), { sidEnv: 'VOICEGEN_SID_DEV', tokenEnv: 'VOICEGEN_TOKEN_DEV', videoKeyEnv: 'VOICEGEN_VKEY_DEV', videoSecretEnv: 'VOICEGEN_VSECRET_DEV' });
});

test('validation catches what would crash or misbehave in core.py', () => {
  assert.ok(validateProfile({ ...base(), categories: [] }).length);       // empty --categories means "all" in wizard.py
  assert.ok(validateProfile({ ...base(), calls: '30-10' }).length);       // randint(lo>hi) raises
  assert.ok(validateProfile({ ...base(), calls: 'abc' }).length);
  assert.ok(validateProfile({ ...base(), callDuration: '30s' }).length);  // single value crashes parse_duration_range_spec
  assert.equal(validateProfile({ ...base(), callDuration: '0' }).length, 0);
  assert.equal(validateProfile({ ...base(), callDuration: '10-60' }).length, 0);
  assert.equal(validateProfile({ ...base(), calls: '0' }).length, 0);
  // specs of unselected categories are ignored
  assert.equal(validateProfile({ ...base(), categories: ['conferences'], calls: 'junk' }).length, 0);
  assert.ok(validateProfile({ ...base(), regions: ['mars1'] }).length);
});

test('credential validation', () => {
  assert.equal(validateCredentials({ sid: 'AC' + 'a'.repeat(32), token: 't' }).length, 0);
  assert.ok(validateCredentials({ sid: 'nope', token: 't' }).length);
  assert.ok(validateCredentials({ sid: 'AC' + 'a'.repeat(32), token: '' }).length);
});

const videoFields = () => Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => k.startsWith('video')));

test('video-only profile builds a wizard command with only video_rooms', () => {
  const p = { ...base(), categories: [], videoEnabled: true, ...videoFields(), videoRoomTypes: ['group', 'peer-to-peer'] };
  assert.deepEqual(validateProfile(p), []);
  const args = buildWizardArgs(p, opts);
  assert.equal(args[args.indexOf('--categories') + 1], 'video_rooms');
  assert.equal(args[args.indexOf('--video-rooms') + 1], '5-10');
  assert.equal(args[args.indexOf('--video-room-prefix') + 1], 'telefono');
  assert.equal(args[args.indexOf('--video-room-types') + 1], 'group,peer-to-peer');
});

test('a profile needs Voice categories or Video', () => {
  assert.match(validateProfile({ ...base(), categories: [] }).join(' '), /Enable Voice/);
});

test('video settings are validated only when enabled', () => {
  const bad = { ...base(), videoEnabled: true, videoRooms: 'x', videoRoomTypes: ['nope'], videoPrefix: 'a b' };
  const msgs = validateProfile(bad).join(' ');
  assert.match(msgs, /Video rooms/);
  assert.match(msgs, /room type/);
  assert.match(msgs, /prefix/);
  assert.deepEqual(validateProfile({ ...bad, videoEnabled: false }), []);
  assert.deepEqual(validateProfile({ ...base(), tier: 'prod', videoEnabled: true, ...videoFields() }), []); // prod is allowed (PROD confirmation + caps apply)
});

test('video flags are omitted when video is off; room types omitted when none picked', () => {
  assert.ok(!buildWizardArgs(base(), opts).some((a) => /video/i.test(a)));
  const args = buildWizardArgs({ ...base(), videoEnabled: true, ...videoFields(), videoRoomTypes: [] }, opts);
  assert.ok(!args.includes('--video-room-types'));
  assert.match(args[args.indexOf('--categories') + 1], /conferences,video_rooms$/);
});

test('video recordings: flags, categories and API key env names (never values)', () => {
  const p = { ...base(), categories: [], videoEnabled: true, ...videoFields(), videoRecordingsEnabled: true, videoTempKeys: false };
  assert.deepEqual(validateProfile(p), []);
  const args = buildWizardArgs(p, opts);
  assert.equal(args[args.indexOf('--categories') + 1], 'video_rooms,video_recordings');
  assert.equal(args[args.indexOf('--video-recordings') + 1], '2-6');
  assert.equal(args[args.indexOf('--video-rec-rooms') + 1], '2-3');
  assert.equal(args[args.indexOf('--video-hold') + 1], '5-15');
  assert.equal(args[args.indexOf('--video-key-env') + 1], 'VOICEGEN_VKEY_STAGE');
  assert.equal(args[args.indexOf('--video-secret-env') + 1], 'VOICEGEN_VSECRET_STAGE');
  const temp = buildWizardArgs({ ...p, videoTempKeys: true }, opts);
  assert.ok(!temp.includes('--video-key-env'));
  const recOnly = buildWizardArgs({ ...p, videoRooms: '0', videoTempKeys: true }, opts);
  assert.equal(recOnly[recOnly.indexOf('--categories') + 1], 'video_recordings');
});

test('video recordings are validated', () => {
  const bad = { ...base(), videoEnabled: true, ...videoFields(), videoRecordingsEnabled: true, videoParticipants: '0', videoRecRooms: 'x', videoHold: 'abc' };
  const msgs = validateProfile(bad).join(' ');
  assert.match(msgs, /participants/);
  assert.match(msgs, /recorded rooms/);
  assert.match(msgs, /hold time/);
  assert.match(validateProfile({ ...base(), videoEnabled: true, ...videoFields(), videoRooms: '0' }).join(' '), /rooms above 0 or enable recordings/);
});

test('video compositions: --video-compose only when recordings and compose are both on', () => {
  const p = { ...base(), categories: [], videoEnabled: true, ...videoFields(), videoRecordingsEnabled: true, videoTempKeys: true };
  assert.ok(!buildWizardArgs(p, opts).includes('--video-compose'));
  assert.ok(buildWizardArgs({ ...p, videoComposeEnabled: true }, opts).includes('--video-compose'));
  assert.ok(!buildWizardArgs({ ...p, videoRecordingsEnabled: false, videoComposeEnabled: true }, opts).includes('--video-compose'));
});

test('quick tests: one item of one kind, every kind valid, stored profile untouched', () => {
  const p = { ...base(), videoEnabled: true, videoRooms: '5-10', videoRoomTypes: ['group', 'peer-to-peer'], videoPrefix: 'telefono',
    videoRecordingsEnabled: true, videoRecRooms: '2-3', videoParticipants: '2-6', videoHold: '5-15', videoTempKeys: true };
  const before = JSON.stringify(p);
  for (const kind of Object.keys(QUICK_TESTS)) {
    const q = quickProfile(p, kind);
    assert.deepEqual(validateProfile(q), [], kind);
    buildWizardArgs(q, opts); // does not throw
  }
  assert.equal(JSON.stringify(p), before);

  const at = (args, flag) => args[args.indexOf(flag) + 1];
  const call = buildWizardArgs(quickProfile(p, 'call'), opts);
  assert.equal(at(call, '--categories'), 'calls');
  assert.equal(at(call, '--calls'), '1');
  assert.equal(at(call, '--call-mix'), 'completed');
  assert.ok(!buildWizardArgs(p, opts).includes('--call-mix'));

  const room = buildWizardArgs(quickProfile(p, 'video_room'), opts);
  assert.equal(at(room, '--categories'), 'video_rooms');
  assert.equal(at(room, '--video-rooms'), '1');
  assert.ok(!room.includes('--video-room-types')); // group only

  const rec = buildWizardArgs(quickProfile(p, 'video_recording'), opts);
  assert.equal(at(rec, '--categories'), 'video_recordings');
  assert.equal(at(rec, '--video-recordings'), '1');
  assert.equal(at(rec, '--video-rec-rooms'), '1');
  assert.ok(!rec.includes('--video-compose'));
  assert.ok(buildWizardArgs(quickProfile(p, 'video_composition'), opts).includes('--video-compose'));
  assert.throws(() => quickProfile(p, 'nope'), /Unknown quick test/);
});

test('quick tests on prod still need the per-run confirmation', () => {
  const q = quickProfile({ ...base(), tier: 'prod' }, 'call');
  assert.throws(() => buildWizardArgs(q, opts), /confirmation/);
  assert.ok(buildWizardArgs(q, { ...opts, confirmProd: true }).includes('--confirm-prod'));
});

test('console link points at the account page for the right environment', () => {
  const sid = 'AC' + 'a'.repeat(32);
  assert.equal(consoleUrl('prod', sid), `https://console.twilio.com/account/${sid}`);
  assert.equal(consoleUrl('stage', sid), `https://console.stage.twilio.com/account/${sid}`);
  assert.equal(consoleUrl('prod', 'nope'), 'https://console.twilio.com/'); // unreadable/odd SID: console home, never a malformed path
  assert.equal(consoleUrl('prod', undefined), 'https://console.twilio.com/');
  assert.equal(consoleUrl('mars', sid), undefined);
});

test('AudioOnly flag for empty rooms: sent only when not automatic, validated', () => {
  const p = { ...base(), categories: [], videoEnabled: true, ...videoFields(), videoRoomTypes: ['peer-to-peer'] };
  assert.ok(!buildWizardArgs(p, opts).includes('--video-audio-only'));
  assert.ok(!buildWizardArgs({ ...p, videoAudioOnly: 'auto' }, opts).includes('--video-audio-only'));
  for (const mode of Object.keys(VIDEO_AUDIO_ONLY).filter((m) => m !== 'auto')) {
    const args = buildWizardArgs({ ...p, videoAudioOnly: mode }, opts);
    assert.equal(args[args.indexOf('--video-audio-only') + 1], mode);
    assert.deepEqual(validateProfile({ ...p, videoAudioOnly: mode }), []);
  }
  assert.match(validateProfile({ ...p, videoAudioOnly: 'maybe' }).join(' '), /AudioOnly/);
});
