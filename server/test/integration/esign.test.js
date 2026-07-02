import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootTestServer, api } from '../helpers/harness.js';

// E-sign portal: per-lead HMAC token; the lead fills the required fields + draws a
// signature; validation is DETERMINISTIC (server rejects missing fields), a
// signature-certificate PDF is stored encrypted, and the lead advances to `signed`.
const REQUIRED = ['Full name (as in NRIC)', 'NRIC number', "Associate's signature"];
// 1x1 white PNG — a stand-in for the canvas signature.
const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let S, mod;
before(async () => {
  process.env.DATA_KEY = 'a'.repeat(64); // enable at-rest encryption (64 hex chars, read at import)
  S = await bootTestServer({
    documents: [{ id: 'doc1', file: 'agreement.pdf', name: 'Associate Agreement.pdf', mimetype: 'application/pdf', isDefault: true }],
    config: { numbers: [{ id: 'n1', label: 'Number 1' }], requiredFields: REQUIRED },
  });
  mod = S.mod;
});
after(() => { S.close(); delete process.env.DATA_KEY; });
beforeEach(() => {
  S.seedLeads([
    { id: 5, name: 'Signer Sue', phone: '6591110005', status: 'agreement', assignedNumber: 'n1' },
    { id: 6, name: 'Done Dan', phone: '6591110006', status: 'signed', wf: { signed: { result: { complete: true } } } },
  ]);
});

test('sign tokens verify and reject tampering / booking tokens', () => {
  const tok = mod.signTokenFor(5);
  assert.equal(mod.verifySignToken(tok), 5);
  assert.equal(mod.verifySignToken(tok + 'x'), null);
  assert.equal(mod.verifySignToken('5.forged'), null);
  // A BOOKING token must not open the sign portal (namespaced HMAC).
  assert.equal(mod.verifySignToken(mod.bookingToken(5)), null);
});

test('GET returns name, doc, and the non-signature required fields', async () => {
  const r = await api(S.base, `/api/sign/${mod.signTokenFor(5)}`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.name, 'Signer Sue');
  assert.equal(d.doc.name, 'Associate Agreement.pdf');
  assert.deepEqual(d.fields, ['Full name (as in NRIC)', 'NRIC number'], 'signature field handled by the canvas, not a text input');
  assert.equal(d.signed, false);
});

test('GET with an invalid token 404s; a signed lead reports signed', async () => {
  assert.equal((await api(S.base, '/api/sign/9999.bad')).status, 404);
  const d = await (await api(S.base, `/api/sign/${mod.signTokenFor(6)}`)).json();
  assert.equal(d.signed, true);
});

test('the agreement PDF streams for a valid token', async () => {
  const r = await api(S.base, `/api/sign/${mod.signTokenFor(5)}/doc`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/pdf/);
  assert.match(await r.text(), /%PDF/);
});

test('POST rejects missing fields deterministically (lists them)', async () => {
  const r = await api(S.base, `/api/sign/${mod.signTokenFor(5)}`, {
    method: 'POST',
    body: { fields: { 'Full name (as in NRIC)': 'Sue Tan' }, signature: '' },
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.deepEqual(d.missing, ['NRIC number', 'Signature']);
});

test('POST with all fields + signature signs the lead and stores an encrypted PDF', async () => {
  const r = await api(S.base, `/api/sign/${mod.signTokenFor(5)}`, {
    method: 'POST',
    body: { fields: { 'Full name (as in NRIC)': 'Sue Tan', 'NRIC number': 'S1234567A' }, signature: SIG_PNG },
  });
  assert.equal(r.status, 200);

  const lead = (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === 5);
  assert.equal(lead.status, 'signed');
  assert.equal(lead.wf.signed.result.complete, true);
  assert.equal(lead.wf.signed.result.method, 'esign');
  assert.equal(lead.wf.signed.result.fields['NRIC number'], 'S1234567A');

  // The stored file is encrypted at rest and decrypts to a real PDF containing the certificate.
  const file = lead.wf.signed.lastFile;
  assert.ok(readdirSync(join(S.dir, 'signed')).includes(file));
  const raw = readFileSync(join(S.dir, 'signed', file));
  assert.doesNotMatch(raw.slice(0, 8).toString(), /%PDF/, 'encrypted on disk');
  const pdf = mod.decBuf(raw);
  assert.match(pdf.slice(0, 8).toString(), /%PDF/, 'decrypts to a PDF');

  // And the existing signed-download endpoint serves it.
  const dl = await api(S.base, '/api/leads/5/signed');
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /%PDF/);
});

test('an already-signed lead gets ok:already (no double-record)', async () => {
  const r = await api(S.base, `/api/sign/${mod.signTokenFor(6)}`, {
    method: 'POST',
    body: { fields: {}, signature: SIG_PNG },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).already, true);
});

test('the agreement caption carries the e-sign link', async () => {
  const r = await api(S.base, '/api/wf/agreement/5', { method: 'POST', body: {} });
  const d = await r.json();
  assert.match(d.caption, /\/sign\/5\./, 'default caption contains the sign URL');
});

test('the auth-side sign-link endpoint returns the URL', async () => {
  const d = await (await api(S.base, '/api/leads/5/sign-link')).json();
  assert.match(d.url, /\/sign\/5\./);
  assert.equal(mod.verifySignToken(d.url.split('/sign/')[1]), 5);
});
