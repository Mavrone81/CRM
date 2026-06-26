import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => {
  S = await bootTestServer({
    documents: [{ id: 'doc1', file: 'agreement.pdf', name: 'Associate Agreement.pdf', mimetype: 'application/pdf', isDefault: true }],
    config: { numbers: [
      { id: 'n1', label: 'Number 1', repName: 'Vince' },
      { id: 'n2', label: 'Number 2', repName: 'Vivian' },
      { id: 'n3', label: 'Number 3' }, // no rep name yet
    ] },
  });
  S.addNumber('n1', '6586068766');
  S.addNumber('n2', '6589968390');
  S.addNumber('n3', '6589690872');
});
after(() => S.close());
beforeEach(() => { S.records.length = 0; });

test('GET /api/status surfaces repName per number', async () => {
  const d = await (await api(S.base, '/api/status')).json();
  const byId = Object.fromEntries(d.numbers.map((n) => [n.id, n.repName]));
  assert.equal(byId.n2, 'Vivian');
  assert.equal(byId.n3, ''); // unset → empty string
});

test('PATCH /api/numbers/:id sets and clears repName', async () => {
  await api(S.base, '/api/numbers/n3', { method: 'PATCH', body: { repName: 'Vicky' } });
  let nums = await (await api(S.base, '/api/numbers')).json();
  assert.equal(nums.find((n) => n.id === 'n3').repName, 'Vicky');
  await api(S.base, '/api/numbers/n3', { method: 'PATCH', body: { repName: '' } });
  nums = await (await api(S.base, '/api/numbers')).json();
  assert.equal(nums.find((n) => n.id === 'n3').repName, '');
});

test('agreement default caption introduces the assigned number\'s rep', async () => {
  S.seedLeads([{ id: 40, name: 'Gabby', phone: '88281147', status: 'attended', assignedNumber: 'n2' }]);
  const r = await api(S.base, '/api/wf/agreement/40', { method: 'POST', body: {} }); // no caption → default
  assert.equal(r.status, 200);
  assert.equal(S.records.length, 1);
  assert.match(S.records[0].msg.caption, /I'm Vivian/);
});

test('agreement default caption omits the intro when the rep is unset', async () => {
  S.seedLeads([{ id: 41, name: 'Sam', phone: '6591234567', status: 'attended', assignedNumber: 'n3' }]);
  const r = await api(S.base, '/api/wf/agreement/41', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.doesNotMatch(S.records[0].msg.caption, /I'm /);
});
