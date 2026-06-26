import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingToken, verifyBookingToken, bookingUrl, bookingKind, bookingSlots } from '../../index.js';

test('booking token round-trips and rejects tampering', () => {
  const tok = bookingToken(42);
  assert.equal(verifyBookingToken(tok), 42);
  assert.equal(verifyBookingToken(tok + 'x'), null, 'altered signature rejected');
  assert.equal(verifyBookingToken('42.bogus'), null, 'wrong signature rejected');
  assert.equal(verifyBookingToken('42'), null, 'missing signature rejected');
  assert.equal(verifyBookingToken(''), null);
  assert.equal(verifyBookingToken(null), null);
  assert.notEqual(bookingToken(42), bookingToken(43), 'different ids → different tokens');
});

test('bookingUrl embeds the token under /book/', () => {
  const url = bookingUrl(7);
  assert.match(url, /\/book\/7\./);
  assert.ok(url.startsWith('http'));
});

test('bookingKind switches to onboarding once signed', () => {
  for (const s of ['new', 'contacted', 'interested', 'invited', 'confirmed', 'scheduled', 'attended', 'agreement']) {
    assert.equal(bookingKind({ status: s }), 'briefing', `${s} → briefing`);
  }
  for (const s of ['signed', 'onboarding', 'booked', 'onboarded']) {
    assert.equal(bookingKind({ status: s }), 'onboarding', `${s} → onboarding`);
  }
});

test('bookingSlots reports availability + capacity, upcoming only', () => {
  const cfg = {
    sessions: [
      { id: 'a', date: '2099-07-03', time: '19:30', capacity: 2 },
      { id: 'b', date: '2099-07-05', time: '14:00', capacity: 1 },
      { id: 'past', date: '2000-01-01', time: '10:00', capacity: 5 },
    ],
  };
  const leads = [{ wf: { session: 'b' } }, { wf: { session: 'a' } }]; // b: 1 booked (full), a: 1 booked (cap 2)
  const slots = bookingSlots(cfg, leads, 'briefing');
  const ids = slots.map((s) => s.id);
  assert.deepEqual(ids, ['a', 'b'], 'past slot excluded, sorted by date');
  assert.equal(slots.find((s) => s.id === 'b').full, true, 'b is full (cap 1, 1 booked)');
  assert.equal(slots.find((s) => s.id === 'a').full, false, 'a has room (cap 2, 1 booked)');
  assert.equal(slots.find((s) => s.id === 'a').booked, 1);
});
