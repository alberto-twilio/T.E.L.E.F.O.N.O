// Decides, on a profile save, whether credentials must be (re)written and
// whether the submitted SID is allowed. Pure so it can be tested without Electron.
//
// existing: the stored profile or null; stored: its Keychain {sid, token} or null.
// With stored credentials the SID is locked, so only a new token means "replace".
// Auth Tokens are per data region, so moving a profile to another region needs that region's token.
// profile: the submitted profile (its dataRegion); omitted means "region unchanged".
const resolveCredentialIntent = ({ existing, stored, credentials, profile }) => {
  const errors = [];
  let creds = credentials || {};
  const newToken = Boolean((creds.token || '').trim());
  const regionOf = (p) => (p && p.dataRegion) || 'us1';
  const regionChanged = Boolean(existing && profile && regionOf(existing) !== regionOf(profile));
  if (regionChanged && stored && !newToken) {
    errors.push(`Auth Tokens are per region: enter the ${regionOf(profile)} Auth Token for this account to move the profile there.`);
  }
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
  return { wantsCreds, creds, errors };
};

module.exports = { resolveCredentialIntent };
