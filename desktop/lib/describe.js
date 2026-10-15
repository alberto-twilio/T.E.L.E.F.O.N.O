// Asks wizard.py (never Twilio directly) whether a SID is a main account or a
// subaccount: `wizard.py --describe-account` does one read-only GET and prints
// one JSON line. Credentials reach the child only as env vars, like a run.
const { spawn } = require('node:child_process');
const { envNames } = require('./args');

const KINDS = ['main', 'sub', 'unknown'];

const describeAccount = ({ pythonPath, wizardPath, tier, creds, timeoutMs = 45000 }) => new Promise((resolve, reject) => {
  if (!pythonPath) return reject(new Error('python3 was not found on this machine.'));
  const { sidEnv, tokenEnv } = envNames(tier);
  const child = spawn(pythonPath, ['-u', wizardPath, '--sid-env', sidEnv, '--token-env', tokenEnv, '--tier', tier, '--describe-account'], {
    env: { ...process.env, [sidEnv]: creds.sid, [tokenEnv]: creds.token, PYTHONUNBUFFERED: '1' },
  });
  let out = '';
  let err = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start python: ${e.message}`)); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const fail = () => reject(new Error(`Could not verify the account on ${tier}: ${err.trim().split('\n').pop() || 'no response (check the VPN and the environment).'}`));
    if (code !== 0) return fail();
    try {
      const info = JSON.parse(out.trim().split('\n').pop());
      resolve({
        kind: KINDS.includes(info.kind) ? info.kind : 'unknown',
        status: info.status || null,
        friendlyName: info.friendly_name || null,
      });
    } catch (e) {
      fail();
    }
  });
});

module.exports = { describeAccount };
