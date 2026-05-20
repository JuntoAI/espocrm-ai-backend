/**
 * Per-user configuration store with JSON file persistence.
 *
 * Each user's config is stored as a JSON file at `{storagePath}/{userId}.json`.
 * Missing files return all defaults. Validation enforces integer bounds.
 *
 * @module user-config-store
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Per-user proactive agent configuration. */
export interface UserConfig {
  /** Engagement decay threshold in days (1-90). */
  engagementDecayDays: number;
  /** Activity window duration in days (1-30). */
  activityWindowDays: number;
}

/** Validation result for partial config updates. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Default configuration values applied when no user config exists. */
export const USER_CONFIG_DEFAULTS: UserConfig = {
  engagementDecayDays: 14,
  activityWindowDays: 7,
};

/**
 * Sanitize a userId to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function sanitizeUserId(userId: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized.length === 0) {
    throw new Error('Invalid userId: must contain at least one alphanumeric character, hyphen, or underscore');
  }
  return sanitized;
}

/**
 * Persists per-user proactive agent configuration to disk as JSON files.
 *
 * Storage layout: `{storagePath}/{userId}.json`
 * Missing file = all defaults (no error).
 * Validates integer bounds on write.
 */
export class UserConfigStore {
  private readonly storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /**
   * Get the full config for a user, merging stored values with defaults.
   * Returns all defaults if the user has no stored config.
   */
  async get(userId: string): Promise<UserConfig> {
    const filePath = this.getFilePath(userId);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const stored = JSON.parse(raw) as Partial<UserConfig>;
      return this.mergeWithDefaults(stored);
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
        return { ...USER_CONFIG_DEFAULTS };
      }
      throw err;
    }
  }

  /**
   * Validate and persist a partial config update for a user.
   * Merges the partial update with the existing config and writes to disk.
   *
   * @throws Error if validation fails.
   * @returns The full merged config after the update.
   */
  async set(userId: string, partial: Partial<UserConfig>): Promise<UserConfig> {
    const validation = this.validate(partial);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
    }

    await this.ensureStorageDir();

    const existing = await this.get(userId);
    const merged: UserConfig = { ...existing, ...partial };

    const filePath = this.getFilePath(userId);
    await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');

    return merged;
  }

  /**
   * Validate a partial config update.
   * Checks that provided fields are integers within allowed bounds.
   */
  validate(partial: Partial<UserConfig>): ValidationResult {
    const errors: string[] = [];

    if (partial.engagementDecayDays !== undefined) {
      if (!Number.isInteger(partial.engagementDecayDays)) {
        errors.push('engagementDecayDays must be an integer');
      } else if (partial.engagementDecayDays < 1 || partial.engagementDecayDays > 90) {
        errors.push('engagementDecayDays must be between 1 and 90');
      }
    }

    if (partial.activityWindowDays !== undefined) {
      if (!Number.isInteger(partial.activityWindowDays)) {
        errors.push('activityWindowDays must be an integer');
      } else if (partial.activityWindowDays < 1 || partial.activityWindowDays > 30) {
        errors.push('activityWindowDays must be between 1 and 30');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Construct the file path for a user's config, with sanitization.
   */
  private getFilePath(userId: string): string {
    const safe = sanitizeUserId(userId);
    return path.join(this.storagePath, `${safe}.json`);
  }

  /**
   * Ensure the storage directory exists, creating it recursively if needed.
   */
  private async ensureStorageDir(): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
  }

  /**
   * Merge a partial stored config with defaults, ensuring all fields are present.
   */
  private mergeWithDefaults(stored: Partial<UserConfig>): UserConfig {
    return {
      engagementDecayDays: typeof stored.engagementDecayDays === 'number'
        ? stored.engagementDecayDays
        : USER_CONFIG_DEFAULTS.engagementDecayDays,
      activityWindowDays: typeof stored.activityWindowDays === 'number'
        ? stored.activityWindowDays
        : USER_CONFIG_DEFAULTS.activityWindowDays,
    };
  }
}

/** Check if an error is a file-not-found error (ENOENT). */
function isFileNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === 'ENOENT';
  }
  return false;
}
