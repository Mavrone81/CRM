import { test } from 'node:test';
import assert from 'node:assert/strict';

// DATA_KEY is read at module-eval time, and static imports hoist above any code —
// so set the key first, THEN dynamic-import index.js to exercise the encrypted path.
process.env.DATA_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const { encStr, decStr } = await import('../../index.js');

test('encStr produces ENC1-tagged ciphertext that round-trips', () => {
  const plain = JSON.stringify({ name: 'Secret Lead', phone: '6591234567' });
  const enc = encStr(plain);
  assert.ok(enc.startsWith('ENC1:'), 'tagged as encrypted');
  assert.ok(!enc.includes('Secret Lead'), 'plaintext not present in ciphertext');
  assert.ok(!enc.includes('6591234567'), 'phone not present in ciphertext');
  assert.equal(decStr(enc), plain, 'decrypts back to the original');
});

test('decStr passes plaintext through (pre-migration files)', () => {
  const plain = '[{"id":1,"name":"Plain"}]';
  assert.equal(decStr(plain), plain);
});

test('a different IV each time → different ciphertext for the same input', () => {
  const a = encStr('same');
  const b = encStr('same');
  assert.notEqual(a, b, 'nondeterministic (random IV)');
  assert.equal(decStr(a), 'same');
  assert.equal(decStr(b), 'same');
});

test('tampered ciphertext fails authentication (GCM)', () => {
  const enc = encStr('integrity matters');
  const tampered = enc.slice(0, -6) + (enc.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  assert.throws(() => decStr(tampered));
});
