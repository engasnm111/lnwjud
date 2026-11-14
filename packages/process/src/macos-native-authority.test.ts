import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MacosNativeAuthority, parseMacosProcessObservation, verifyMacosOwnerReply } from './macos-native-authority.js';
import type { NativeAttemptBinding } from './windows-native-authority.js';

const binding: NativeAttemptBinding = {
  taskId: 'task', reservationId: 'reservation', attemptId: '52f03b8f-71f7-469c-8ee8-81595525e758', generation: 1,
  requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace',
};
const expected = { nonce: 'nonce', requestDigest: 'b'.repeat(64), uid: 501 };

function reply(changes: Record<string, unknown> = {}): { publicKey: Buffer; frame: { payload: string; signature: string } } {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32);
  const payload = Buffer.from(JSON.stringify({ protocol: 1, ...expected, bootId: 'dbaf7777-9d8f-428a-9dd7-20b810e46719',
    result: { state: 'terminal_verified', binding, activeProcesses: 0, outcome: 'completed', exitCode: 0 }, ...changes }));
  return { publicKey, frame: { payload: payload.toString('base64'), signature: sign(null, payload, pair.privateKey).toString('base64') } };
}

describe('macOS enrolled process authority', () => {
  it('accepts a signed reply scoped to the request and authenticated OS user', () => {
    const signed = reply();
    expect(verifyMacosOwnerReply(signed.frame, expected, signed.publicKey)).toMatchObject({ state: 'terminal_verified', binding });
  });

  it.each([{ nonce: 'replayed' }, { requestDigest: 'c'.repeat(64) }, { uid: 502 }, { bootId: 'caller-boot' }])('rejects signed replies in the wrong scope %j', changes => {
    const signed = reply(changes);
    expect(() => verifyMacosOwnerReply(signed.frame, expected, signed.publicKey)).toThrow('MACOS_OWNER_REPLY_SCOPE_MISMATCH');
  });

  it('rejects forged signatures and extra envelope fields', () => {
    const signed = reply();
    expect(() => verifyMacosOwnerReply({ ...signed.frame, signature: Buffer.alloc(64).toString('base64') }, expected, signed.publicKey)).toThrow('MACOS_OWNER_SIGNATURE_INVALID');
    expect(() => verifyMacosOwnerReply({ ...signed.frame, available: true }, expected, signed.publicKey)).toThrow('MACOS_OWNER_REPLY_INVALID');
  });

  it('does not turn a changed binding or incomplete terminal observation into zero-process proof', () => {
    const terminal = { state: 'terminal_verified', binding, activeProcesses: 0, outcome: 'completed', exitCode: 0 };
    expect(parseMacosProcessObservation({ ...terminal, binding: { ...binding, ownerSessionId: 'different' } }, binding).state).toBe('termination_unknown');
    expect(parseMacosProcessObservation({ ...terminal, activeProcesses: 1 }, binding).state).toBe('termination_unknown');
    expect(parseMacosProcessObservation({ ...terminal, persisted: true }, binding).state).toBe('termination_unknown');
  });

  it('does not admit work when the enrolled daemon is unavailable', async () => {
    const authority = new MacosNativeAuthority({ request: async (): Promise<never> => { throw new Error('not enrolled'); } });
    expect(await authority.available()).toBe(false);
    expect(await authority.register(binding)).toBe(false);
    expect(await authority.abortBeforeLaunch({ binding })).toMatchObject({ state: 'termination_unknown' });
  });

  it('sends the exact command only after native reservation preparation', async () => {
    const calls: string[] = [];
    const authority = new MacosNativeAuthority({ request: async (request): Promise<unknown> => {
      calls.push(request.command);
      if (request.command === 'prepare') return { state: 'termination_unknown', binding, reason: 'MACOS_ATTEMPT_PREPARED' };
      expect(request.operation).toMatchObject({ executable: '/bin/echo', args: ['hello'], cwd: '/tmp' });
      return { state: 'running', binding, targetPid: 20 };
    } });
    expect((await authority.submitProcess({ binding, executable: '/bin/echo', args: ['hello'], cwd: '/tmp', timeoutMs: 1000 })).observation.state).toBe('running');
    expect(calls).toEqual(['prepare', 'run']);
  });

  it('does not retry an ambiguous submission', async () => {
    const calls: string[] = [];
    const authority = new MacosNativeAuthority({ request: async (request): Promise<unknown> => {
      calls.push(request.command);
      if (request.command === 'prepare') return { state: 'termination_unknown', binding, reason: 'MACOS_ATTEMPT_PREPARED' };
      throw new Error('lost response');
    } });
    const result = await authority.submitProcess({ binding, executable: '/bin/echo', args: ['hello'], cwd: '/tmp', timeoutMs: 1000 });
    expect(result.observation).toMatchObject({ state: 'termination_unknown' });
    expect(calls).toEqual(['prepare', 'run']);
  });
});
