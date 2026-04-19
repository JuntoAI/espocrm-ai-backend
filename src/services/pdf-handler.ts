/**
 * PDF upload handler for the AI Backend.
 *
 * Handles multipart PDF uploads via multer, stores files temporarily
 * with UUID filenames, provides file content for Gemini multimodal
 * text extraction, stores extracted text in session pdfContext,
 * and manages automatic cleanup of temporary files.
 *
 * @module pdf-handler
 */

import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import type { SessionManager } from './session-manager.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const PDF_MIME_TYPE = 'application/pdf';
const DEFAULT_UPLOAD_DIR = '/tmp/uploads';
const FILE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Minimal file descriptor for validation and processing. */
export interface UploadedFile {
  /** Original filename from the uploader. */
  originalname: string;
  /** MIME type from the Content-Type header. */
  mimetype: string;
  /** File size in bytes. */
  size: number;
  /** Full path to the file on disk (set after storage). */
  path: string;
  /** Filename on disk (UUID-based). */
  filename: string;
}

/** Result of a successful PDF upload and text extraction. */
export interface PDFUploadResult {
  /** Extracted text content from the PDF. */
  extractedText: string;
  /** Original filename. */
  originalFilename: string;
  /** UUID-based filename on disk. */
  storedFilename: string;
}

/** Validation result for an uploaded file. */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Callback for extracting text from a PDF buffer (injected dependency). */
export type TextExtractor = (
  fileBuffer: Buffer,
  mimeType: string,
) => Promise<string>;

// ────────────────────────────────────────────────────────────────
// Standalone validation (exported for independent testing)
// ────────────────────────────────────────────────────────────────

/**
 * Validate a file for PDF upload requirements.
 *
 * Checks:
 * - MIME type must be `application/pdf`
 * - Size must not exceed 20 MB
 *
 * @param file  Object with at least `mimetype` and `size` fields.
 * @returns     Validation result with `valid` flag and optional `error` message.
 */
export function validatePDFFile(file: {
  mimetype: string;
  size: number;
}): ValidationResult {
  if (file.mimetype !== PDF_MIME_TYPE) {
    return {
      valid: false,
      error: `Invalid file type: expected application/pdf, got ${file.mimetype}`,
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File too large: ${sizeMB} MB exceeds the 20 MB limit`,
    };
  }

  return { valid: true };
}

// ────────────────────────────────────────────────────────────────
// Multer configuration factory
// ────────────────────────────────────────────────────────────────

/**
 * Create a configured multer middleware for single PDF file uploads.
 *
 * Uses disk storage with UUID filenames in the specified upload directory.
 * Rejects non-PDF files at the multer level via `fileFilter`.
 *
 * @param uploadDir  Directory for temporary file storage. Defaults to `/tmp/uploads`.
 * @returns          Multer middleware for `single('file')` uploads.
 */
export function createMulterUpload(uploadDir: string = DEFAULT_UPLOAD_DIR) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${uuidv4()}.pdf`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
    },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype !== PDF_MIME_TYPE) {
        cb(new Error(`Invalid file type: expected application/pdf, got ${file.mimetype}`));
        return;
      }
      cb(null, true);
    },
  });
}

// ────────────────────────────────────────────────────────────────
// PDFHandler class
// ────────────────────────────────────────────────────────────────

/**
 * Manages PDF file uploads, text extraction, session context storage,
 * and automatic temporary file cleanup.
 */
export class PDFHandler {
  private readonly uploadDir: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly scheduledDeletions: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  constructor(uploadDir: string = DEFAULT_UPLOAD_DIR) {
    this.uploadDir = uploadDir;
  }

  /**
   * Ensure the upload directory exists.
   */
  async ensureUploadDir(): Promise<void> {
    await fs.mkdir(this.uploadDir, { recursive: true });
  }

