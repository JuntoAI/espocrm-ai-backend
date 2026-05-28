/**
 * Knowledge Store — persistent context injection for the AI Backend.
 *
 * Loads knowledge documents from two sources:
 *   1. Global knowledge (shared across all users): `{storagePath}/global/`
 *   2. Per-user knowledge (personal DNA, preferences): `{storagePath}/users/{userId}/`
 *
 * Supported file types: .md, .txt (loaded as-is)
 * PDF support: .pdf files are stored but text must be pre-extracted
 * into a companion .md file (e.g., pitch-deck.pdf → pitch-deck.md).
 *
 * Files are loaded into memory at startup and refreshed periodically.
 * The combined text is injected into the Gemini system prompt.
 *
 * Storage layout:
 *   {storagePath}/
 *   ├── global/                    ← shared knowledge (pitch deck, company info)
 *   │   ├── juntoai-pitch.md
 *   │   ├── investment-criteria.md
 *   │   └── ...
 *   └── users/                     ← per-user knowledge (personal DNA)
 *       ├── {userId}/
 *       │   ├── personal-dna.md
 *       │   └── communication-style.md
 *       └── ...
 *
 * @module knowledge-store
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** A loaded knowledge document. */
export interface KnowledgeDocument {
  /** Original filename. */
  filename: string;
  /** Full file path on disk. */
  filePath: string;
  /** Text content of the document. */
  content: string;
  /** File size in bytes. */
  size: number;
  /** Last modified timestamp. */
  lastModified: Date;
}

/** Summary of loaded knowledge for logging/health checks. */
export interface KnowledgeSummary {
  globalDocCount: number;
  globalTotalChars: number;
  userDocCount: number;
  userTotalChars: number;
  globalFiles: string[];
  userFiles: string[];
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Supported text file extensions. */
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt']);

/** Maximum size per file (500 KB — keeps token usage reasonable). */
const MAX_FILE_SIZE_BYTES = 500 * 1024;

/** Refresh interval for reloading files (5 minutes). */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum total knowledge size per category to prevent token explosion. */
const MAX_TOTAL_CHARS = 100_000; // ~25k tokens

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Sanitize a userId to prevent path traversal.
 */
function sanitizeUserId(userId: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized.length === 0) {
    throw new Error('Invalid userId for knowledge store');
  }
  return sanitized;
}

/**
 * Check if a file has a supported extension.
 */
function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Load all supported text files from a directory.
 * Returns empty array if directory doesn't exist.
 */
