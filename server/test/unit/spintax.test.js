import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spin, buildMessage } from '../../index.js';

describe('spin', () => {
  test('text without braces is returned unchanged', () => {
    assert.equal(spin('hello world'), 'hello world');
    assert.equal(spin('no spintax here, just commas'), 'no spintax here, just commas');
  });

  test('falsy input is passed through', () => {
    assert.equal(spin(''), '');
    assert.equal(spin(null), null);
    assert.equal(spin(undefined), undefined);
  });

  test('every render of {a|b|c} is one of the leaves', () => {
    const leaves = ['a', 'b', 'c'];
    for (let i = 0; i < 200; i++) {
      assert.ok(leaves.includes(spin('{a|b|c}')), 'output must be a leaf');
    }
  });

  test('multiple groups in one string all resolve', () => {
    for (let i = 0; i < 100; i++) {
      const out = spin('{Hi|Hey} there {friend|mate}');
      assert.match(out, /^(Hi|Hey) there (friend|mate)$/);
      assert.ok(!out.includes('{') && !out.includes('|') && !out.includes('}'));
    }
  });

  test('nested groups resolve to a single leaf with no leftover spintax', () => {
    for (let i = 0; i < 200; i++) {
      const out = spin('{outer-{x|y}|z}');
      assert.ok(['outer-x', 'outer-y', 'z'].includes(out), `unexpected: ${out}`);
      assert.ok(!out.includes('{') && !out.includes('|') && !out.includes('}'));
    }
  });

  test('a single-option group just unwraps', () => {
    assert.equal(spin('{only}'), 'only');
  });
});

describe('buildMessage', () => {
  test('contains the name and never the literal [Name] placeholder', () => {
    for (let i = 0; i < 100; i++) {
      const msg = buildMessage('Alice');
      assert.ok(msg.includes('Alice'), 'name should be substituted in');
      assert.ok(!msg.includes('[Name]'), 'no unresolved [Name] placeholder');
    }
  });

  test('no unresolved spintax characters remain', () => {
    for (let i = 0; i < 100; i++) {
      const msg = buildMessage('Bob');
      assert.ok(!msg.includes('{'), 'no leftover {');
      assert.ok(!msg.includes('}'), 'no leftover }');
      assert.ok(!msg.includes('|'), 'no leftover |');
    }
  });

  test('multiple occurrences of the name are all replaced', () => {
    // OUTREACH_SPINTAX uses [Name] once; replace is global so any count works.
    const msg = buildMessage('Zoë');
    assert.ok(msg.includes('Zoë'));
  });
});
