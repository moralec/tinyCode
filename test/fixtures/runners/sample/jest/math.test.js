import { add, mul } from './math';

describe('math', () => {
  test('adds two numbers', () => {
    expect(add(2, 3)).toEqual(5);
  });

  test('multiplies two numbers', () => {
    expect(mul(2, 3)).toEqual(6);
  });
});
