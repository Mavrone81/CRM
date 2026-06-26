import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOptOut } from '../../index.js';

describe('isOptOut — positive cases', () => {
  const positives = [
    'stop',
    'STOP',
    '  stop  ',
    'stop please',
    'stop contacting me',
    'unsubscribe',
    'Please unsubscribe me',
    'opt out',
    'opt-out',
    'optout',
    'remove me',
    'take me off',
    "don't contact",
    'do not contact',
    'leave me alone',
    'not interested at all',
  ];
  for (const text of positives) {
    test(`true: ${JSON.stringify(text)}`, () => {
      assert.equal(isOptOut(text), true);
    });
  }
});

describe('isOptOut — negative / near-miss cases', () => {
  const negatives = [
    '',
    null,
    undefined,
    'Hi there, interested!',
    'yes please tell me more',
    'I might stopover next week', // "stop" only as substring mid-word, not at start/word-boundary-stop
    'non-stop flights are great', // "stop" not at start and not whole word "stop\b" preceded by hyphen... ensure no match
    'not interested', // distinct from "not interested at all"
    'remove the filter', // "remove" but not "remove me"
    'can you take me there',
  ];
  for (const text of negatives) {
    test(`false: ${JSON.stringify(text)}`, () => {
      assert.equal(isOptOut(text), false);
    });
  }
});
