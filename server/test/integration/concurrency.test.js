import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

// Guards the crm-leads-atomic-writes rule: concurrent writes that each go through
// mutateLeads must NOT clobber each other (the lost-reply race, fixed in bbf1a19).
let S;
before(async () => {
  S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }] } });
  S.addNumber('n1', '6586068766');
});
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  S.seedLeads([{ id: 30, name: 'Eve', phone: '6591112222', status: 'contacted', assignedNumber: 'n1' }]);
});

test('10 concurrent sends all persist (no lost writes)', async () => {
  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api(S.base, '/api/leads/30/send', { method: 'POST', body: { text: `msg ${i}` } })),
  );
  assert.ok(results.every((r) => r.status === 200), 'all sends returned 200');

  const all = await (await api(S.base, '/api/leads')).json();
  const lead = all.find((l) => l.id === 30);
  assert.equal((lead.sentReplies || []).length, N, `expected ${N} sentReplies, none clobbered`);
  assert.equal(S.records.length, N, 'fake socket received all N sends');
});
