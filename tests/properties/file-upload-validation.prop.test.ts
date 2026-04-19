/**
 * Property-based tests for PDF file upload validation.
 *
 * **Validates: Requirements 8.5**
 *
 * Property 12: File Upload Validation
 * For any uploaded file, if the file's MIME type is not `application/pdf` or
 * the file size exceeds 20 MB, the backend should return a 400 status code
 * with a descriptive error message and should not forward the file to Gemini.
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { validatePDFFile } from '../../src/services/pdf-handler.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in bytes
const PDF_MIME = 'application/pdf';

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/** Arbitrary MIME type string — most won't be application/pdf. */
const arbitraryMimeArb = fc.oneof(
  // Common non-PDF MIME types
  fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/gif',
    'text/plain',
    'text/html',
    'application/json',
    'application/octet-stream',
    'application/zip',
    'video/mp4',
    'audio/mpeg',
  ),
  // Random MIME-like strings: type/subtype
  fc.tuple(
    fc.stringMatching(/^[a-z]{1,20}$/),
    fc.stringMatching(/^[a-z0-9\-]{1,30}$/),
  ).map(([type, sub]) => `${type}/${sub}`),
);

/** Non-PDF MIME type — guaranteed to never be application/pdf. */
const nonPdfMimeArb = arbitraryMimeArb.filter((m) => m !== PDF_MIME);

/** File size that is within the 20MB limit (0 to 20MB inclusive). */
const validSizeArb = fc.integer({ min: 0, max: MAX_FILE_SIZE });

/** File size that exceeds the 20MB limit. */
const oversizedArb = fc.integer({ min: MAX_FILE_SIZE + 1, max: 100 * 1024 * 1024 });

/** Arbitrary file size — any non-negative integer. */
const anySizeArb = fc.integer({ min: 0, max: 200 * 1024 * 1024 });

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 12: File Upload Validation', () => {
  it('rejects any file with a non-PDF MIME type regardless of size', () => {
    fc.assert(
      fc.property(nonPdfMimeArb, anySizeArb, (mimetype, size) => {
        const result = validatePDFFile({ mimetype, size });

        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
        expect(result.error!.length).toBeGreaterThan(0);
        // Error should mention the invalid MIME type
        expect(result.error!.toLowerCase()).toMatch(/invalid|type/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects PDF files that exceed 20MB', () => {
    fc.assert(
      fc.property(oversizedArb, (size) => {
        const result = validatePDFFile({ mimetype: PDF_MIME, size });

        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
        expect(result.error!.length).toBeGreaterThan(0);
        // Error should mention size/large
        expect(result.error!.toLowerCase()).toMatch(/large|size|limit|mb/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts PDF files with valid MIME and size 0 to 20MB', () => {
    fc.assert(
      fc.property(validSizeArb, (size) => {
        const result = validatePDFFile({ mimetype: PDF_MIME, size });

        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('error messages are descriptive non-empty strings mentioning the issue', () => {
    // Generate files that are invalid for either reason (or both)
    const invalidFileArb = fc.oneof(
      // Wrong MIME, any size
      fc.tuple(nonPdfMimeArb, anySizeArb).map(([mimetype, size]) => ({ mimetype, size })),
      // Correct MIME, oversized
      oversizedArb.map((size) => ({ mimetype: PDF_MIME, size })),
    );

    fc.assert(
      fc.property(invalidFileArb, (file) => {
        const result = validatePDFFile(file);

        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
        // Must be a descriptive message, not just "error" or empty
        expect(result.error!.length).toBeGreaterThan(10);

        // Should mention the specific issue
        if (file.mimetype !== PDF_MIME) {
          // MIME error should reference the bad MIME type
          expect(result.error!).toContain(file.mimetype);
        } else {
          // Size error should reference the limit
          expect(result.error!.toLowerCase()).toMatch(/20\s*mb|too large|limit/);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
