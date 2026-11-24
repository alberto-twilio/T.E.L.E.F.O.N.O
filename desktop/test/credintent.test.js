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

test('moving a stored profile to another data region needs that region\'s token', () => {
  const us1 = { ...existing, dataRegion: 'us1' };
  const blocked = resolveCredentialIntent({ existing: us1, stored, credentials: { sid: '', token: '' }, profile: { dataRegion: 'au1' } });
  assert.match(blocked.errors.join(' '), /au1 Auth Token/);
  const ok = resolveCredentialIntent({ existing: us1, stored, credentials: { sid: '', token: 'au1-token' }, profile: { dataRegion: 'au1' } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.wantsCreds, true);
  // same region (missing dataRegion means us1) keeps credentials without a token
  assert.deepEqual(resolveCredentialIntent({ existing, stored, credentials: {}, profile: { dataRegion: 'us1' } }).errors, []);
});
