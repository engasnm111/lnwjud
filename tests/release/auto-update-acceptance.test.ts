import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUpdateAcceptanceReceipt, validateUpdateAcceptanceReceipt, verifyUpdateAcceptanceForRelease } from '../../apps/desktop/scripts/verify-update-acceptance.mjs';

const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);

type UpdatePlatform = 'win32' | 'darwin';
type UpdateArchitecture = 'x64' | 'arm64';
type MutableAcceptanceReceipt = {
  [key: string]: unknown;
  platform: UpdatePlatform;
  workflow: { [key: string]: unknown; runId: string; runAttempt: string };
  sourceCommit: string;
  confirmation: { [key: string]: unknown; version: string; accepted: boolean; promptCount: number };
  signing: { [key: string]: unknown; status?: string; mode?: string };
  install: { [key: string]: unknown; health: string; tunnel: string; mode: string; interactivePrompts: number };
  rollback: {
    [key: string]: unknown;
    restoredInstallSha256: string;
    injectedFailure: string;
    processRestarted: boolean;
  };
};
type AcceptanceFixture = {
  receipt: MutableAcceptanceReceipt;
  provenance: Record<string, unknown>;
  context: { expectedRunId: string; expectedRunAttempt: string; expectedCommit: string };
};

describe('automatic updater release gate', () => {
  it('keeps the current manual-install release separate from the future authenticated auto-update receipt contract', async () => {
    const workflow = await readFile(releaseWorkflowUrl, 'utf8');

    expect(workflow).toContain('--json databaseId,attempt,headSha,status,conclusion');
    expect(workflow).toContain('candidate_id candidate_attempt candidate_status candidate_conclusion');
    expect(workflow).toContain('run_attempt="$candidate_attempt"');
    expect(workflow).not.toContain('signed-update-e2e-win32-x64-$sha-run-$run_id-attempt-$run_attempt');
    expect(workflow).not.toContain('signed-update-e2e-darwin-arm64-$sha-run-$run_id-attempt-$run_attempt');
    expect(workflow).not.toContain('signed-update-e2e-darwin-x64-$sha-run-$run_id-attempt-$run_attempt');
    expect(workflow).toContain('node scripts/verify-manual-release-scope.mjs');
    expect(workflow).toContain("printf 'LNWJUD_RELEASE_CI_RUN_ID=%s\\n' \"$run_id\"");
    expect(workflow).toContain("printf 'LNWJUD_RELEASE_CI_RUN_ATTEMPT=%s\\n' \"$run_attempt\"");
    expect(workflow).not.toContain('if [[ "$platform" == win32 || "$platform" == darwin ]]; then');
    expect(workflow).not.toContain('Expected one update-acceptance.json for $key');
    expect(workflow).toContain("LNWJUD_REQUIRE_UPDATE_ACCEPTANCE='0'");
    expect(workflow).not.toContain('LNWJUD_UPDATE_ACCEPTANCE_FILE="$acceptance_file"');
    expect(workflow).not.toContain('LNWJUD_UPDATE_ACCEPTANCE_RUN_ID="$LNWJUD_RELEASE_CI_RUN_ID"');
    expect(workflow).not.toContain('LNWJUD_UPDATE_ACCEPTANCE_RUN_ATTEMPT="$LNWJUD_RELEASE_CI_RUN_ATTEMPT"');
  });

  it.each([
    ['Windows x64', 'win32', 'x64'],
    ['macOS arm64', 'darwin', 'arm64'],
    ['macOS x64', 'darwin', 'x64'],
  ])('accepts a complete installed-update and rollback receipt for %s', (_label: string, platform: UpdatePlatform, arch: UpdateArchitecture): void => {
    const { receipt, provenance, context } = fixture(platform, arch);
    expect(() => validateUpdateAcceptanceReceipt(receipt, { ...context, provenance })).not.toThrow();
  });

  it('reads a bounded ordinary receipt and rejects an oversized file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-receipt-'));
    const file = path.join(directory, 'receipt.json');
    try {
      await writeFile(file, '{"schemaVersion":1}');
      await expect(readUpdateAcceptanceReceipt(file)).resolves.toEqual({ schemaVersion: 1 });
      await writeFile(file, '{"schemaVersion":1,"schemaVersion":2}');
      await expect(readUpdateAcceptanceReceipt(file)).rejects.toThrow('not valid JSON');
      await writeFile(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
      await expect(readUpdateAcceptanceReceipt(file)).rejects.toThrow('not valid JSON');
      await writeFile(file, 'x'.repeat(65_537));
      await expect(readUpdateAcceptanceReceipt(file)).rejects.toThrow('unavailable or unsafe');
    } finally {
      await unlink(file).catch(() => undefined);
      await rmdir(directory);
    }
  });

  it('applies the release guard to a complete receipt read from disk', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-receipt-'));
    const file = path.join(directory, 'receipt.json');
    try {
      const { receipt, provenance, context } = fixture('win32', 'x64');
      await writeFile(file, JSON.stringify(receipt));
      const parsed = await readUpdateAcceptanceReceipt(file);
      expect(() => validateUpdateAcceptanceReceipt(parsed, { ...context, provenance })).not.toThrow();
      expect(() => verifyUpdateAcceptanceForRelease(parsed, { ...context, provenance }))
        .toThrow('Updater acceptance producer authentication is unavailable');
    } finally {
      await unlink(file).catch(() => undefined);
      await rmdir(directory);
    }
  });

  it.each([
    ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'],
  ])('refuses self-asserted acceptance for %s/%s at the release gate', (platform: UpdatePlatform, arch: UpdateArchitecture): void => {
    const { receipt, provenance, context } = fixture(platform, arch);
    expect(() => verifyUpdateAcceptanceForRelease(receipt, { ...context, provenance }))
      .toThrow('Updater acceptance producer authentication is unavailable');
  });

  it.each([
    ['wrong run ID', (receipt: MutableAcceptanceReceipt): void => { receipt.workflow.runId = '87654321'; }],
    ['wrong run attempt', (receipt: MutableAcceptanceReceipt): void => { receipt.workflow.runAttempt = '1'; }],
    ['wrong source commit', (receipt: MutableAcceptanceReceipt): void => { receipt.sourceCommit = 'f'.repeat(40); }],
    ['confirmation named the wrong version', (receipt: MutableAcceptanceReceipt): void => { receipt.confirmation.version = receipt.fromVersion; }],
    ['confirmation was declined', (receipt: MutableAcceptanceReceipt): void => { receipt.confirmation.accepted = false; }],
    ['confirmation was shown more than once', (receipt: MutableAcceptanceReceipt): void => { receipt.confirmation.promptCount = 2; }],
    ['unsigned updater package', (receipt: MutableAcceptanceReceipt): void => {
      if (receipt.platform === 'win32') receipt.signing.status = 'NotSigned';
      else receipt.signing.mode = 'ad-hoc';
    }],
    ['installer was interactive', (receipt: MutableAcceptanceReceipt): void => { receipt.install.mode = 'interactive'; }],
    ['installer displayed a Next prompt', (receipt: MutableAcceptanceReceipt): void => { receipt.install.interactivePrompts = 1; }],
    ['failed post-update health', (receipt: MutableAcceptanceReceipt): void => { receipt.install.health = 'failed'; }],
    ['Tunnel was not restored after update', (receipt: MutableAcceptanceReceipt): void => { receipt.install.tunnel = 'disconnected'; }],
    ['rollback did not restore the prior installation', (receipt: MutableAcceptanceReceipt): void => { receipt.rollback.restoredInstallSha256 = 'f'.repeat(64); }],
    ['rollback was not caused by the injected failure', (receipt: MutableAcceptanceReceipt): void => { receipt.rollback.injectedFailure = 'none'; }],
    ['rollback did not restart the prior installation', (receipt: MutableAcceptanceReceipt): void => { receipt.rollback.processRestarted = false; }],
  ])('rejects %s', (_label: string, corrupt: (receipt: MutableAcceptanceReceipt) => void): void => {
    const { receipt, provenance, context } = fixture('win32', 'x64');
    corrupt(receipt);
    expect(() => validateUpdateAcceptanceReceipt(receipt, { ...context, provenance })).toThrow();
  });

  it('requires one accepted confirmation for the exact version and a silent install without Next prompts', (): void => {
    const { receipt, provenance, context } = fixture('win32', 'x64');
    expect(receipt.confirmation).toEqual({ version: receipt.toVersion, accepted: true, promptCount: 1 });
    expect(receipt.install).toMatchObject({ mode: 'silent', interactivePrompts: 0 });
    expect(() => validateUpdateAcceptanceReceipt(receipt, { ...context, provenance })).not.toThrow();
  });
});

