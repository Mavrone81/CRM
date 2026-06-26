import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { warmCap, sentTodayFor, inSendWindow } from '../../index.js';

const DAY = 86400000;

describe('warmCap — warming ramp', () => {
  test('no addedAt -> treated as fully warm (returns cap)', () => {
    assert.equal(warmCap({}), 40); // DEFAULT_CAP
    assert.equal(warmCap({ dailyCap: 100 }), 100);
  });

  test('freshly added (0 days) starts at 10', () => {
    assert.equal(warmCap({ addedAt: new Date().toISOString() }), 10);
  });

  test('ramps +10 per day', () => {
    const ago = (d) => new Date(Date.now() - d * DAY - 1000).toISOString();
    assert.equal(warmCap({ addedAt: ago(1) }), 20);
    assert.equal(warmCap({ addedAt: ago(2) }), 30);
  });

  test('ramp is clamped to the cap (default 40)', () => {
    const ago = (d) => new Date(Date.now() - d * DAY - 1000).toISOString();
    assert.equal(warmCap({ addedAt: ago(3) }), 40);
    assert.equal(warmCap({ addedAt: ago(30) }), 40);
  });

  test('ramp respects a higher custom dailyCap', () => {
    const ago = (d) => new Date(Date.now() - d * DAY - 1000).toISOString();
    assert.equal(warmCap({ dailyCap: 100, addedAt: ago(5) }), 60);
    assert.equal(warmCap({ dailyCap: 100, addedAt: ago(50) }), 100);
  });

  test('never returns below the floor of 10 (even for a future addedAt)', () => {
    const future = new Date(Date.now() + 5 * DAY).toISOString();
    assert.equal(warmCap({ addedAt: future }), 10);
  });
});

describe('sentTodayFor', () => {
  const todayIso = () => new Date().toISOString();
  const oldIso = '2000-01-01T08:00:00.000Z';

  const leads = [
    {
      assignedNumber: 'n1',
      sentReplies: [
        { channel: 'whatsapp', timestamp: todayIso() },
        { channel: 'whatsapp', timestamp: todayIso() },
        { channel: 'whatsapp', timestamp: oldIso }, // old day -> not counted
        { channel: 'telegram', timestamp: todayIso() }, // wrong channel -> not counted
      ],
    },
    {
      assignedNumber: 'n2',
      sentReplies: [{ channel: 'whatsapp', timestamp: todayIso() }],
    },
    { assignedNumber: 'n1' }, // no sentReplies array
    { assignedNumber: 'n1', sentReplies: [{ channel: 'whatsapp' }] }, // missing timestamp
  ];

  test('counts only today + whatsapp + matching number', () => {
    assert.equal(sentTodayFor('n1', leads), 2);
  });
  test('isolates per number', () => {
    assert.equal(sentTodayFor('n2', leads), 1);
  });
  test('unknown number -> 0', () => {
    assert.equal(sentTodayFor('n3', leads), 0);
  });
  test('empty leads -> 0', () => {
    assert.equal(sentTodayFor('n1', []), 0);
  });
});

describe('inSendWindow', () => {
  test('returns a boolean (time-dependent; window 07:00-22:30 SGT)', () => {
    assert.equal(typeof inSendWindow(), 'boolean');
  });
});
