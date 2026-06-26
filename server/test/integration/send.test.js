import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => {
  S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }, { id: 'n2', label: 'Number 2' }] } });
  S.addNumber('n1', '6586068766');
  S.addNumber('n2', '6589968390');
});
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  S.seedLeads([
    { id: 20, name: 'Carol', phone: '6591234567', status: 'contacted', assignedNumber: 'n2' },
    { id: 21, name: 'Dave', phone: '6597654321', status: 'opted_out', assignedNumber: 'n1' },
  ]);
});

test('POST /api/leads/:id/send goes out via the lead\'s assigned number', async () => {
  const r = await api(S.base, '/api/leads/20/send', { method: 'POST', body: { text: 'hello there' } });
  assert.equal(r.status, 200);
  assert.equal(S.records.length, 1);
  assert.equal(S.records[0].numId, 'n2');
  assert.equal(S.records[0].msg.text, 'hello there');
});

test('POST /api/leads/:id/send is blocked for an opted-out lead', async () => {
  const r = await api(S.base, '/api/leads/21/send', { method: 'POST', body: { text: 'please come back' } });
  assert.equal(r.status, 400);
  assert.equal(S.records.length, 0, 'nothing sent to an opted-out lead');
});

test('POST /api/leads/:id/send requires text', async () => {
  const r = await api(S.base, '/api/leads/20/send', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
});
