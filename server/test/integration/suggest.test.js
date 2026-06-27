import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => {
  S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } });
  S.addNumber('n1', '6586068766');
});
after(() => S.close());
beforeEach(() => {
  S.seedLeads([
    { id: 40, name: 'Newbie', phone: '6591110040', status: 'new', sent: false, assignedNumber: 'n1' },
    { id: 41, name: 'Cold', phone: '6591110041', status: 'contacted', sent: true, assignedNumber: 'n1' },
  ]);
});

test('suggest for a NEW lead returns the cold opener', async () => {
  const r = await api(S.base, '/api/leads/40/suggest', { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.suggested_reply, /lost my chat history/i, 'opener re-intro present');
});

test('suggest for an already-CONTACTED cold lead returns a follow-up nudge (not the opener)', async () => {
  const r = await api(S.base, '/api/leads/41/suggest', { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.doesNotMatch(body.suggested_reply, /lost my chat history/i, 'not the cold opener');
  assert.match(body.suggested_reply, /following up|circling back|checking in|follow up/i, 'reads as a follow-up');
});
