import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowup, buildMessage } from '../../index.js';

test('buildFollowup is a gentle nudge, NOT the cold opener', () => {
  const f = buildFollowup('Pat', 'Vivian');
  assert.ok(f.includes('Pat'), 'substitutes the name');
  assert.ok(f.includes('Vivian'), 'weaves the rep name');
  assert.ok(!/lost my chat history/i.test(f), 'does not re-introduce with the opener');
  assert.ok(/following up|circling back|checking in|follow up/i.test(f), 'reads as a follow-up');
});

test('buildMessage (opener) and buildFollowup (nudge) are distinct', () => {
  assert.ok(/lost my chat history/i.test(buildMessage('Pat')), 'opener has the re-intro');
  assert.ok(!/lost my chat history/i.test(buildFollowup('Pat')), 'nudge does not');
});
