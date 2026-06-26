import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage } from '../../index.js';

test('buildMessage weaves the rep name into the opener', () => {
  const msg = buildMessage('Bob', 'Vivian');
  assert.ok(msg.includes('Bob'), 'has the contact name');
  assert.ok(msg.includes("I'm Vivian"), 'introduces the rep by name');
  assert.ok(!msg.includes('[RepIntro]') && !msg.includes('[Name]'), 'no leftover tokens');
});

test('buildMessage with no rep name degrades to no intro', () => {
  const msg = buildMessage('Bob', '');
  assert.ok(msg.includes('Bob'));
  // The rep intro is the "I'm <Name> — " form; the base template's "I'm updating
  // my records" must not be mistaken for it.
  assert.doesNotMatch(msg, /I'm \S+ — /, 'no dangling rep intro when rep name is unset');
  assert.ok(!msg.includes('[RepIntro]'), 'token fully removed');
});

test('buildMessage rep name is optional (back-compat)', () => {
  const msg = buildMessage('Bob');
  assert.ok(msg.includes('Bob'));
  assert.ok(!msg.includes('[RepIntro]'));
});
