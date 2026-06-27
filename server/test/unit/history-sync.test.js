import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryMessage, buildLidMap } from '../../index.js';

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

test('dedups same id (re-sync) + same-text-near-time (live); KEEPS cross-rep messages', () => {
  // re-sync: same message id twice → deduped
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  applyHistoryMessage(leads, mk({ message: { conversation: 'x' } }));
  assert.equal(applyHistoryMessage(leads, mk({ message: { conversation: 'x' } })), null, 'same id deduped');
  assert.equal(leads[0].replies.length, 1);

  // live entry (no id) with same text + near timestamp → deduped
  const leads2 = [{ id: 1, name: 'A', phone: '6591234567', replies: [{ text: 'hello', timestamp: new Date(1719500000 * 1000).toISOString() }] }];
  assert.equal(applyHistoryMessage(leads2, mk()), null, 'same text near-time deduped vs live');
  assert.equal(leads2[0].replies.length, 1);

  // cross-rep reconcile: same text but a different message id / far-apart time → BOTH kept
  const leads3 = [{ id: 1, name: 'A', phone: '6591234567', replies: [{ id: 'old', text: 'hi', timestamp: new Date(1700000000 * 1000).toISOString() }] }];
  assert.equal(applyHistoryMessage(leads3, mk({ message: { conversation: 'hi' }, key: { remoteJid: '6591234567@s.whatsapp.net', id: 'new', fromMe: false } })), 1);
  assert.equal(leads3[0].replies.length, 2, 'same text, different message → kept (reconciliation)');
});

test('tags backfilled entries with the source number (via)', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  applyHistoryMessage(leads, mk({ key: { remoteJid: '6591234567@s.whatsapp.net', id: 'v1', fromMe: true }, message: { conversation: 'from sam' } }), 'n1');
  assert.equal(leads[0].sentReplies[0].via, 'n1');
});

test('skips unmatched numbers and contentless media', () => {
  const leads = [{ id: 1, name: 'A', phone: '6580000000' }];
  assert.equal(applyHistoryMessage(leads, mk()), null, 'no matching lead');
  const leads2 = [{ id: 1, name: 'A', phone: '6591234567' }];
  assert.equal(applyHistoryMessage(leads2, mk({ message: { imageMessage: {} } })), null, 'bare media skipped');
});

test('resolves @lid messages to a lead via the contacts lid->phone map', () => {
  const contacts = [{ id: '6591234567@s.whatsapp.net', lid: '136683659997435@lid' }];
  const lidMap = buildLidMap(contacts);
  assert.equal(lidMap['136683659997435@lid'], '6591234567');
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  const msg = { key: { remoteJid: '136683659997435@lid', id: 'lidmsg', fromMe: true }, message: { conversation: 'hey via lid' }, messageTimestamp: 1719500000 };
  assert.equal(applyHistoryMessage(leads, msg, 'n2', lidMap), 1, 'matched via lid map');
  assert.equal(leads[0].sentReplies[0].text, 'hey via lid');
});
