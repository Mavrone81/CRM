import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

// Agreement is now Baileys-free: we NEVER transmit the PDF via a socket. The endpoint
// records the send + advances to 'agreement' + returns { caption, doc } so the UI can
// download the file (to attach) and open a click-to-chat deep link. This guards that
// no socket send happens and the mark still works with zero open numbers.
let S;
before(async () => {
  S = await bootTestServer({
    documents: [{ id: 'doc1', file: 'agreement.pdf', name: 'Associate Agreement.pdf', mimetype: 'application/pdf', isDefault: true }],
    config: { numbers: [{ id: 'n1', label: 'Number 1' }, { id: 'n2', label: 'Number 2' }, { id: 'n3', label: 'Number 3' }] },
  });
  S.addNumber('n1', '6586068766');
  S.addNumber('n2', '6589968390');
  S.addNumber('n3', '6589690872');
});
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  S.seedLeads([{ id: 10, name: 'Gabby', phone: '88281147', status: 'attended', assignedNumber: 'n2' }]);
});

test('agreement marks the lead + returns caption/doc, with NO socket send (Baileys-free)', async () => {
  const r = await api(S.base, '/api/wf/agreement/10', { method: 'POST', body: { caption: 'Hi Gabby, agreement attached.' } });
  assert.equal(r.status, 200);
  const d = await r.json();

  assert.equal(S.records.length, 0, 'no document is transmitted via any socket');
  assert.equal(d.lead.status, 'agreement');
  assert.ok(d.lead.wf.agreement.sentAt);
  assert.equal(d.caption, 'Hi Gabby, agreement attached.', 'caption returned for the deep link');
  assert.equal(d.doc.id, 'doc1', 'default document returned for download');
  assert.ok(d.lead.sentReplies.some((x) => x.text === 'Hi Gabby, agreement attached.' && x.kind === 'agreement'), 'caption recorded in thread');
});

test('agreement still works with NO open WhatsApp number (no socket needed)', async () => {
  S.seedLeads([{ id: 11, name: 'NoNum', phone: '6591234567', status: 'attended', assignedNumber: 'nX' }]);
  const saved = [...S.conns.entries()];
  for (const [, c] of S.conns) c.state = 'connecting';
  const r = await api(S.base, '/api/wf/agreement/11', { method: 'POST', body: {} });
  for (const [id, c] of saved) S.conns.set(id, c); // restore
  assert.equal(r.status, 200, 'Baileys-free: no 503 even when every number is closed');
  const d = await r.json();
  assert.equal(d.lead.status, 'agreement');
  assert.match(d.caption, /associate agreement/i, 'default caption built server-side');
});
