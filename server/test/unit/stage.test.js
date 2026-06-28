import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStageMove } from '../../index.js';

const sc = (status, confidence = 'high') => ({ status, confidence, reason: '', suggested_reply: '' });

test('moves a lead FORWARD when clearly indicated (Janet: confirmed -> attended)', () => {
  assert.equal(applyStageMove('confirmed', sc('attended')), 'attended');
  assert.equal(applyStageMove('confirmed', sc('onboarding')), 'onboarding');
  assert.equal(applyStageMove('interested', sc('agreement')), 'agreement');
});

test('never moves BACKWARD', () => {
  assert.equal(applyStageMove('attended', sc('confirmed')), null);
  assert.equal(applyStageMove('agreement', sc('interested')), null);
});

test('never auto-sets text-gated stages (signed / scheduled / booked / onboarded)', () => {
  assert.equal(applyStageMove('attended', sc('signed')), null, 'signed needs a returned PDF');
  assert.equal(applyStageMove('confirmed', sc('scheduled')), null, 'scheduled needs a session');
  assert.equal(applyStageMove('onboarding', sc('booked')), null, 'booked needs a session');
});

test('declined is honoured at any stage; unchanged / low-confidence is a no-op', () => {
  assert.equal(applyStageMove('agreement', sc('declined')), 'declined');
  assert.equal(applyStageMove('declined', sc('declined')), null, 'already declined');
  assert.equal(applyStageMove('confirmed', sc('unchanged')), null);
  assert.equal(applyStageMove('confirmed', sc('attended', 'low')), null, 'low confidence ignored');
});