  /**
   * Handle a PDF file upload: validate, extract text, store in session.
   *
   * @param file            The uploaded file descriptor (from multer or manual).
   * @param sessionManager  Session manager to store PDF context.
   * @param userId          User ID for session lookup.
   * @param extractText     Callback to extract text from the PDF buffer.
   *                        This is typically the Gemini multimodal service.
   * @returns               Upload result with extracted text.
   * @throws                Error if validation fails or text extraction fails.
   */
  async handleUpload(
    file: UploadedFile,
    sessionManager: SessionManager,
    userId: string,
    extractText: TextExtractor,
  ): Promise<PDFUploadResult> {
    // Validate the file
    const validation = validatePDFFile(file);
    if (!validation.valid) {
      // Clean up the file if it was already written to disk
      await this.safeDelete(file.path);
      throw new Error(validation.error);
    }

    let extractedText: string;

    try {
      // Read the file from disk
      const fileBuffer = await fs.readFile(file.path);

      // Extract text via the injected extractor (Gemini multimodal)
      extractedText = await extractText(fileBuffer, file.mimetype);
    } catch (err) {
      // Clean up on extraction failure
      await this.safeDelete(file.path);
      throw err;
    }

    // Store extracted text in session's pdfContext
    sessionManager.setPdfContext(userId, {
      filename: file.originalname,
      extractedText,
      uploadedAt: new Date(),
    });

    // Schedule file deletion after 5 minutes
    this.scheduleFileDeletion(file.path);

    logger.info('PDFHandler: upload processed', {
      userId,
      originalFilename: file.originalname,
      storedFilename: file.filename,
      extractedLength: extractedText.length,
    });

    return {
      extractedText,
      originalFilename: file.originalname,
      storedFilename: file.filename,
    };
  }

  /**
   * Start the background cleanup interval that scans the upload directory
   * every minute for files older than 5 minutes.
   */
  startCleanup(): void {
    if (this.cleanupTimer !== null) {
      return; // Already running
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupOldFiles();
    }, CLEANUP_INTERVAL_MS);

    // Allow Node.js to exit even if the interval is active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    logger.info('PDFHandler: background cleanup started', {
      intervalMs: CLEANUP_INTERVAL_MS,
      ttlMs: FILE_TTL_MS,
    });
  }

  /**
   * Stop the background cleanup interval and cancel all scheduled deletions.
   * Call this during graceful shutdown.
   */
  shutdown(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Cancel all scheduled individual deletions
    for (const [filePath, timer] of this.scheduledDeletions) {
      clearTimeout(timer);
      this.scheduledDeletions.delete(filePath);
    }

    logger.info('PDFHandler: shutdown complete');
  }

  /**
   * Scan the upload directory and delete files older than FILE_TTL_MS.
   *
   * @param now  Current timestamp in ms (injectable for testing).
   */
  async cleanupOldFiles(now: number = Date.now()): Promise<void> {
    try {
      const entries = await fs.readdir(this.uploadDir);

      for (const entry of entries) {
        const filePath = path.join(this.uploadDir, entry);

        try {
          const stat = await fs.stat(filePath);

          if (!stat.isFile()) {
            continue;
          }

          const ageMs = now - stat.mtimeMs;
          if (ageMs > FILE_TTL_MS) {
            await fs.unlink(filePath);
            logger.debug('PDFHandler: cleaned up old file', {
              file: entry,
              ageMs,
            });
          }
        } catch (fileErr) {
          // File may have been deleted between readdir and stat — ignore
          logger.debug('PDFHandler: cleanup skip', {
            file: entry,
            error: fileErr instanceof Error ? fileErr.message : String(fileErr),
          });
        }
      }
    } catch (dirErr) {
      // Upload directory may not exist yet — that's fine
      if ((dirErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('PDFHandler: cleanup error', {
          error: dirErr instanceof Error ? dirErr.message : String(dirErr),
        });
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Schedule a file for deletion after FILE_TTL_MS.
   */
  private scheduleFileDeletion(filePath: string): void {
    const timer = setTimeout(() => {
      this.scheduledDeletions.delete(filePath);
      void this.safeDelete(filePath);
    }, FILE_TTL_MS);

    // Allow Node.js to exit even if the timeout is pending
    if (timer.unref) {
      timer.unref();
    }

    this.scheduledDeletions.set(filePath, timer);
  }

  /**
   * Delete a file, ignoring ENOENT (already deleted).
   */
  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      logger.debug('PDFHandler: deleted file', { file: filePath });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('PDFHandler: failed to delete file', {
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
