// WA_RECEIVE_ONLY mode: sockets are inbound-capture only. WhatsApp send
// endpoints refuse with 409 receive_only, outreach won't start, probes are
// disabled — but inbound (/reply) and the deep-link log (/log-sent) still work.
// Env must be set BEFORE the harness import boots index.js.
process.env.WA_RECEIVE_ONLY = '1';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

const t = await bootTestServer({
  leads: [
    { id: 1, name: 'Wa Lead', phone: '6591110001', status: 'contacted', channel: 'whatsapp', assignedNumber: 'n1', replies: [] },
    { id: 2, name: 'Cold Lead', phone: '6591110002', status: 'new', channel: 'whatsapp', replies: [] },
  ],
  config: { numbers: [{ id: 'n1', label: 'Number 1', phone: '6580000001' }] },
});
t.addNumber('n1', '6580000001');
after(() => t.close());

test('POST /api/leads/:id/send is refused with 409 receive_only', async () => {
  const r = await api(t.base, '/api/leads/1/send', { method: 'POST', body: { text: 'hello' } });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error, 'receive_only');
  assert.equal(t.records.length, 0); // nothing transmitted through the socket
});

test('POST /api/outreach/start is refused with 409 receive_only', async () => {
  const r = await api(t.base, '/api/outreach/start', { method: 'POST', body: {} });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'receive_only');
});

test('probe endpoint refuses (a probe sends a message)', async () => {
  const r = await api(t.base, '/api/numbers/n1/probe', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /WA_RECEIVE_ONLY/);
  assert.equal(t.records.length, 0);
});

test('inbound manual paste (/reply) still works and advances the lead', async () => {
  const r = await api(t.base, '/api/leads/1/reply', { method: 'POST', body: { text: 'no thanks, not interested' } });
  assert.equal(r.status, 200);
  const leads = await (await api(t.base, '/api/leads')).json();
  assert.equal(leads.find((l) => l.id === 1).status, 'declined'); // keyword classify fallback ran
});

test('deep-link log-sent still works (new -> contacted)', async () => {
  const r = await api(t.base, '/api/leads/2/log-sent', { method: 'POST', body: { text: 'opener via wa.me' } });
  assert.equal(r.status, 200);
  const leads = await (await api(t.base, '/api/leads')).json();
  assert.equal(leads.find((l) => l.id === 2).status, 'contacted');
});
