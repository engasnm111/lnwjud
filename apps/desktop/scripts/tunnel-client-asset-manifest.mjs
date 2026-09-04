export const TUNNEL_CLIENT_VERSION = '0.0.13';

const releaseBase = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`;

const TARGETS = Object.freeze({
  'win32-x64': target('windows-amd64', '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb', 'tunnel-client.exe', 'cloudflared.exe'),
  'darwin-x64': target('darwin-amd64', 'f7543cd3099c406790616f231ba5ae3e09ba45165820ded780beb68ded6c89f2', 'tunnel-client', 'cloudflared'),
  'darwin-arm64': target('darwin-arm64', 'ec28a76ddca4833a5b22acac5b6d84db07fbb391fbbe2ac7a0c6677987248288', 'tunnel-client', 'cloudflared'),
  'linux-x64': target('linux-amd64', '645274c9759732b3419929531416340df463ae8b2be1af4b69b06d20a000441b', 'tunnel-client', 'cloudflared'),
  'linux-arm64': target('linux-arm64', '36c78d83d01681fd1330a62627ec2b1b737a386148912705900f08ce8f0c12ce', 'tunnel-client', 'cloudflared'),
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
