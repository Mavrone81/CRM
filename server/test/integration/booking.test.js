import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S, token;
before(async () => {
  S = await bootTestServer({
    config: {
      sessions: [
        { id: 'b1', date: '2099-07-03', time: '19:30', capacity: 2 },
        { id: 'b2', date: '2099-07-05', time: '14:00', capacity: 1 },
        { id: 'past', date: '2000-01-01', time: '10:00', capacity: 9 },
      ],
      onboardingSessions: [{ id: 'o1', date: '2099-08-01', time: '19:00', capacity: 5 }],
    },
  });
  token = S.mod.bookingToken; // sign with the running module's secret
});
after(() => S.close());
beforeEach(() => S.seedLeads([
  { id: 1, name: 'Briony', phone: '6591000001', status: 'invited' },
  { id: 2, name: 'Filler', phone: '6591000002', status: 'invited', wf: { session: 'b2' } }, // fills b2 (cap 1)
  { id: 3, name: 'Onboarder', phone: '6591000003', status: 'signed' },
]));

test('GET /api/book/:token returns upcoming briefing slots with availability', async () => {
  const d = await (await api(S.base, `/api/book/${token(1)}`)).json();
  assert.equal(d.name, 'Briony');
  assert.equal(d.kind, 'briefing');
  const ids = d.slots.map((s) => s.id);
  assert.ok(ids.includes('b1') && ids.includes('b2'), 'upcoming slots listed');
  assert.ok(!ids.includes('past'), 'past slot excluded');
  assert.equal(d.slots.find((s) => s.id === 'b2').full, true, 'b2 full (cap 1, 1 booked)');
  assert.equal(d.slots.find((s) => s.id === 'b1').full, false);
});

test('GET with an invalid token 404s', async () => {
  const r = await api(S.base, '/api/book/1.bogussig');
  assert.equal(r.status, 404);
});

test('POST books an open briefing slot and advances to scheduled', async () => {
  const r = await api(S.base, `/api/book/${token(1)}`, { method: 'POST', body: { sessionId: 'b1' } });
  assert.equal(r.status, 200);
  const leads = await (await api(S.base, '/api/leads')).json();
  const l = leads.find((x) => x.id === 1);
  assert.equal(l.status, 'scheduled');
  assert.equal(l.wf.session, 'b1');
});

test('POST a full slot is rejected (409)', async () => {
  const r = await api(S.base, `/api/book/${token(1)}`, { method: 'POST', body: { sessionId: 'b2' } });
  assert.equal(r.status, 409);
});

test('a signed lead books an ONBOARDING slot and advances to booked', async () => {
  const d = await (await api(S.base, `/api/book/${token(3)}`)).json();
  assert.equal(d.kind, 'onboarding');
  const r = await api(S.base, `/api/book/${token(3)}`, { method: 'POST', body: { sessionId: 'o1' } });
  assert.equal(r.status, 200);
  const leads = await (await api(S.base, '/api/leads')).json();
  const l = leads.find((x) => x.id === 3);
  assert.equal(l.status, 'booked');
  assert.equal(l.wf.onboardingSession, 'o1');
});
