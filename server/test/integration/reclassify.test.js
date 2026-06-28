import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => { S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } }); S.addNumber('n1', '6586068766'); });
after(() => S.close());
beforeEach(() => {
  S.seedLeads([
    { id: 60, name: 'Talky', phone: '6591110060', status: 'confirmed', assignedNumber: 'n1', replies: [{ text: 'I already attended the intro briefing', timestamp: '2026-06-20T00:00:00.000Z' }] },
    { id: 61, name: 'Quiet', phone: '6591110061', status: 'confirmed', assignedNumber: 'n1' },
  ]);
});

test('reclassify returns the from/to contract and never regresses (no AI key in test = no move)', async () => {
  const r = await api(S.base, '/api/leads/60/reclassify', { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.from, 'confirmed');
  assert.equal(body.to, 'confirmed', 'forward-guard + no-AI fallback never regresses');
  assert.equal(body.moved, false);
});

test('reclassify on a lead with no conversation is a safe no-op', async () => {
  const r = await api(S.base, '/api/leads/61/reclassify', { method: 'POST' });
  const body = await r.json();
  assert.equal(body.moved, false);
  assert.match(body.reason, /no conversation/i);
});
