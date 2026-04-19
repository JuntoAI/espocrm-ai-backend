/**
 * Property-based tests for temporary file cleanup.
 *
 * **Validates: Requirements 8.6**
 *
 * Property 13: Temporary File Cleanup
 * For any PDF file written to temporary storage, the cleanup function should
 * delete the file after the configured timeout (default 5 minutes). After
 * cleanup runs, the file should no longer exist on disk. Files newer than
 * 5 minutes should be preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PDFHandler } from '../../src/services/pdf-handler.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const NUM_RUNS = 100;
const FILE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches pdf-handler.ts

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'file-cleanup-prop-'));
}

async function writeFileAndGetMtime(
  dir: string,
  name: string,
): Promise<{ filePath: string; mtimeMs: number }> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `content-${name}`);
  const stat = await fs.stat(filePath);
  return { filePath, mtimeMs: stat.mtimeMs };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────

/**
 * Age offset strictly greater than 5 minutes → file should be deleted.
 * Range: FILE_TTL_MS + 1ms to 60 minutes.
 */
const oldAgeOffsetArb = fc.integer({
  min: FILE_TTL_MS + 1,
  max: 60 * 60 * 1000,
});

/**
 * Age offset at most 5 minutes → file should be preserved.
 * The implementation uses `ageMs > FILE_TTL_MS` (strict >), so
 * exactly FILE_TTL_MS means the file is NOT deleted.
 * Range: 0ms to FILE_TTL_MS.
 */
const freshAgeOffsetArb = fc.integer({
  min: 0,
  max: FILE_TTL_MS,
});

// ────────────────────────────────────────────────────────────────
// Property tests
// ────────────────────────────────────────────────────────────────

describe('Property 13: Temporary File Cleanup', () => {
  let tempDir: string;
  let handler: PDFHandler;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    handler = new PDFHandler(tempDir);
  });

  afterEach(async () => {
    handler.shutdown();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('deletes files older than 5 minutes', async () => {
    await fc.assert(
      fc.asyncProperty(oldAgeOffsetArb, async (ageOffset) => {
        const { filePath, mtimeMs } = await writeFileAndGetMtime(
          tempDir,
          `old-${ageOffset}.pdf`,
        );

        // "now" is mtime + ageOffset, making the file strictly > 5 min old
        await handler.cleanupOldFiles(mtimeMs + ageOffset);

        expect(await fileExists(filePath)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves files newer than or equal to 5 minutes', async () => {
    await fc.assert(
      fc.asyncProperty(freshAgeOffsetArb, async (ageOffset) => {
        const { filePath, mtimeMs } = await writeFileAndGetMtime(
          tempDir,
          `fresh-${ageOffset}.pdf`,
        );

        // "now" is mtime + ageOffset, making the file <= 5 min old
        await handler.cleanupOldFiles(mtimeMs + ageOffset);

        expect(await fileExists(filePath)).toBe(true);

        // Clean up for next iteration
        await fs.unlink(filePath).catch(() => {});
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('correctly classifies each file based on its age relative to now', async () => {
    // For any set of files and a single "now", each file is deleted iff
    // now - mtime > FILE_TTL_MS, and preserved otherwise.
    // Since all files share ~the same mtime, we generate a single ageOffset
    // and verify the classification is consistent across multiple files.
    let runCounter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 1, max: 5 }),
        async (shouldBeOld, fileCount) => {
          const runId = runCounter++;
          const ageOffset = shouldBeOld
            ? FILE_TTL_MS + 1 + Math.floor(Math.random() * 1000)
            : Math.floor(Math.random() * FILE_TTL_MS);

          const files: string[] = [];
          let refMtime = 0;

          for (let i = 0; i < fileCount; i++) {
            const { filePath, mtimeMs } = await writeFileAndGetMtime(
              tempDir,
              `classify-${runId}-${shouldBeOld}-${i}.pdf`,
            );
            files.push(filePath);
            refMtime = mtimeMs; // All mtimes are ~equal
          }

          await handler.cleanupOldFiles(refMtime + ageOffset);

          for (const filePath of files) {
            if (shouldBeOld) {
              expect(await fileExists(filePath)).toBe(false);
            } else {
              expect(await fileExists(filePath)).toBe(true);
              await fs.unlink(filePath).catch(() => {});
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 15000);

  it('never throws on empty directories', async () => {
    // Clear the temp dir
    const entries = await fs.readdir(tempDir);
    for (const e of entries) {
      await fs.rm(path.join(tempDir, e), { recursive: true, force: true });
    }

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        async (now) => {
          await expect(handler.cleanupOldFiles(now)).resolves.toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws on missing directories', async () => {
    const missingDir = path.join(
      os.tmpdir(),
      `nonexistent-cleanup-${Date.now()}-${Math.random()}`,
    );
    const missingHandler = new PDFHandler(missingDir);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        async (now) => {
          await expect(missingHandler.cleanupOldFiles(now)).resolves.toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );

    missingHandler.shutdown();
  });

  it('skips subdirectories regardless of age', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{1,8}$/),
        oldAgeOffsetArb,
        async (dirName, ageOffset) => {
          const subDir = path.join(tempDir, dirName);
          await fs.mkdir(subDir, { recursive: true });

          const stat = await fs.stat(subDir);
          await handler.cleanupOldFiles(stat.mtimeMs + ageOffset);

          // Subdirectory must survive cleanup
          const dirStat = await fs.stat(subDir);
          expect(dirStat.isDirectory()).toBe(true);

          await fs.rm(subDir, { recursive: true, force: true });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
