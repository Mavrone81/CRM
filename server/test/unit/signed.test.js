import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSignedResult } from '../../index.js';

const FIELDS = ['Commencement date', "Associate's signature", 'NRIC number'];

test('drops off-list fields the model invented (e.g. company counter-signature)', () => {
  const r = sanitizeSignedResult({ signed: true, missing: ['Company signature', 'Date of agreement'], complete: false, notes: '' }, FIELDS);
  assert.deepEqual(r.missing, [], 'no real required field is missing');
  assert.equal(r.complete, true, 'so it is actually complete');
});

test('keeps genuinely-missing required fields', () => {
  const r = sanitizeSignedResult({ signed: true, missing: ['Commencement date', 'Company signature'], complete: false, notes: '' }, FIELDS);
  assert.deepEqual(r.missing, ['Commencement date']);
  assert.equal(r.complete, false);
});

test('not complete if the associate signature is absent, even with no missing fields', () => {
  const r = sanitizeSignedResult({ signed: false, missing: [], complete: false, notes: '' }, FIELDS);
  assert.equal(r.complete, false);
});
