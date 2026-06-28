import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDecline, isOptOut } from '../../index.js';

test('isDecline catches clear withdrawals', () => {
  for (const s of ['Not interested sorry', 'no thanks', 'no thank you', 'changed my mind', 'not keen', 'not for me', "I'll pass", 'please withdraw me']) {
    assert.equal(isDecline(s), true, s);
  }
});

test('isDecline ignores neutral / positive / questions', () => {
  for (const s of ['What is the job position?', 'Ok', 'interested!', 'yes lets go', 'can you tell me more', '']) {
    assert.equal(isDecline(s), false, s);
  }
});

test('"not interested" is a decline, not an opt-out', () => {
  assert.equal(isDecline('Not interested sorry'), true);
  assert.equal(isOptOut('Not interested sorry'), false); // opt-out is the stronger "stop contacting" set
});
