import { describe, expect, it } from 'vitest';
import { EnvironmentCheckpointEncryptionKeyProvider, loadCheckpointEncryptionKey, selectCheckpointEncryptionKeyProvider } from './checkpoint-key-provider.js';

describe('checkpoint encryption key provider', () => {
  it('accepts an explicit 32-byte injected key on every platform', () => {
    const encoded = Buffer.alloc(32, 7).toString('base64');
    const environment = { LNWJUD_CHECKPOINT_KEY_BASE64: encoded } as NodeJS.ProcessEnv;
    expect(selectCheckpointEncryptionKeyProvider('linux', environment).providerId).toBe('environment-injected-key');
    expect(loadCheckpointEncryptionKey('/tmp/lnwjud', 'darwin', environment)).toEqual(Buffer.alloc(32, 7));
  });

  it('rejects invalid injected keys', () => {
    const provider = new EnvironmentCheckpointEncryptionKeyProvider({ LNWJUD_CHECKPOINT_KEY_BASE64: Buffer.alloc(8).toString('base64') });
    expect(() => provider.load('/tmp/lnwjud')).toThrow('32 bytes');
  });

  it('fails closed on non-Windows hosts when no secure provider is configured', () => {
    expect(() => selectCheckpointEncryptionKeyProvider('linux', {})).toThrow('Secure checkpoint key storage is unavailable');
    expect(() => selectCheckpointEncryptionKeyProvider('darwin', {})).toThrow('Secure checkpoint key storage is unavailable');
  });
});
