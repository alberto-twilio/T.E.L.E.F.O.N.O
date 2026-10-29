// Credentials live in the macOS Keychain (via the `security` CLI), one item
// per profile. They are never written to any file this app owns.
const { execFile } = require('node:child_process');

const SERVICE = 'voice-test-data-gen';

const security = (args) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout.replace(/\n$/, ''));
      }
    });
  });

// -U updates in place if the item already exists.
// keySid is only present for profiles that authenticate with an API key (token is then that key's secret).
const setCredentials = (profileId, { sid, token, keySid }) =>
  security(['add-generic-password', '-U', '-s', SERVICE, '-a', profileId, '-w', JSON.stringify({ sid, token, ...(keySid ? { keySid } : {}) })]);

const getCredentials = async (profileId) => {
  try {
    return JSON.parse(await security(['find-generic-password', '-s', SERVICE, '-a', profileId, '-w']));
  } catch (e) {
    return null;
  }
};

const deleteCredentials = async (profileId) => {
  try {
    await security(['delete-generic-password', '-s', SERVICE, '-a', profileId]);
  } catch (e) {
    // already gone
  }
};

module.exports = { setCredentials, getCredentials, deleteCredentials };
