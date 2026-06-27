import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOutreachOpener, createOutreachLeads, contactNameMap } from '../../index.js';

const opener = 'Hi there, we connected previously regarding a career opportunity but I switched to WhatsApp Business and lost my chat history. Reply "Interested".';

test('isOutreachOpener detects our opener, not personal chats', () => {
  assert.equal(isOutreachOpener(opener), true);
  assert.equal(isOutreachOpener('hey bro lunch later?'), false);
  assert.equal(isOutreachOpener(''), false);
});

test('contactNameMap maps phone -> name (incl. @lid via lidMap)', () => {
  const contacts = [
    { id: '6591234567@s.whatsapp.net', name: 'Direct Dan' },
    { id: '999000111@lid', name: 'Lid Lucy' },
  ];
  const map = contactNameMap(contacts, { '999000111@lid': '6597654321' });
  assert.equal(map['6591234567'], 'Direct Dan');
  assert.equal(map['6597654321'], 'Lid Lucy');
});

test('createOutreachLeads adds only new outreach recipients (skips existing + non-openers)', () => {
  const leads = [{ id: 5, name: 'Existing', phone: '6591234567' }];
  const mk = (jid, text, fromMe = true) => ({ key: { remoteJid: jid, id: jid + text, fromMe }, message: { conversation: text } });
  const messages = [
    mk('6591234567@s.whatsapp.net', opener),       // existing lead -> skip
    mk('6598887777@s.whatsapp.net', opener),       // NEW outreach recipient -> create
    mk('6598887777@s.whatsapp.net', opener),       // same number again -> dedup
    mk('6595550000@s.whatsapp.net', 'hey lunch?'), // not an opener -> skip
    mk('6596661111@s.whatsapp.net', opener, false),// inbound, not fromMe -> skip
  ];
  const created = createOutreachLeads(leads, messages, {}, { '6598887777': 'New Nina' }, 'n4');
  assert.equal(created.length, 1);
  assert.equal(created[0].phone, '6598887777');
  assert.equal(created[0].name, 'New Nina');
  assert.equal(created[0].status, 'contacted');
  assert.equal(created[0].assignedNumber, 'n4');
  assert.ok(created[0].backfillLead);
  assert.equal(leads.length, 2); // one added
});
