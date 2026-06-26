import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => { S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } }); });
after(() => S.close());
beforeEach(() => S.seedLeads([
  { id: 1, name: 'Alice', phone: '6591234567', status: 'review' },
  { id: 2, name: 'Bob', phone: '88281147', status: 'contacted' },
]));

test('POST /api/leads/:id/status sets a valid status', async () => {
  const r = await api(S.base, '/api/leads/1/status', { method: 'POST', body: { status: 'interested' } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.lead.status, 'interested');
});

test('POST /api/leads/:id/status rejects an invalid status', async () => {
  const r = await api(S.base, '/api/leads/1/status', { method: 'POST', body: { status: 'definitely-not-a-status' } });
  assert.equal(r.status, 400);
});

test('POST /api/leads/:id/status 404s for an unknown lead', async () => {
  const r = await api(S.base, '/api/leads/9999/status', { method: 'POST', body: { status: 'interested' } });
  assert.equal(r.status, 404);
});

test('PATCH /api/leads/:id canonicalizes the phone number', async () => {
  const r = await api(S.base, '/api/leads/2', { method: 'PATCH', body: { phone: '8828 1147' } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.phone, /^65\d{8}$/); // 8-digit SG → 65-prefixed
});
