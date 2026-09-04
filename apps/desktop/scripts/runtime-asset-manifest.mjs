export const NODE_RUNTIME_VERSION = '24.16.0';
export const RIPGREP_RUNTIME_VERSION = '15.2.0';

const nodeBase = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
const ripgrepBase = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_RUNTIME_VERSION}`;

const TARGETS = Object.freeze({
  'win32-x64': {
    node: {
      version: NODE_RUNTIME_VERSION,
      url: `${nodeBase}/win-x64/node.exe`,
      sha256: 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3',
      archiveType: 'file',
      innerPath: null,
      executableName: 'lnwjud-node.exe',
    },
    ripgrep: {
      version: RIPGREP_RUNTIME_VERSION,
      url: `${ripgrepBase}/ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-pc-windows-msvc.zip`,
      sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
      archiveType: 'zip',
      innerPath: `ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-pc-windows-msvc/rg.exe`,
      executableName: 'rg.exe',
    },
  },
  'darwin-x64': {
    node: {
      version: NODE_RUNTIME_VERSION,
      url: `${nodeBase}/node-v${NODE_RUNTIME_VERSION}-darwin-x64.tar.gz`,
      sha256: '298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185',
      archiveType: 'tar.gz',
      innerPath: `node-v${NODE_RUNTIME_VERSION}-darwin-x64/bin/node`,
      executableName: 'lnwjud-node',
    },
    ripgrep: {
      version: RIPGREP_RUNTIME_VERSION,
      url: `${ripgrepBase}/ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-apple-darwin.tar.gz`,
      sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
      archiveType: 'tar.gz',
      innerPath: `ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-apple-darwin/rg`,
      executableName: 'rg',
    },
  },
  'darwin-arm64': {
    node: {
      version: NODE_RUNTIME_VERSION,
      url: `${nodeBase}/node-v${NODE_RUNTIME_VERSION}-darwin-arm64.tar.gz`,
      sha256: '39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6',
      archiveType: 'tar.gz',
      innerPath: `node-v${NODE_RUNTIME_VERSION}-darwin-arm64/bin/node`,
      executableName: 'lnwjud-node',
    },
    ripgrep: {
      version: RIPGREP_RUNTIME_VERSION,
      url: `${ripgrepBase}/ripgrep-${RIPGREP_RUNTIME_VERSION}-aarch64-apple-darwin.tar.gz`,
      sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
      archiveType: 'tar.gz',
      innerPath: `ripgrep-${RIPGREP_RUNTIME_VERSION}-aarch64-apple-darwin/rg`,
      executableName: 'rg',
    },
  },
  'linux-x64': {
    node: {
      version: NODE_RUNTIME_VERSION,
      url: `${nodeBase}/node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.xz`,
      sha256: 'd804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9',
      archiveType: 'tar.xz',
      innerPath: `node-v${NODE_RUNTIME_VERSION}-linux-x64/bin/node`,
      executableName: 'lnwjud-node',
    },
    ripgrep: {
      version: RIPGREP_RUNTIME_VERSION,
      url: `${ripgrepBase}/ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
      sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
      archiveType: 'tar.gz',
      innerPath: `ripgrep-${RIPGREP_RUNTIME_VERSION}-x86_64-unknown-linux-musl/rg`,
      executableName: 'rg',
    },
  },
  'linux-arm64': {
    node: {
      version: NODE_RUNTIME_VERSION,
      url: `${nodeBase}/node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.xz`,
      sha256: '524659219d6a207a7400f2bde15d19ba060ffbe0d32a8643319ad67e3bb64c78',
      archiveType: 'tar.xz',
      innerPath: `node-v${NODE_RUNTIME_VERSION}-linux-arm64/bin/node`,
      executableName: 'lnwjud-node',
    },
    ripgrep: {
      version: RIPGREP_RUNTIME_VERSION,
      url: `${ripgrepBase}/ripgrep-${RIPGREP_RUNTIME_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
      sha256: 'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d',
      archiveType: 'tar.gz',
      innerPath: `ripgrep-${RIPGREP_RUNTIME_VERSION}-aarch64-unknown-linux-gnu/rg`,
      executableName: 'rg',
    },
  },
});

export function runtimeTargetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function resolveRuntimeAssets(platform = process.platform, arch = process.arch) {
  const key = runtimeTargetKey(platform, arch);
  const target = TARGETS[key];
  if (target === undefined) throw new Error(`No bundled runtime asset policy exists for ${key}`);
  return { target: key, ...target };
}

export function supportedRuntimeTargets() {
  return Object.keys(TARGETS);
}
