const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeAccount } = require('../lib/describe');

// Stand-in for `python3 -u wizard.py ... --describe-account`.
const fake = (t, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtdg-desc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fakepython.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};
const creds = { sid: 'AC' + 'a'.repeat(32), token: 'secret-token' };

test('parses kind, status and name; passes credentials only via env, with --describe-account', async (t) => {
  const py = fake(t, `echo "[$@]" >&2\n[ "$VOICEGEN_SID_STAGE" = "${creds.sid}" ] || exit 9\necho '{"kind":"sub","status":"active","friendly_name":"Tandem sub"}'`);
  const info = await describeAccount({ pythonPath: py, wizardPath: '/x/wizard.py', tier: 'stage', creds });
  assert.deepEqual(info, { kind: 'sub', status: 'active', friendlyName: 'Tandem sub' });
});

test('argv never contains the credential values', async (t) => {
  const py = fake(t, `case "$*" in *${creds.sid}*|*${creds.token}*) exit 8;; esac\necho '{"kind":"main"}'`);
  assert.equal((await describeAccount({ pythonPath: py, wizardPath: '/x/wizard.py', tier: 'stage', creds })).kind, 'main');
});

test('unknown kinds collapse to "unknown"', async (t) => {
  const py = fake(t, `echo '{"kind":"weird"}'`);
  assert.equal((await describeAccount({ pythonPath: py, wizardPath: 'w', tier: 'dev', creds })).kind, 'unknown');
});

test('failure carries wizard.py\'s message and the tier', async (t) => {
  const py = fake(t, `echo "Could not authenticate against stage (api.stage.twilio.com)." >&2\nexit 1`);
  await assert.rejects(describeAccount({ pythonPath: py, wizardPath: 'w', tier: 'stage', creds }), /Could not verify the account on stage: Could not authenticate/);
});

test('no python is a clear error', async () => {
  await assert.rejects(describeAccount({ pythonPath: null, wizardPath: 'w', tier: 'stage', creds }), /python3 was not found/);
});
