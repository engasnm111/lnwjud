export const TUNNEL_CLIENT_VERSION = '0.0.13';

const releaseBase = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`;

const TARGETS = Object.freeze({
  'win32-x64': target('windows-amd64', '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb', 'tunnel-client.exe', 'cloudflared.exe'),
  'darwin-x64': target('darwin-amd64', 'c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c', 'tunnel-client', 'cloudflared'),
  'darwin-arm64': target('darwin-arm64', '15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6', 'tunnel-client', 'cloudflared'),
  'linux-x64': target('linux-amd64', 'e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906', 'tunnel-client', 'cloudflared'),
  'linux-arm64': target('linux-arm64', '9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8', 'tunnel-client', 'cloudflared'),
});

function target(upstreamTarget, sha256, executableName, cloudflaredName) {
  const stem = `tunnel-client-v${TUNNEL_CLIENT_VERSION}-${upstreamTarget}`;
  const assetName = `${stem}.zip`;
  return Object.freeze({
    version: TUNNEL_CLIENT_VERSION,
    upstreamTarget,
    assetName,
    url: `${releaseBase}/${assetName}`,
    sha256,
    executableName,
    cloudflaredName,
    requiredFileNames: Object.freeze([
      executableName,
      cloudflaredName,
      'cloudflared-manifest.json',
      'LICENSE',
      'NOTICE',
      `${stem}-licenses.txt`,
      `${stem}.spdx.json`,
    ]),
  });
}

export function tunnelClientTargetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function resolveTunnelClientAsset(platform = process.platform, arch = process.arch) {
  const key = tunnelClientTargetKey(platform, arch);
  const asset = TARGETS[key];
  if (asset === undefined) throw new Error(`No bundled tunnel-client asset policy exists for ${key}`);
  return { target: key, ...asset };
}

export function supportedTunnelClientTargets() {
  return Object.keys(TARGETS);
}
