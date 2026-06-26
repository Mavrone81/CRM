import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, statusFromCategory } from '../../index.js';

describe('deriveStatus — stage-driven branches', () => {
  test('onboarded stage', () => {
    assert.equal(deriveStatus({ stage: 'onboarded' }), 'onboarded');
  });
  test('onboarding_slotted -> booked', () => {
    assert.equal(deriveStatus({ stage: 'onboarding_slotted' }), 'booked');
  });
  test('onboarding stage', () => {
    assert.equal(deriveStatus({ stage: 'onboarding' }), 'onboarding');
  });
  test('attended stage', () => {
    assert.equal(deriveStatus({ stage: 'attended' }), 'attended');
  });
  test('slotted -> scheduled', () => {
    assert.equal(deriveStatus({ stage: 'slotted' }), 'scheduled');
  });
  test('confirmed stage', () => {
    assert.equal(deriveStatus({ stage: 'confirmed' }), 'confirmed');
  });
});

describe('deriveStatus — agreement_sent stage', () => {
  test('signed + complete -> signed', () => {
    assert.equal(
      deriveStatus({ stage: 'agreement_sent', wf: { signed: { result: { complete: true } } } }),
      'signed',
    );
  });
  test('agreement reply sent (not yet complete) -> agreement', () => {
    assert.equal(
      deriveStatus({ stage: 'agreement_sent', sentReplies: [{ kind: 'agreement' }] }),
      'agreement',
    );
  });
  test('no signed, no agreement reply -> attended', () => {
    assert.equal(deriveStatus({ stage: 'agreement_sent' }), 'attended');
  });
  test('signed result present but not complete falls through to attended', () => {
    assert.equal(
      deriveStatus({ stage: 'agreement_sent', wf: { signed: { result: { complete: false } } } }),
      'attended',
    );
  });
});

describe('deriveStatus — brief stage', () => {
  test('brief with brief-invite sent -> invited', () => {
    assert.equal(
      deriveStatus({ stage: 'brief', sentReplies: [{ kind: 'brief-invite' }] }),
      'invited',
    );
  });
  test('brief without invite -> interested', () => {
    assert.equal(deriveStatus({ stage: 'brief' }), 'interested');
  });
});

describe('deriveStatus — declined stage', () => {
  test('declined + opted out -> opted_out', () => {
    assert.equal(deriveStatus({ stage: 'declined', wf: { optedOut: true } }), 'opted_out');
  });
  test('declined without opt-out -> declined', () => {
    assert.equal(deriveStatus({ stage: 'declined' }), 'declined');
  });
});

describe('deriveStatus — no stage: opt-out / ai.category / fallbacks', () => {
  test('optedOut (no stage) -> opted_out', () => {
    assert.equal(deriveStatus({ wf: { optedOut: true } }), 'opted_out');
  });
  test('ai.category interested -> interested', () => {
    assert.equal(deriveStatus({ ai: { category: 'interested' } }), 'interested');
  });
  test('ai.category not_interested -> declined', () => {
    assert.equal(deriveStatus({ ai: { category: 'not_interested' } }), 'declined');
  });
  test('ai.category question -> question', () => {
    assert.equal(deriveStatus({ ai: { category: 'question' } }), 'question');
  });
  test('ai.category other -> review', () => {
    assert.equal(deriveStatus({ ai: { category: 'other' } }), 'review');
  });
  test('has replies but no ai category -> review', () => {
    assert.equal(deriveStatus({ replies: [{ text: 'hi' }] }), 'review');
  });
  test('sent but no reply -> contacted', () => {
    assert.equal(deriveStatus({ sent: true }), 'contacted');
  });
  test('empty lead -> new', () => {
    assert.equal(deriveStatus({}), 'new');
  });
  test('opt-out takes priority over ai.category', () => {
    assert.equal(
      deriveStatus({ wf: { optedOut: true }, ai: { category: 'interested' } }),
      'opted_out',
    );
  });
});

describe('statusFromCategory', () => {
  test('interested -> interested', () => {
    assert.equal(statusFromCategory('interested'), 'interested');
  });
  test('not_interested -> declined', () => {
    assert.equal(statusFromCategory('not_interested'), 'declined');
  });
  test('question -> question', () => {
    assert.equal(statusFromCategory('question'), 'question');
  });
  test('other -> review', () => {
    assert.equal(statusFromCategory('other'), 'review');
  });
  test('unknown / undefined category -> review (default)', () => {
    assert.equal(statusFromCategory('anything-else'), 'review');
    assert.equal(statusFromCategory(undefined), 'review');
  });
});
