import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOwnSend } from '../../index.js';

const mk = (over = {}) => ({ key: { remoteJid: '6591234567@s.whatsapp.net', id: 's1', fromMe: true }, message: { conversation: 'replied from my phone' }, ...over });

test('records a phone-sent reply onto the lead.sentReplies and clears needsReply', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567', needsReply: true }];
  const id = applyOwnSend(leads, mk(), 'n1');
  assert.equal(id, 1);
  assert.equal(leads[0].sentReplies.length, 1);
  assert.equal(leads[0].sentReplies[0].text, 'replied from my phone');
  assert.equal(leads[0].sentReplies[0].via, 'n1');
  assert.equal(leads[0].needsReply, false);
});

test('dedups by id and by same-text-near-time (no double vs a bot /send)', () => {
  // same id twice
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  applyOwnSend(leads, mk(), 'n1');
  assert.equal(applyOwnSend(leads, mk(), 'n1'), null, 'same id deduped');
  assert.equal(leads[0].sentReplies.length, 1);
  // bot /send recorded an id-less entry just now → the upsert echo (with id) is deduped by text+time
  const leads2 = [{ id: 1, name: 'A', phone: '6591234567', sentReplies: [{ text: 'hi there', timestamp: new Date().toISOString() }] }];
  assert.equal(applyOwnSend(leads2, mk({ message: { conversation: 'hi there' } }), 'n1'), null, 'echo of bot send deduped');
  assert.equal(leads2[0].sentReplies.length, 1);
});

test('skips media/documents and unmatched recipients', () => {
  const leads = [{ id: 1, name: 'A', phone: '6591234567' }];
  assert.equal(applyOwnSend(leads, mk({ message: { imageMessage: {} } }), 'n1'), null, 'media skipped');
  assert.equal(applyOwnSend([{ id: 1, name: 'A', phone: '6580000000' }], mk(), 'n1'), null, 'no matching lead');
});
