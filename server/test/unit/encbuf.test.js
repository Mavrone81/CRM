import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const { encBuf, decBuf } = await import('../../index.js');

test('encBuf/decBuf round-trips a binary PDF buffer', () => {
  const pdf = Buffer.from('%PDF-1.4\nbinary\x00\x01\x02 signed content', 'binary');
  const enc = encBuf(pdf);
  assert.ok(enc.subarray(0, 4).equals(Buffer.from('ENC1')), 'tagged ENC1');
  assert.ok(!enc.includes('signed content'), 'plaintext not present in ciphertext');
  assert.ok(decBuf(enc).equals(pdf), 'decrypts back to the original bytes');
});

test('decBuf passes through legacy plaintext PDFs (no ENC1 magic)', () => {
  const pdf = Buffer.from('%PDF-1.4 legacy', 'binary');
  assert.ok(decBuf(pdf).equals(pdf));
});

test('tampered ciphertext fails GCM auth', () => {
  const enc = encBuf(Buffer.from('secret bytes'));
  enc[enc.length - 1] ^= 0xff;
  assert.throws(() => decBuf(enc));
});
