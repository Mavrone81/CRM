import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

// The on-prem read-only receiver POSTs incoming WhatsApp messages to /api/ingest.
// It's token-authed (INGEST_TOKEN, read at module load) and feeds the SAME
// classify/advance pipeline the live socket used.
const TOKEN = 'test-ingest-token';
const post = (base, body) => api(base, '/api/ingest', { method: 'POST', body });
const getLead = async (S, id) => (await (await api(S.base, '/api/leads')).json()).find((l) => l.id === id);

let S;
before(async () => {
  process.env.INGEST_TOKEN = TOKEN; // captured by index.js at import time
  S = await bootTestServer({ config: { numbers: [{ id: 'onprem-n2', label: 'On-prem N2' }] } });
});
after(() => { S.close(); delete process.env.INGEST_TOKEN; });
beforeEach(() => {
  S.seedLeads([
    { id: 1, name: 'Ingest Ivy', phone: '6591110001', status: 'interested', replies: [] },
    { id: 2, name: 'Cold Carl', phone: '6591110002', status: 'contacted' },
  ]);
});

test('rejects a missing or wrong token', async () => {
  assert.equal((await post(S.base, { messages: [{ phone: '6591110001', text: 'hi' }] })).status, 401);
  assert.equal((await post(S.base, { token: 'nope', messages: [{ phone: '6591110001', text: 'hi' }] })).status, 401);
});

test('records an inbound reply + flags needsReply (pipeline lead, offline classifier = no move)', async () => {
  const r = await post(S.base, { token: TOKEN, messages: [{ phone: '6591110001', text: 'sounds good, keen', id: 'm1', via: 'onprem-n2' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, synced: 1, matched: 1, unmatched: 0 });
  const l = await getLead(S, 1);
  assert.ok(l.replies.some((x) => x.text === 'sounds good, keen'), 'inbound recorded');
  assert.equal(l.needsReply, true);
  assert.equal(l.assignedNumber, 'onprem-n2', 'via set the sticky number');
  assert.equal(l.status, 'interested', 'classifyStage no-ops offline');
});

test('an inbound decline moves the lead to declined (keyword, offline)', async () => {
  await post(S.base, { token: TOKEN, messages: [{ phone: '6591110001', text: 'please stop, not interested anymore', id: 'd1' }] });
  assert.equal((await getLead(S, 1)).status, 'declined');
});

test('a fromMe message records the rep\'s own outbound in the thread', async () => {
  const r = await post(S.base, { token: TOKEN, messages: [{ phone: '6591110002', text: 'Hi Carl, following up!', fromMe: true, id: 'o1' }] });
  assert.equal(r.status, 200);
  const l = await getLead(S, 2);
  assert.ok(l.sentReplies.some((x) => x.text === 'Hi Carl, following up!'), 'own send mirrored');
  assert.equal(l.needsReply, false);
});

test('dedups a redelivered message by id', async () => {
  const msg = { phone: '6591110001', text: 'only once please', id: 'dup1' };
  await post(S.base, { token: TOKEN, messages: [msg] });
  await post(S.base, { token: TOKEN, messages: [msg] }); // redelivery
  const l = await getLead(S, 1);
  assert.equal(l.replies.filter((x) => x.text === 'only once please').length, 1);
});

test('unmatched phone is counted, not crashed', async () => {
  const r = await post(S.base, { token: TOKEN, messages: [{ phone: '6590000000', text: 'who dis', id: 'u1' }] });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.unmatched, 1);
  assert.equal(d.matched, 0);
});

test('batches multiple messages in one call', async () => {
  const r = await post(S.base, { token: TOKEN, messages: [
    { phone: '6591110001', text: 'msg A', id: 'a' },
    { phone: '6591110002', text: 'rep reply', fromMe: true, id: 'b' },
  ] });
  assert.equal((await r.json()).synced, 2);
});
