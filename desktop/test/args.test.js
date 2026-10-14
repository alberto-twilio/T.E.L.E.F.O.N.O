const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWizardArgs, validateProfile, validateCredentials, envNames, DEFAULTS } = require('../lib/args');

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
  assert.deepEqual(envNames('dev'), { sidEnv: 'VOICEGEN_SID_DEV', tokenEnv: 'VOICEGEN_TOKEN_DEV' });
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
