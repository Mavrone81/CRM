import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => { S = await bootTestServer(); });
after(() => S.close());
beforeEach(() => S.seedLeads([
  { id: 1, name: 'Alice', phone: '6591234567', status: 'review' },
  { id: 2, name: 'Bob', phone: '6597654321', status: 'contacted' },
]));

test('DELETE /api/leads/:id removes the lead', async () => {
  const r = await api(S.base, '/api/leads/1', { method: 'DELETE' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.removed.id, 1);

  const all = await (await api(S.base, '/api/leads')).json();
  assert.ok(!all.some((l) => l.id === 1), 'lead 1 is gone');
  assert.ok(all.some((l) => l.id === 2), 'other leads untouched');
});

test('DELETE /api/leads/:id 404s for an unknown lead', async () => {
  const r = await api(S.base, '/api/leads/9999', { method: 'DELETE' });
  assert.equal(r.status, 404);
});
