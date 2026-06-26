import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcomingSessions, fmtSessions, sessionDisplaySrv } from '../../index.js';

test('upcomingSessions drops past dates, keeps future + undated, sorted', () => {
  const list = [
    { id: 'a', date: '2099-12-31' },
    { id: 'b', date: '2000-01-01' }, // past
    { id: 'c', date: '' },            // undated → always available
    { id: 'd', date: '2099-07-03' },
  ];
  const up = upcomingSessions(list).map((s) => s.id);
  assert.ok(!up.includes('b'), 'past date excluded');
  assert.ok(up.includes('a') && up.includes('c') && up.includes('d'));
  // dated ones sorted ascending; undated sorts first (empty string)
  assert.deepEqual(up.filter((x) => x !== 'c'), ['d', 'a']);
});

test('sessionDisplaySrv formats weekday + 12h time + date', () => {
  const d = sessionDisplaySrv({ date: '2099-07-03', time: '19:30' });
  assert.match(d, /7:30pm/);
  assert.match(d, /3 Jul/);
});

test('sessionDisplaySrv handles am/no-minutes and falls back to label', () => {
  assert.match(sessionDisplaySrv({ date: '2099-07-03', time: '14:00' }), /2pm/);
  assert.match(sessionDisplaySrv({ date: '2099-07-03', time: '09:05' }), /9:05am/);
  assert.equal(sessionDisplaySrv({ label: 'Thursday 7:30pm' }), 'Thursday 7:30pm'); // no date/time
  assert.match(sessionDisplaySrv({ date: '2099-07-03' }), /3 Jul/); // date only, no time
});

test('fmtSessions returns a bullet list of upcoming only', () => {
  const out = fmtSessions([{ date: '2000-01-01', time: '10:00' }, { date: '2099-07-03', time: '19:30' }]);
  assert.ok(out.startsWith('• '));
  assert.match(out, /7:30pm/);
  assert.ok(!/10am|10:00/.test(out), 'past session not listed');
});
