import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryMessage } from '../../index.js';

const mk = (over) => ({ key: { remoteJid: '6591234567@s.whatsapp.net', id: 'm1', fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: 1719500000, ...over });

test('records an inbound history message onto the lead.replies', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  const id = applyHistoryMessage(leads, mk());
  assert.equal(id, 1);
  assert.equal(leads[0].replies.length, 1);
  assert.equal(leads[0].replies[0].text, 'hello');
  assert.equal(leads[0].replies[0].backfilled, true);
});

test('records OUR sent history message onto sentReplies (both directions)', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  const id = applyHistoryMessage(leads, mk({ key: { remoteJid: '6591234567@s.whatsapp.net', id: 'm2', fromMe: true }, message: { conversation: 'hi from us' } }));
  assert.equal(id, 1);
  assert.equal(leads[0].sentReplies.length, 1);
  assert.equal(leads[0].sentReplies[0].text, 'hi from us');
  assert.equal(leads[0].sentReplies[0].channel, 'whatsapp');
  assert.ok(!leads[0].replies, 'not recorded as an inbound reply');
});

test('dedupes by id and by text (vs live + repeated history)', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567', replies: [{ text: 'hello' }] }]; // live entry, no id
  assert.equal(applyHistoryMessage(leads, mk()), null, 'same text deduped vs live');
  assert.equal(leads[0].replies.length, 1);
  // same id twice
  const leads2 = [{ id: 1, name: 'A', phone: '6591234567' }];
  applyHistoryMessage(leads2, mk({ message: { conversation: 'x' } }));
  assert.equal(applyHistoryMessage(leads2, mk({ message: { conversation: 'x' } })), null, 'same id deduped');
  assert.equal(leads2[0].replies.length, 1);
});

test('skips unmatched numbers and contentless media', () => {
  const leads = [{ id: 1, name: 'A', phone: '6580000000' }];
  assert.equal(applyHistoryMessage(leads, mk()), null, 'no matching lead');
  const leads2 = [{ id: 1, name: 'A', phone: '6591234567' }];
  assert.equal(applyHistoryMessage(leads2, mk({ message: { imageMessage: {} } })), null, 'bare media skipped');
});
