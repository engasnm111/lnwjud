import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateWindowsProtectedKey, protectWithWindowsDpapi, unprotectWithWindowsDpapi } from './windows-dpapi.js';

describe.runIf(process.platform === 'win32')('Windows DPAPI helpers', () => {
  it('round-trips UTF-8 text through direct Windows DPAPI', () => {
    const plaintext = 'lnwjud-dpapi-ทดสอบ-' + Date.now();
    const protectedValue = protectWithWindowsDpapi(plaintext);
    expect(protectedValue).not.toContain(plaintext);
    expect(unprotectWithWindowsDpapi(protectedValue)).toBe(plaintext);
  }, 15_000);

  it('persists a v2 protected key and reuses the same key', async () => {
    const filePath = path.join(os.tmpdir(), 'lnwjud-dpapi-' + process.pid + '-' + Date.now() + '.key');
    try {
      const first = loadOrCreateWindowsProtectedKey(filePath, 32);
      const stored = await readFile(filePath, 'utf8');
      expect(stored).toMatch(/^dpapi:v2:/);
      expect(loadOrCreateWindowsProtectedKey(filePath, 32)).toEqual(first);
    } finally {
      await rm(filePath, { force: true });
    }
  }, 15_000);
});

describe.runIf(process.platform !== 'win32')('Non-Windows protected key helpers', () => {
  it('persists a raw:v1: key and reuses the same key', async () => {
    const filePath = path.join(os.tmpdir(), 'lnwjud-raw-key-' + process.pid + '-' + Date.now() + '.key');
    try {
      const first = loadOrCreateWindowsProtectedKey(filePath, 32);
      const stored = await readFile(filePath, 'utf8');
      expect(stored).toMatch(/^raw:v1:/);
      expect(loadOrCreateWindowsProtectedKey(filePath, 32)).toEqual(first);
    } finally {
      await rm(filePath, { force: true });
    }
  });
});
