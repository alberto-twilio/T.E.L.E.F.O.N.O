const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCredentialIntent } = require('../lib/credintent');

const SID = 'AC' + 'a'.repeat(32);
const existing = { id: 'p1', sidHint: SID.slice(-4) };
const stored = { sid: SID, token: 't' };

test('editing a stored profile with the SID echoed back and no token keeps credentials', () => {
  const r = resolveCredentialIntent({ existing, stored, credentials: { sid: SID, token: '' } });
  assert.equal(r.wantsCreds, false);
  assert.deepEqual(r.errors, []);
});

test('blank SID and blank token keeps credentials too', () => {
  assert.equal(resolveCredentialIntent({ existing, stored, credentials: { sid: '', token: '' } }).wantsCreds, false);
  assert.equal(resolveCredentialIntent({ existing, stored, credentials: undefined }).wantsCreds, false);
});

test('a new token replaces credentials and fills in the locked SID', () => {
  const r = resolveCredentialIntent({ existing, stored, credentials: { sid: '', token: 'new' } });
  assert.equal(r.wantsCreds, true);
  assert.equal(r.creds.sid, SID);
});

test('a different SID is rejected, with or without a token', () => {
  const other = 'AC' + 'b'.repeat(32);
  for (const token of ['', 'new']) {
    assert.match(resolveCredentialIntent({ existing, stored, credentials: { sid: other, token } }).errors.join(' '), /cannot be changed/);
  }
});

test('missing Keychain item: credentials are required again, SID must match the hint', () => {
  const ok = resolveCredentialIntent({ existing, stored: null, credentials: { sid: SID, token: 'x' } });
  assert.equal(ok.wantsCreds, true);
  assert.deepEqual(ok.errors, []);
  const bad = resolveCredentialIntent({ existing, stored: null, credentials: { sid: 'AC' + 'c'.repeat(32), token: 'x' } });
  assert.match(bad.errors.join(' '), /ending/);
});

test('new profile always needs credentials', () => {
  assert.equal(resolveCredentialIntent({ existing: null, stored: null, credentials: {} }).wantsCreds, true);
});