async function loadDirectory(dirPath: string): Promise<KnowledgeDocument[]> {
  const docs: KnowledgeDocument[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !isSupportedFile(entry.name)) {
        continue;
      }

      const filePath = path.join(dirPath, entry.name);

      try {
        const stat = await fs.stat(filePath);

        if (stat.size > MAX_FILE_SIZE_BYTES) {
          logger.warn('Knowledge file too large, skipping', {
            file: entry.name,
            size: stat.size,
            maxSize: MAX_FILE_SIZE_BYTES,
          });
          continue;
        }

        const content = await fs.readFile(filePath, 'utf-8');

        docs.push({
          filename: entry.name,
          filePath,
          content: content.trim(),
          size: stat.size,
          lastModified: stat.mtime,
        });
      } catch (err) {
        logger.warn('Failed to read knowledge file', {
          file: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Directory doesn't exist — that's fine, return empty
    if (isNotFoundError(err)) {
      return [];
    }
    throw err;
  }

  // Sort by filename for deterministic ordering
  docs.sort((a, b) => a.filename.localeCompare(b.filename));

  return docs;
}

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === 'ENOENT';
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// KnowledgeStore
// ────────────────────────────────────────────────────────────────

/**
 * Manages persistent knowledge documents for system prompt injection.
 *
 * Usage:
 *   const store = new KnowledgeStore('/data/knowledge');
 *   await store.initialize();
 *   const context = await store.getContextForUser(userId);
 *   // Append `context` to the system prompt
 */
export class KnowledgeStore {
  private readonly storagePath: string;
  private globalDocs: KnowledgeDocument[] = [];
  private globalContext: string = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /**
   * Load global knowledge files at startup.
   * Creates the directory structure if it doesn't exist.
   */
  async initialize(): Promise<void> {
    // Ensure directory structure exists
    const globalDir = path.join(this.storagePath, 'global');
    const usersDir = path.join(this.storagePath, 'users');

    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(usersDir, { recursive: true });

    // Load global knowledge
    await this.refreshGlobal();

    logger.info('KnowledgeStore: initialized', {
      storagePath: this.storagePath,
      globalDocs: this.globalDocs.length,
      globalChars: this.globalContext.length,
      globalFiles: this.globalDocs.map((d) => d.filename),
    });
  }

  /**
   * Start periodic refresh of global knowledge files.
   */
  startRefresh(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshGlobal();
      } catch (err) {
        logger.error('KnowledgeStore: refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, REFRESH_INTERVAL_MS);

    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  /**
   * Stop the periodic refresh (for graceful shutdown).
   */
  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Get the combined knowledge context for a specific user.
   *
   * Returns a formatted string containing:
   *   1. Global knowledge (company info, pitch deck, etc.)
   *   2. User-specific knowledge (personal DNA, communication style)
   *
   * Returns empty string if no knowledge is available.
   */
  async getContextForUser(userId: string): Promise<string> {
    const sections: string[] = [];

    // Global knowledge (cached in memory)
    if (this.globalContext.length > 0) {
      sections.push(this.globalContext);
    }

    // Per-user knowledge (loaded on demand)
    const userContext = await this.loadUserContext(userId);
    if (userContext.length > 0) {
      sections.push(userContext);
    }

    if (sections.length === 0) {
      return '';
    }

    return sections.join('\n\n');
  }

  /**
   * Get a summary of loaded knowledge (for health/debug endpoints).
   */
  async getSummary(userId?: string): Promise<KnowledgeSummary> {
    const userDocs = userId ? await this.loadUserDocs(userId) : [];

    return {
      globalDocCount: this.globalDocs.length,
      globalTotalChars: this.globalContext.length,
      userDocCount: userDocs.length,
      userTotalChars: userDocs.reduce((sum, d) => sum + d.content.length, 0),
      globalFiles: this.globalDocs.map((d) => d.filename),
      userFiles: userDocs.map((d) => d.filename),
    };
  }

  /**
   * List all knowledge documents with content previews.
   * Used by the list_knowledge tool.
   */
  async listDocuments(userId: string): Promise<{
    global: Array<{ filename: string; chars: number; preview: string }>;
    personal: Array<{ filename: string; chars: number; preview: string }>;
  }> {
    const userDocs = await this.loadUserDocs(userId);

    return {
      global: this.globalDocs.map((d) => ({
        filename: d.filename,
        chars: d.content.length,
        preview: d.content.slice(0, 200) + (d.content.length > 200 ? '…' : ''),
      })),
      personal: userDocs.map((d) => ({
        filename: d.filename,
        chars: d.content.length,
        preview: d.content.slice(0, 200) + (d.content.length > 200 ? '…' : ''),
      })),
    };
  }

  /**
   * Write (create or overwrite) a knowledge document.
   * Used by the update_knowledge tool.
   */
  async writeDocument(
    scope: 'global' | 'personal',
    filename: string,
    content: string,
    userId?: string,
  ): Promise<{ success: boolean; filePath: string; chars: number }> {
    // Sanitize filename
    const safeName = this.sanitizeFilename(filename);
    const dir = scope === 'global'
      ? path.join(this.storagePath, 'global')
      : path.join(this.storagePath, 'users', sanitizeUserId(userId!));

    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, content.trim(), 'utf-8');

    // Refresh global cache if we wrote to global
    if (scope === 'global') {
      await this.refreshGlobal();
    }

    logger.info('KnowledgeStore: document written', {
      scope,
      filename: safeName,
      chars: content.length,
      userId: userId ?? 'n/a',
    });

    return { success: true, filePath, chars: content.trim().length };
  }

  /**
   * Delete a knowledge document.
   * Used by the delete_knowledge tool.
   */
  async deleteDocument(
    scope: 'global' | 'personal',
    filename: string,
    userId?: string,
  ): Promise<{ success: boolean; deleted: string }> {
    const safeName = this.sanitizeFilename(filename);
    const dir = scope === 'global'
      ? path.join(this.storagePath, 'global')
      : path.join(this.storagePath, 'users', sanitizeUserId(userId!));

    const filePath = path.join(dir, safeName);

    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (isNotFoundError(err)) {
        return { success: false, deleted: `File not found: ${safeName}` };
      }
      throw err;
    }

    // Refresh global cache if we deleted from global
    if (scope === 'global') {
      await this.refreshGlobal();
    }

    logger.info('KnowledgeStore: document deleted', {
      scope,
      filename: safeName,
      userId: userId ?? 'n/a',
    });

    return { success: true, deleted: safeName };
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Sanitize a filename to prevent path traversal and ensure .md extension.
   */
  private sanitizeFilename(filename: string): string {
    // Remove any path separators and dangerous characters
    let safe = filename.replace(/[/\\:*?"<>|]/g, '').trim();

    // Remove leading dots (hidden files / traversal)
    safe = safe.replace(/^\.+/, '');

    // Ensure .md extension
    if (!safe.endsWith('.md') && !safe.endsWith('.txt')) {
      safe = safe + '.md';
    }

    if (safe.length === 0 || safe === '.md' || safe === '.txt') {
      throw new Error('Invalid filename');
    }

    return safe;
  }

  /**
   * Reload global knowledge files from disk.
   */
  private async refreshGlobal(): Promise<void> {
    const globalDir = path.join(this.storagePath, 'global');
    this.globalDocs = await loadDirectory(globalDir);
    this.globalContext = this.buildContextSection(
      'Company & Business Knowledge',
      this.globalDocs,
    );
  }

  /**
   * Load per-user knowledge documents.
   */
  private async loadUserDocs(userId: string): Promise<KnowledgeDocument[]> {
    const safe = sanitizeUserId(userId);
    const userDir = path.join(this.storagePath, 'users', safe);
    return await loadDirectory(userDir);
  }

  /**
   * Load and format per-user knowledge context.
   */
  private async loadUserContext(userId: string): Promise<string> {
    const docs = await this.loadUserDocs(userId);
    if (docs.length === 0) return '';

    return this.buildContextSection(
      'Personal Context (About the Current User)',
      docs,
    );
  }

  /**
   * Build a formatted context section from a list of documents.
   * Truncates if total content exceeds MAX_TOTAL_CHARS.
   */
  private buildContextSection(
    heading: string,
    docs: KnowledgeDocument[],
  ): string {
    if (docs.length === 0) return '';

    const parts: string[] = [`## ${heading}\n`];
    let totalChars = 0;

    for (const doc of docs) {
      if (totalChars + doc.content.length > MAX_TOTAL_CHARS) {
        parts.push(
          `\n[Truncated: remaining documents skipped to stay within context limits]`,
        );
        break;
      }

      // Use filename (without extension) as a sub-heading
      const name = path.basename(doc.filename, path.extname(doc.filename));
      const label = name.replace(/[-_]/g, ' ');
      parts.push(`### ${label}\n\n${doc.content}\n`);
      totalChars += doc.content.length;
    }

    return parts.join('\n');
  }
}
