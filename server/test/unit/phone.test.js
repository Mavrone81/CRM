import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalisePhone, canonPhone, toJid } from '../../index.js';

describe('normalisePhone', () => {
  test('SG 8-digit local number gets 65 prefix', () => {
    assert.equal(normalisePhone('91955242'), '6591955242');
    assert.equal(normalisePhone('88281147'), '6588281147');
  });

  test('strips spaces and dashes before checking length', () => {
    assert.equal(normalisePhone('9195 5242'), '6591955242');
    assert.equal(normalisePhone('8828-1147'), '6588281147');
  });

  test('already-65 number is returned digits-only, unchanged', () => {
    assert.equal(normalisePhone('6591955242'), '6591955242');
    assert.equal(normalisePhone('+65 9195 5242'), '6591955242');
  });

  test('international number (non-8-digit) returned as digits', () => {
    assert.equal(normalisePhone('14155552671'), '14155552671');
    assert.equal(normalisePhone('+1 (415) 555-2671'), '14155552671');
  });

  test('invalid / empty inputs return null', () => {
    assert.equal(normalisePhone(''), null);
    assert.equal(normalisePhone(null), null);
    assert.equal(normalisePhone(undefined), null);
    assert.equal(normalisePhone('abc'), null);
    assert.equal(normalisePhone('---'), null);
  });
});

describe('canonPhone', () => {
  test('bare 8-digit local number prepends default SG cc', () => {
    assert.equal(canonPhone('91955242'), '6591955242');
  });

  test('leading zero (trunk prefix) is stripped before prepending cc', () => {
    assert.equal(canonPhone('091955242'), '6591955242');
    assert.equal(canonPhone('0091955242'), '6591955242');
  });

  test('already has the country code -> returned unchanged', () => {
    assert.equal(canonPhone('6591955242'), '6591955242');
  });

  test('long number (>=10 digits) assumed to already include a cc', () => {
    assert.equal(canonPhone('14155552671'), '14155552671');
  });

  test('honours an explicit country code argument', () => {
    assert.equal(canonPhone('91955242', '60'), '6091955242');
    // strips non-digits from the cc, falls back to 65 when blank
    assert.equal(canonPhone('91955242', '+60'), '6091955242');
    assert.equal(canonPhone('91955242', ''), '6591955242');
  });

  test('empty / non-digit input returns empty string', () => {
    assert.equal(canonPhone(''), '');
    assert.equal(canonPhone(null), '');
    assert.equal(canonPhone('abc'), '');
  });
});

describe('toJid', () => {
  test('produces <digits>@s.whatsapp.net for valid numbers', () => {
    assert.equal(toJid('91955242'), '6591955242@s.whatsapp.net');
    assert.equal(toJid('6591955242'), '6591955242@s.whatsapp.net');
    assert.equal(toJid('14155552671'), '14155552671@s.whatsapp.net');
  });

  test('returns null for invalid / empty input', () => {
    assert.equal(toJid(''), null);
    assert.equal(toJid(null), null);
    assert.equal(toJid('abc'), null);
  });
});
