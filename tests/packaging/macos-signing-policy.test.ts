import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error Packaging inspector is a standalone JavaScript module.
import {
  assertMacosSigningPolicyMatches,
  inspectMacosSigningPolicy,
  validateMacosSigningPolicyEvidence,
} from '../../apps/desktop/scripts/inspect-macos-signing-policy.mjs';

type SigningMode = 'ad-hoc' | 'certificate';
type Candidate = {
  absolutePath: string;
  relativePath: string;
  kind: 'app' | 'framework' | 'dylib' | 'executable';
  electronProcess: boolean;
};

const temporaryRoots: string[] = [];

it('wires Developer ID CI signing secrets as an all-or-nothing pair', async () => {
  const workflow = await fs.readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('MACOS_CSC_LINK: ${{ secrets.MACOS_CSC_LINK }}');
  expect(workflow).toContain('MACOS_CSC_KEY_PASSWORD: ${{ secrets.MACOS_CSC_KEY_PASSWORD }}');
  expect(workflow).toContain('if [[ -z "$MACOS_CSC_LINK" || -z "$MACOS_CSC_KEY_PASSWORD" ]]; then');
  expect(workflow).toContain('export LNWJUD_REQUIRE_CODESIGN=1');
});

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function signingFixture(mode: SigningMode, overrides: {
  missingBypass?: string;
  unexpectedBypass?: string;
  missingRuntime?: string;
  missingTimestamp?: string;
  certificateCandidate?: string;
  teamByPath?: Record<string, string>;
} = {}): Promise<{
  app: string;
  candidates: Candidate[];
  run: ReturnType<typeof vi.fn>;
  rootSha256: string;
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lnwjud-macos-policy-')));
  temporaryRoots.push(root);
  const app = path.join(root, 'lnwjud.app');
  const relativeCandidates: Array<Omit<Candidate, 'absolutePath'>> = [
    { relativePath: '.', kind: 'app', electronProcess: false },
    { relativePath: 'Contents/MacOS/lnwjud', kind: 'executable', electronProcess: true },
    { relativePath: 'Contents/Frameworks/Electron Framework.framework', kind: 'framework', electronProcess: false },
    { relativePath: 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', kind: 'executable', electronProcess: false },
    { relativePath: 'Contents/Frameworks/lnwjud Helper.app', kind: 'app', electronProcess: false },
    { relativePath: 'Contents/Frameworks/lnwjud Helper.app/Contents/MacOS/lnwjud Helper', kind: 'executable', electronProcess: true },
    { relativePath: 'Contents/Frameworks/libEGL.dylib', kind: 'dylib', electronProcess: false },
    { relativePath: 'Contents/Resources/runtime-tools/ripgrep/rg', kind: 'executable', electronProcess: false },
  ];
  const candidates = relativeCandidates.map((candidate) => ({
    ...candidate,
    absolutePath: candidate.relativePath === '.' ? app : path.join(app, candidate.relativePath),
  }));
  for (const candidate of candidates) {
    if (candidate.kind === 'app' || candidate.kind === 'framework') {
      await fs.mkdir(candidate.absolutePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(candidate.absolutePath), { recursive: true });
      await fs.writeFile(candidate.absolutePath, `${candidate.relativePath}\n`, 'utf8');
    }
  }
  const mainExecutable = path.join(app, 'Contents', 'MacOS', 'lnwjud');
  const rootSha256 = createHash('sha256').update(await fs.readFile(mainExecutable)).digest('hex');
  const byAbsolutePath = new Map(candidates.map((candidate, index) => [candidate.absolutePath, { candidate, index }]));
  const run = vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const absolutePath = args.at(-1)!;
    const target = byAbsolutePath.get(absolutePath);
    if (!target) throw new Error(`Unexpected codesign target: ${absolutePath}`);
    if (args.includes('--verify')) return { stdout: '', stderr: '' };
    if (args.includes('--entitlements')) {
      const shouldBypass = mode === 'ad-hoc'
        ? overrides.missingBypass !== target.candidate.relativePath
        : overrides.unexpectedBypass === target.candidate.relativePath;
      return { stdout: shouldBypass
        ? '<plist><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'
        : '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>', stderr: '' };
    }
    const forcedCertificate = overrides.certificateCandidate === target.candidate.relativePath;
    const candidateMode: SigningMode = forcedCertificate ? 'certificate' : mode;
    const team = overrides.teamByPath?.[target.candidate.relativePath] ?? 'ABCDE12345';
    const hardened = overrides.missingRuntime === target.candidate.relativePath ? '' : ',runtime';
    const timestamp = overrides.missingTimestamp === target.candidate.relativePath ? '' : '\nTimestamp=Sep 13, 2026';
    const identifier = target.candidate.relativePath === '.' ? 'com.lnwjud.desktop' : `com.lnwjud.${target.index}`;
    const cdHash = String(target.index + 1).repeat(40).slice(0, 40);
    return {
      stdout: '',
      stderr: [
        `Identifier=${identifier}`,
        `CodeDirectory v=20500 size=1 flags=0x10000(adhoc${hardened}) hashes=1+1 location=embedded`,
        `CDHash=${cdHash}`,
        candidateMode === 'ad-hoc' ? 'Signature=adhoc' : `TeamIdentifier=${team}${timestamp}`,
        candidateMode === 'ad-hoc' ? 'TeamIdentifier=not set' : '',
      ].filter(Boolean).join('\n'),
    };
  });
  return { app, candidates, run, rootSha256 };
}

