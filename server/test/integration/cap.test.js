import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api } from '../helpers/harness.js';

let S;
before(async () => { S = await bootTestServer({ config: { numbers: [{ id: 'n1', label: 'Number 1', dailyCap: 1 }] } }); S.addNumber('n1', '6586068766'); });
after(() => S.close());
beforeEach(() => {
  S.records.length = 0;
  const today = new Date().toISOString();
  S.seedLeads([
    // One send already today on n1 → n1 is at its cap of 1.
    { id: 80, name: 'AlreadySent', phone: '6591110080', status: 'interested', assignedNumber: 'n1', sentReplies: [{ text: 'hi', timestamp: today, channel: 'whatsapp' }] },
    { id: 81, name: 'Target', phone: '6591110081', status: 'interested', assignedNumber: 'n1' },
  ]);
});

test('manual send is blocked with cap_exceeded once the number is at its daily cap', async () => {
  const r = await api(S.base, '/api/leads/81/send', { method: 'POST', body: { text: 'one more' } });
  assert.equal(r.status, 409);
  const b = await r.json();
  assert.equal(b.error, 'cap_exceeded');
  assert.equal(b.cap, 1);
  assert.equal(b.sentToday, 1);
  assert.equal(S.records.length, 0, 'nothing was sent');
});

test('force:true breaches the cap and sends', async () => {
  const r = await api(S.base, '/api/leads/81/send', { method: 'POST', body: { text: 'forced', force: true } });
  assert.equal(r.status, 200);
  assert.equal(S.records.length, 1, 'sent despite the cap');
});
