/**
 * Unit tests for UserConfigStore.
 * Tests specific examples and edge cases for JSON file persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserConfigStore, USER_CONFIG_DEFAULTS } from '../../src/services/user-config-store.js';

describe('UserConfigStore', () => {
  let storagePath: string;
  let store: UserConfigStore;

  beforeEach(async () => {
    storagePath = path.join(os.tmpdir(), `user-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = new UserConfigStore(storagePath);
  });

  afterEach(async () => {
    try {
      await fs.rm(storagePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('get()', () => {
    it('returns all defaults when no config file exists', async () => {
      const config = await store.get('nonexistent-user');
      expect(config).toEqual(USER_CONFIG_DEFAULTS);
    });

    it('returns stored values merged with defaults', async () => {
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(
        path.join(storagePath, 'user1.json'),
        JSON.stringify({ engagementDecayDays: 21 }),
        'utf-8'
      );

      const config = await store.get('user1');
      expect(config.engagementDecayDays).toBe(21);
      expect(config.activityWindowDays).toBe(USER_CONFIG_DEFAULTS.activityWindowDays);
    });

    it('returns defaults for fields with non-numeric stored values', async () => {
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(
        path.join(storagePath, 'user2.json'),
        JSON.stringify({ engagementDecayDays: 'invalid', activityWindowDays: 10 }),
        'utf-8'
      );

      const config = await store.get('user2');
      expect(config.engagementDecayDays).toBe(USER_CONFIG_DEFAULTS.engagementDecayDays);
      expect(config.activityWindowDays).toBe(10);
    });

    it('sanitizes userId to prevent path traversal', async () => {
      // Should strip path traversal characters
      const config = await store.get('../../../etc/passwd');
      expect(config).toEqual(USER_CONFIG_DEFAULTS);
    });

    it('throws on empty userId after sanitization', async () => {
      await expect(store.get('../../..')).rejects.toThrow('Invalid userId');
    });
  });

  describe('set()', () => {
    it('persists a partial update and returns full config', async () => {
      const result = await store.set('user1', { engagementDecayDays: 30 });
      expect(result.engagementDecayDays).toBe(30);
      expect(result.activityWindowDays).toBe(USER_CONFIG_DEFAULTS.activityWindowDays);

      // Verify persistence
      const readBack = await store.get('user1');
      expect(readBack).toEqual(result);
    });

    it('merges with existing config on subsequent updates', async () => {
      await store.set('user1', { engagementDecayDays: 30 });
      const result = await store.set('user1', { activityWindowDays: 14 });

      expect(result.engagementDecayDays).toBe(30);
      expect(result.activityWindowDays).toBe(14);
    });

    it('creates storage directory if it does not exist', async () => {
      const deepPath = path.join(storagePath, 'nested', 'dir');
      const deepStore = new UserConfigStore(deepPath);

      await deepStore.set('user1', { engagementDecayDays: 20 });

      const stat = await fs.stat(deepPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('throws on invalid engagementDecayDays (too low)', async () => {
      await expect(store.set('user1', { engagementDecayDays: 0 }))
        .rejects.toThrow('engagementDecayDays must be between 1 and 90');
    });

    it('throws on invalid engagementDecayDays (too high)', async () => {
      await expect(store.set('user1', { engagementDecayDays: 91 }))
        .rejects.toThrow('engagementDecayDays must be between 1 and 90');
    });

    it('throws on invalid activityWindowDays (too low)', async () => {
      await expect(store.set('user1', { activityWindowDays: 0 }))
        .rejects.toThrow('activityWindowDays must be between 1 and 30');
    });

    it('throws on invalid activityWindowDays (too high)', async () => {
      await expect(store.set('user1', { activityWindowDays: 31 }))
        .rejects.toThrow('activityWindowDays must be between 1 and 30');
    });

    it('throws on non-integer engagementDecayDays', async () => {
      await expect(store.set('user1', { engagementDecayDays: 14.5 }))
        .rejects.toThrow('engagementDecayDays must be an integer');
    });

    it('throws on non-integer activityWindowDays', async () => {
      await expect(store.set('user1', { activityWindowDays: 7.5 }))
        .rejects.toThrow('activityWindowDays must be an integer');
    });

    it('does not modify stored config when validation fails', async () => {
      await store.set('user1', { engagementDecayDays: 21, activityWindowDays: 10 });

      await expect(store.set('user1', { engagementDecayDays: 100 })).rejects.toThrow();

      const config = await store.get('user1');
      expect(config.engagementDecayDays).toBe(21);
      expect(config.activityWindowDays).toBe(10);
    });

    it('accepts boundary values (min)', async () => {
      const result = await store.set('user1', { engagementDecayDays: 1, activityWindowDays: 1 });
      expect(result.engagementDecayDays).toBe(1);
      expect(result.activityWindowDays).toBe(1);
    });

    it('accepts boundary values (max)', async () => {
      const result = await store.set('user1', { engagementDecayDays: 90, activityWindowDays: 30 });
      expect(result.engagementDecayDays).toBe(90);
      expect(result.activityWindowDays).toBe(30);
    });

    it('accepts empty partial update (no-op)', async () => {
      const result = await store.set('user1', {});
      expect(result).toEqual(USER_CONFIG_DEFAULTS);
    });
  });

  describe('validate()', () => {
    it('returns valid for empty partial', () => {
      const result = store.validate({});
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid for values within bounds', () => {
      const result = store.validate({ engagementDecayDays: 45, activityWindowDays: 15 });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns multiple errors for multiple invalid fields', () => {
      const result = store.validate({ engagementDecayDays: 0, activityWindowDays: 31 });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('rejects NaN', () => {
      const result = store.validate({ engagementDecayDays: NaN });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('integer');
    });

    it('rejects Infinity', () => {
      const result = store.validate({ activityWindowDays: Infinity });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('integer');
    });
  });
});