function fixture(platform: UpdatePlatform, arch: UpdateArchitecture): AcceptanceFixture {
  const sourceCommit = 'a'.repeat(40);
  const packageSha256 = 'b'.repeat(64);
  const feedSha256 = 'c'.repeat(64);
  const certificateSha1 = 'd'.repeat(40);
  const priorInstallSha256 = 'e'.repeat(64);
  const packageName = platform === 'win32' ? 'lnwjud-Setup-5.9.0.exe' : `lnwjud-5.9.0-${arch}.zip`;
  const feedName = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
  const provenance = {
    schemaVersion: 1,
    product: 'lnwjud',
    version: '5.9.0',
    platform,
    arch,
    source: {
      repository: 'https://github.com/engasnm111/lnwjud',
      commit: sourceCommit,
      dirty: false,
    },
    build: {
      environment: 'github-actions',
      workflow: 'CI',
      runId: '12345678',
      runAttempt: '2',
      ref: 'refs/heads/main',
      ...(platform === 'win32'
        ? {
          signingCredentialConfigured: true,
          windowsAuthenticode: [{
            name: packageName,
            sha256: packageSha256,
            status: 'Valid',
            signerCertificateSha1: certificateSha1,
            signerSubject: 'CN=lnwjud release',
          }],
        }
        : {
          macSigning: {
            mode: 'certificate',
            certificateSha1,
            policy: { teamId: 'ABCDE12345' },
          },
        }),
    },
    capabilityBridge: platform === 'win32'
      ? { fileName: 'windows-capability-bridge.ps1', sizeBytes: 1, sha256: 'f'.repeat(64) }
      : null,
    containment: {},
    updateWorker: platform === 'win32' ? {} : null,
    artifacts: [
      { name: packageName, sha256: packageSha256 },
      { name: feedName, sha256: feedSha256 },
    ],
    runtime: [],
  };
  const receipt = {
    schemaVersion: 1,
    product: 'lnwjud-auto-update-acceptance',
    platform,
    arch,
    fromVersion: '5.8.9',
    toVersion: '5.9.0',
    sourceCommit,
    confirmation: { version: '5.9.0', accepted: true, promptCount: 1 },
    workflow: { runId: '12345678', runAttempt: '2' },
    feed: { name: feedName, sha256: feedSha256 },
    package: { name: packageName, sha256: packageSha256 },
    signing: platform === 'win32'
      ? { kind: 'authenticode', status: 'Valid', certificateSha1, subject: 'CN=lnwjud release' }
      : { kind: 'developer-id', mode: 'certificate', certificateSha1, teamId: 'ABCDE12345' },
    install: {
      installedVersion: '5.9.0',
      packageSha256,
      processRestarted: true,
      health: 'passed',
      tunnel: 'connected',
      mode: 'silent',
      interactivePrompts: 0,
    },
    rollback: {
      injectedFailure: 'post-install-health-check',
      restoredVersion: '5.8.9',
      processRestarted: true,
      priorInstallSha256,
      restoredInstallSha256: priorInstallSha256,
      health: 'passed',
      tunnel: 'connected',
    },
  };
  return {
    receipt,
    provenance,
    context: { expectedRunId: '12345678', expectedRunAttempt: '2', expectedCommit: sourceCommit },
  };
}
