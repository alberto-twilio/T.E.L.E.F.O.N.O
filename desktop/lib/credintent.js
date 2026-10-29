// Decides, on a profile save, whether credentials must be (re)written and
// whether the submitted SID is allowed. Pure so it can be tested without Electron.
//
// existing: the stored profile or null; stored: its Keychain {sid, token} or null.
// With stored credentials the SID is locked, so only a new token means "replace".
const resolveCredentialIntent = ({ existing, stored, credentials, authKind = 'token' }) => {
  const errors = [];
  let creds = credentials || {};
  const newToken = Boolean((creds.token || '').trim());
  const wantsCreds = !existing || !stored || newToken;
  if (existing) {
    const given = (creds.sid || '').trim();
    if (stored && given && given.toLowerCase() !== stored.sid.toLowerCase()) {
      errors.push('The Account SID cannot be changed on an existing profile. Create a new profile for another account.');
    } else if (!stored && existing.sidHint && given && !given.endsWith(existing.sidHint)) {
      errors.push(`The Account SID must be the one this profile was created with (ending ${existing.sidHint}).`);
    } else if (stored && !given) {
      creds = { ...creds, sid: stored.sid };
    }
  }
  if (existing && stored && !newToken) {
    // the secret is what proves a change: switching type or replacing the key SID needs the new secret too
    if ((stored.keySid ? 'apikey' : 'token') !== authKind) errors.push('Enter the new credentials to switch between Auth Token and API Key.');
    else if ((creds.keySid || '').trim() && creds.keySid.trim() !== stored.keySid) errors.push('Enter the API Key secret too to replace the API key.');
  }
  return { wantsCreds, creds, errors };
};

module.exports = { resolveCredentialIntent };