describe('macOS effective signing policy inspector', () => {
  it('emits deterministic bundle-relative evidence for a compliant ad-hoc app', async () => {
    const fixture = await signingFixture('ad-hoc');
    const policy = await inspectMacosSigningPolicy(fixture.app, {
      arch: 'arm64', run: fixture.run, discover: async () => fixture.candidates,
    });

    expect(policy).toMatchObject({
      schemaVersion: 1,
      mode: 'ad-hoc',
      arch: 'arm64',
      rootIdentifier: 'com.lnwjud.desktop',
      teamId: null,
      rootCdHash: '1'.repeat(40),
      rootExecutableSha256: fixture.rootSha256,
      inspectedNestedCodeCount: fixture.candidates.length - 1,
    });
    expect(policy.code.map((entry: { relativePath: string }) => entry.relativePath))
      .toEqual(fixture.candidates.map((entry) => entry.relativePath));
    expect(policy.electronProcesses).toEqual([
      expect.objectContaining({ relativePath: 'Contents/MacOS/lnwjud', hardenedRuntime: true,
        libraryValidationDisabled: true, secureTimestamp: false }),
      expect.objectContaining({ relativePath: 'Contents/Frameworks/lnwjud Helper.app/Contents/MacOS/lnwjud Helper',
        hardenedRuntime: true, libraryValidationDisabled: true, secureTimestamp: false }),
    ]);
    expect(JSON.stringify(policy)).not.toContain(fixture.app);
  });

  it('preserves library validation and one Team ID for a certificate app', async () => {
    const fixture = await signingFixture('certificate');
    const policy = await inspectMacosSigningPolicy(fixture.app, {
      arch: 'x64', certificateSha1: 'a'.repeat(40), run: fixture.run,
      discover: async () => fixture.candidates,
    });

    expect(policy.mode).toBe('certificate');
    expect(policy.teamId).toBe('ABCDE12345');
    expect(policy.electronProcesses).toEqual([
      expect.objectContaining({ hardenedRuntime: true, libraryValidationDisabled: false, secureTimestamp: true }),
      expect.objectContaining({ hardenedRuntime: true, libraryValidationDisabled: false, secureTimestamp: true }),
    ]);
    expect(fixture.run.mock.calls.some(([args]) => args.includes(
      '=anchor apple generic and certificate leaf = H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    ))).toBe(true);
  });

  it.each([
    ['ad-hoc process without bypass', 'ad-hoc', { missingBypass: 'Contents/MacOS/lnwjud' }, 'lacks disable-library-validation'],
    ['certificate process with bypass', 'certificate', { unexpectedBypass: 'Contents/MacOS/lnwjud' }, 'must keep library validation enabled'],
    ['certificate process without runtime', 'certificate', { missingRuntime: 'Contents/MacOS/lnwjud' }, 'lacks hardened runtime'],
    ['certificate process without timestamp', 'certificate', { missingTimestamp: 'Contents/MacOS/lnwjud' }, 'lacks secure timestamp'],
    ['mixed certificate team', 'certificate', { teamByPath: { 'Contents/Frameworks/libEGL.dylib': 'OTHER12345' } }, 'TeamIdentifier mismatch'],
    ['certificate nested in ad-hoc app', 'ad-hoc', { certificateCandidate: 'Contents/Frameworks/libEGL.dylib' }, 'signature mode mismatch'],
  ] as const)('rejects %s', async (_label, mode, overrides, message) => {
    const fixture = await signingFixture(mode, overrides);
    await expect(inspectMacosSigningPolicy(fixture.app, {
      arch: 'arm64', certificateSha1: mode === 'certificate' ? 'a'.repeat(40) : undefined,
      run: fixture.run, discover: async () => fixture.candidates,
    })).rejects.toThrow(message);
  });

  it('rejects stale, contradictory and downgraded stored evidence', async () => {
    const fixture = await signingFixture('ad-hoc');
    const policy = await inspectMacosSigningPolicy(fixture.app, {
      arch: 'arm64', run: fixture.run, discover: async () => fixture.candidates,
    });
    expect(() => validateMacosSigningPolicyEvidence(policy, {
      mode: 'ad-hoc', arch: 'arm64', rootExecutableSha256: fixture.rootSha256,
    })).not.toThrow();
    expect(() => validateMacosSigningPolicyEvidence({ ...policy, arch: 'x64' }, {
      mode: 'ad-hoc', arch: 'arm64', rootExecutableSha256: fixture.rootSha256,
    })).toThrow('architecture mismatch');
    expect(() => validateMacosSigningPolicyEvidence({ ...policy, mode: 'unsigned' }, {
      mode: 'ad-hoc', arch: 'arm64', rootExecutableSha256: fixture.rootSha256,
    })).toThrow('mode is invalid');
    expect(() => validateMacosSigningPolicyEvidence(policy, {
      mode: 'ad-hoc', arch: 'arm64', rootExecutableSha256: 'f'.repeat(64),
    })).toThrow('root executable hash mismatch');
    expect(() => validateMacosSigningPolicyEvidence({ ...policy, rootCdHash: 'f'.repeat(40) }))
      .toThrow('root identity is inconsistent');
    expect(() => validateMacosSigningPolicyEvidence({
      ...policy,
      electronProcesses: policy.electronProcesses.slice(0, 1),
    })).toThrow('Electron process evidence is incomplete');
    expect(() => validateMacosSigningPolicyEvidence({
      ...policy,
      electronProcesses: policy.electronProcesses.map((entry: { relativePath: string }) => entry.relativePath === 'Contents/MacOS/lnwjud'
        ? { ...entry, cdHash: 'f'.repeat(40) }
        : entry),
    })).toThrow('Electron process entry is invalid');
  });

  it('compares stored evidence with a freshly inspected artifact byte-for-byte', async () => {
    const fixture = await signingFixture('ad-hoc');
    const policy = await inspectMacosSigningPolicy(fixture.app, {
      arch: 'arm64', run: fixture.run, discover: async () => fixture.candidates,
    });
    expect(() => assertMacosSigningPolicyMatches(policy, structuredClone(policy))).not.toThrow();
    expect(() => assertMacosSigningPolicyMatches(policy, {
      ...structuredClone(policy), rootExecutableSha256: 'f'.repeat(64),
    })).toThrow('does not match release provenance');
  });
});
