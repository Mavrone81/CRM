import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => { S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } }); S.addNumber('n1', '6586068766'); });
after(() => S.close());
beforeEach(() => {
  S.seedLeads([
    { id: 50, name: 'Pipelined', phone: '6591110050', status: 'interested', assignedNumber: 'n1' },
    { id: 51, name: 'Signed', phone: '6591110051', status: 'agreement', assignedNumber: 'n1' },
  ]);
});

test('an explicit decline logged on a PIPELINE lead downgrades to declined', async () => {
  const r = await api(S.base, '/api/leads/50/reply', { method: 'POST', body: { text: 'Not interested sorry' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.lead.status, 'declined', 'interested -> declined on explicit decline');
});

test('a neutral reply on a pipeline lead does NOT change status', async () => {
  const r = await api(S.base, '/api/leads/51/reply', { method: 'POST', body: { text: 'What time is the session?' } });
  const body = await r.json();
  assert.equal(body.lead.status, 'agreement', 'unchanged — not a decline');
});
