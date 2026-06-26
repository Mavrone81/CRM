import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => {
  S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1' }, { id: 'n2', label: 'Number 2' }, { id: 'n3', label: 'Number 3' }] } });
  S.addNumber('n1', '6586068766');
  S.addNumber('n2', '6589968390');
  S.addNumber('n3', '6589690872');
});
after(() => S.close());
beforeEach(() => S.seedLeads([
  { id: 1, name: 'Unassigned1', phone: '6591000001', status: 'new' },
  { id: 2, name: 'Tagged', phone: '6591000002', status: 'contacted', assignedNumber: 'n1' },
  { id: 3, name: 'Orphan', phone: '6591000003', status: 'interested', assignedNumber: 'nDead' },
  { id: 4, name: 'Unassigned2', phone: '6591000004', status: 'interested' },
  { id: 5, name: 'Tg', phone: '6591000005', status: 'new', channel: 'telegram' },
  { id: 6, name: 'Closed', phone: '6591000006', status: 'declined', assignedNumber: 'n2' },
]));

test('distribute keeps already-tagged leads sticky, only assigns unassigned/orphaned', async () => {
  const r = await api(S.base, '/api/numbers/distribute', { method: 'POST' });
  assert.equal(r.status, 200);
  const d = await r.json();

  const leads = await (await api(S.base, '/api/leads')).json();
  const by = Object.fromEntries(leads.map((l) => [l.id, l]));
  const valid = new Set(['n1', 'n2', 'n3']);

  assert.equal(by[2].assignedNumber, 'n1', 'tagged lead never moved');
  assert.ok(valid.has(by[1].assignedNumber), 'unassigned got a real number');
  assert.ok(valid.has(by[4].assignedNumber), 'unassigned got a real number');
  assert.ok(valid.has(by[3].assignedNumber), 'orphaned (dead-number) lead reassigned to a real number');
  assert.ok(!by[5].assignedNumber, 'telegram lead skipped');
  assert.equal(by[6].assignedNumber, 'n2', 'closed lead untouched');

  assert.equal(d.total, 3, 'assigned exactly the 3 unassigned/orphaned active leads');
  assert.ok(d.kept >= 1, 'reports kept count for already-tagged');
});
