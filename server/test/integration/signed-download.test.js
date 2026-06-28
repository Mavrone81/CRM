import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => {
  S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } });
  mkdirSync(join(S.dir, 'signed'), { recursive: true });
  writeFileSync(join(S.dir, 'signed', '70-stub.pdf'), '%PDF-1.4 signed stub');
  S.seedLeads([
    { id: 70, name: 'Signed Sam', phone: '6591110070', status: 'signed', wf: { signed: { lastFile: '70-stub.pdf', result: { signed: true, missing: [], complete: true } } } },
    { id: 71, name: 'No File', phone: '6591110071', status: 'agreement' },
  ]);
});
after(() => S.close());

test('downloads the stored signed PDF as an attachment', async () => {
  const r = await api(S.base, '/api/leads/70/signed');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/pdf/);
  assert.match(r.headers.get('content-disposition') || '', /attachment.*\.pdf/);
  assert.match(await r.text(), /%PDF/);
});

test('404 when the lead has no signed agreement on file', async () => {
  assert.equal((await api(S.base, '/api/leads/71/signed')).status, 404);
});
