import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { senderPhoneOf, matchLead, messageText } from '../../index.js';

describe('senderPhoneOf', () => {
  test('reads the phone from remoteJid', () => {
    const msg = { key: { remoteJid: '6591955242@s.whatsapp.net' } };
    assert.equal(senderPhoneOf(msg), '6591955242');
  });

  test('falls back to senderPn when remoteJid is an @lid (privacy routing)', () => {
    const msg = {
      key: {
        remoteJid: '123456789@lid',
        senderPn: '6591955242@s.whatsapp.net',
      },
    };
    assert.equal(senderPhoneOf(msg), '6591955242');
  });

  test('uses participant in a group-style key', () => {
    const msg = {
      key: { remoteJid: '120363000@g.us', participant: '6588281147@s.whatsapp.net' },
    };
    assert.equal(senderPhoneOf(msg), '6588281147');
  });

  test('returns empty string when no @s.whatsapp.net jid is present', () => {
    assert.equal(senderPhoneOf({ key: { remoteJid: '123@lid' } }), '');
    assert.equal(senderPhoneOf({ key: {} }), '');
    assert.equal(senderPhoneOf({}), '');
  });
});

describe('matchLead', () => {
  const leads = [
    { id: 'a', phone: '91955242' },        // SG local -> normalises to 6591955242
    { id: 'b', phone: '6588281147' },      // already has cc
    { id: 'c', phone: '14155552671' },     // international
  ];

  test('full normalised match (SG local lead vs 65-prefixed sender)', () => {
    assert.equal(matchLead(leads, '6591955242')?.id, 'a');
  });

  test('full match against an already-cc lead', () => {
    assert.equal(matchLead(leads, '6588281147')?.id, 'b');
  });

  test('last-8-digit fallback when full form differs', () => {
    // sender has a different leading prefix but shares the last 8 digits
    assert.equal(matchLead(leads, '441455552671')?.id, 'c');
    // a differently-prefixed SG number still matches lead "a" on last 8
    assert.equal(matchLead(leads, '0091955242')?.id, 'a');
  });

  test('no match returns undefined', () => {
    assert.equal(matchLead(leads, '6500000000'), undefined);
  });

  test('too-short sender does not false-match', () => {
    assert.equal(matchLead(leads, '5242'), undefined);
  });
});

describe('messageText', () => {
  test('plain conversation message', () => {
    assert.equal(messageText({ message: { conversation: 'hello' } }), 'hello');
  });

  test('extendedTextMessage', () => {
    assert.equal(
      messageText({ message: { extendedTextMessage: { text: 'long reply' } } }),
      'long reply',
    );
  });

  test('image caption', () => {
    assert.equal(
      messageText({ message: { imageMessage: { caption: 'nice pic' } } }),
      'nice pic',
    );
  });

  test('documentMessage -> [document: <fileName>] placeholder', () => {
    assert.equal(
      messageText({ message: { documentMessage: { fileName: 'agreement.pdf' } } }),
      '[document: agreement.pdf]',
    );
  });

  test('documentWithCaptionMessage nested document is handled', () => {
    assert.equal(
      messageText({
        message: {
          documentWithCaptionMessage: { message: { documentMessage: { fileName: 'signed.pdf' } } },
        },
      }),
      '[document: signed.pdf]',
    );
  });

  test('document with no fileName -> [document: file]', () => {
    assert.equal(messageText({ message: { documentMessage: {} } }), '[document: file]');
  });

  test('unknown / media-only message -> [media]', () => {
    assert.equal(messageText({ message: { stickerMessage: {} } }), '[media]');
    assert.equal(messageText({ message: {} }), '[media]');
    assert.equal(messageText({}), '[media]');
  });
});
