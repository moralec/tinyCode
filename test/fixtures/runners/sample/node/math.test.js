import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { add, mul } from './math.js';

describe('math', () => {
  test('adds two numbers', () => {
    assert.equal(add(2, 3), 5);
  });

  test('multiplies two numbers', () => {
    assert.equal(mul(2, 3), 6);
  });
});
