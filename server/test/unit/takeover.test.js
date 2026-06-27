import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewRepTakeover } from '../../index.js';

test('isNewRepTakeover: true when prior sends were from a different number', () => {
  const lead = { assignedNumber: 'n2', sentReplies: [{ text: 'hi', via: 'nmqvr7rlz' }] };
  assert.equal(isNewRepTakeover(lead), true);
});

test('isNewRepTakeover: false when already messaged from the current number', () => {
  const lead = { assignedNumber: 'n2', sentReplies: [{ text: 'hi', via: 'nmqvr7rlz' }, { text: 'yo', via: 'n2' }] };
  assert.equal(isNewRepTakeover(lead), false);
});

test('isNewRepTakeover: false for a brand-new lead (no prior sends)', () => {
  assert.equal(isNewRepTakeover({ assignedNumber: 'n2', sentReplies: [] }), false);
  assert.equal(isNewRepTakeover({ assignedNumber: 'n2' }), false);
});
