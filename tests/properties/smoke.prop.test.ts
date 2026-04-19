import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';

describe('fast-check smoke test', () => {
  it('should run property-based tests with fast-check', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      }),
      { numRuns: 100 }
    );
  });
});
