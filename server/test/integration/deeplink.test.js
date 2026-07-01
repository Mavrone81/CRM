import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

// Baileys-free outbound: reps send WhatsApp from their own app via a click-to-chat
// deep link; the CRM only RECORDS the send (POST /log-sent) and lets a rep paste an
// inbound reply (POST /reply) to keep the pipeline intelligent without a socket.
let S;
before(async () => {
  S = await bootTestServer({
    documents: [{ id: 'doc1', file: 'agreement.pdf', name: 'Associate Agreement.pdf', mimetype: 'application/pdf', isDefault: true }],
    config: { numbers: [{ id: 'n1', label: 'Number 1' }] },
  });
});
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  S.seedLeads([
    { id: 1, name: 'Cold Carl', phone: '6591110001', status: 'new' },
    { id: 2, name: 'Pipe Pam', phone: '6591110002', status: 'interested', replies: [{ text: 'sounds good', timestamp: '2026-06-30T00:00:00Z' }] },
  ]);
});

test('log-sent records the outbound in the thread + advances new → contacted, NO socket send', async () => {
  const r = await api(S.base, '/api/leads/1/log-sent', { method: 'POST', body: { text: 'Hi Carl, quick intro…' } });
  assert.equal(r.status, 200);
  assert.equal(S.records.length, 0, 'nothing transmitted via a socket');

  const lead = (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === 1);
  assert.equal(lead.status, 'contacted', 'cold new lead advances to contacted on first send');
  assert.equal(lead.needsReply, false);
  assert.ok(lead.lastContactedAt, 'last-contacted bumped');
  const sent = lead.sentReplies.at(-1);
  assert.equal(sent.text, 'Hi Carl, quick intro…');
  assert.equal(sent.channel, 'whatsapp');
});

test('log-sent carries an optional kind + does not downgrade a pipeline status', async () => {
  const r = await api(S.base, '/api/leads/2/log-sent', { method: 'POST', body: { text: 'agreement coming', kind: 'agreement' } });
  assert.equal(r.status, 200);
  const lead = (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === 2);
  assert.equal(lead.status, 'interested', 'a pipeline lead keeps its status (only new→contacted)');
  assert.equal(lead.sentReplies.at(-1).kind, 'agreement');
});

test('log-sent validates input', async () => {
  assert.equal((await api(S.base, '/api/leads/1/log-sent', { method: 'POST', body: { text: '  ' } })).status, 400);
  assert.equal((await api(S.base, '/api/leads/999/log-sent', { method: 'POST', body: { text: 'x' } })).status, 404);
});

test('reply on a pipeline lead records the inbound + returns cleanly (classifyStage no-ops offline)', async () => {
  const r = await api(S.base, '/api/leads/2/reply', { method: 'POST', body: { text: 'I already attended the briefing' } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.moved, false, 'no API key → stage classifier is a no-op, status unchanged');
  const lead = (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === 2);
  assert.equal(lead.status, 'interested');
  assert.ok(lead.replies.some((x) => x.text === 'I already attended the briefing'), 'inbound recorded');
});

test('a decline reply at a pipeline stage moves the lead to declined (keyword, offline)', async () => {
  const r = await api(S.base, '/api/leads/2/reply', { method: 'POST', body: { text: 'please stop, I am not interested anymore' } });
  assert.equal(r.status, 200);
  const lead = (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === 2);
  assert.equal(lead.status, 'declined', 'explicit withdrawal honoured at any stage');
});

test('document download serves the PDF (by id and by "default")', async () => {
  for (const path of ['/api/documents/doc1/download', '/api/documents/default/download']) {
    const r = await api(S.base, path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type') || '', /application\/pdf/);
    assert.match(r.headers.get('content-disposition') || '', /attachment/);
    assert.match(await r.text(), /%PDF/);
  }
  assert.equal((await api(S.base, '/api/documents/nope/download')).status, 404);
});
