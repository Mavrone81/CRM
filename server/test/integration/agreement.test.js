import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

// Regression guard for commit 4c1f71d: the agreement PDF must be sent from the
// lead's OWN sticky number (sockForLead), NOT firstSock() (which is always n1).
let S;
before(async () => {
  S = await bootTestServer({
    documents: [{ id: 'doc1', file: 'agreement.pdf', name: 'Associate Agreement.pdf', mimetype: 'application/pdf', isDefault: true }],
    config: { numbers: [{ id: 'n1', label: 'Number 1' }, { id: 'n2', label: 'Number 2' }, { id: 'n3', label: 'Number 3' }] },
  });
  S.addNumber('n1', '6586068766'); // firstSock would pick this one
  S.addNumber('n2', '6589968390');
  S.addNumber('n3', '6589690872');
});
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  S.seedLeads([{ id: 10, name: 'Gabby', phone: '88281147', status: 'attended', assignedNumber: 'n2' }]);
});

test('agreement is sent from the lead\'s own number (n2), not firstSock (n1)', async () => {
  const r = await api(S.base, '/api/wf/agreement/10', { method: 'POST', body: { caption: 'Hi Gabby, agreement attached.' } });
  assert.equal(r.status, 200);
  const d = await r.json();

  assert.equal(S.records.length, 1, 'exactly one document send');
  assert.equal(S.records[0].numId, 'n2', 'sent via the assigned number, not n1');
  assert.ok(S.records[0].msg.document, 'it was a document message');
  assert.equal(S.records[0].msg.caption, 'Hi Gabby, agreement attached.');

  assert.equal(d.lead.status, 'agreement');
  assert.ok(d.lead.wf.agreement.sentAt);
  assert.ok(d.lead.sentReplies.some((x) => x.text === 'Hi Gabby, agreement attached.'), 'caption recorded in thread');
});

test('agreement 503s when the lead has no open WhatsApp number', async () => {
  S.seedLeads([{ id: 11, name: 'NoNum', phone: '6591234567', status: 'attended', assignedNumber: 'nX' }]);
  // Temporarily make every number look closed.
  const saved = [...S.conns.entries()];
  for (const [, c] of S.conns) c.state = 'connecting';
  const r = await api(S.base, '/api/wf/agreement/11', { method: 'POST', body: {} });
  for (const [id, c] of saved) S.conns.set(id, c); // restore
  assert.equal(r.status, 503);
});
