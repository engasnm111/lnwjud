import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function buildContainmentPin(outputDirectory) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 build host required');
  const source = path.dirname(fileURLToPath(import.meta.url));
  const output = outputDirectory ?? path.resolve(source, '../artifacts/win-x64');
  mkdirSync(output, { recursive: true });
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!visualStudio) throw new Error('Visual Studio C++ x64 build tools required');
  const include = path.join(source, 'include');
  for (const [name, expected] of Object.entries({
    'node_api.h': '2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a',
    'node_api_types.h': 'a25356630d3058f0a0c8937d9f297e9471e037fda58c2696d8a505c2bd99cb00',
    'js_native_api.h': '8808ef8899a1691411928ef5dd7dae0537aedc93d3a34e223b2d89692e79c788',
    'js_native_api_types.h': '4f19cb90d240765cc0961d92a1ee20f65fdc50db7de1ab0a5cb6bc227224e1a0',
  })) {
    if (createHash('sha256').update(readFileSync(path.join(include, name))).digest('hex') !== expected) {
      throw new Error(`Pinned Node N-API header mismatch: ${name}`);
    }
  }
  const quote = value => { if (/["%\r\n]/.test(value)) throw new Error('Unsupported build path'); return `"${value}"`; };
  const batch = path.join(output, 'build-pin.cmd');
  const artifact = path.join(output, 'lnwjud-containment-pin.node');
  const clangCl = 'C:/Program Files/LLVM/bin/clang-cl.exe';
  const useLlvm = existsSync(clangCl) && existsSync(path.join(path.dirname(clangCl), 'lld-link.exe'));
  const compile = useLlvm
    ? `${quote(clangCl)} /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /LD /I${quote(include)} ${quote(path.join(source, 'pin.cc'))} /Fo${quote(path.join(output, 'pin.obj'))} -fuse-ld=lld /link /OUT:${quote(artifact)} /IMPLIB:${quote(path.join(output, 'pin.lib'))} /INCREMENTAL:NO /Brepro /DYNAMICBASE /NXCOMPAT /GUARD:CF`
    : `cl.exe /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /LD /I${quote(include)} ${quote(path.join(source, 'pin.cc'))} /Fo${quote(path.join(output, 'pin.obj'))} /link /OUT:${quote(artifact)} /IMPLIB:${quote(path.join(output, 'pin.lib'))} /INCREMENTAL:NO /Brepro /DYNAMICBASE /NXCOMPAT /GUARD:CF`;
  writeFileSync(batch, [
    '@echo off',
    'set "VSCMD_SKIP_SENDTELEMETRY=1"',
    `call ${quote(path.join(visualStudio, 'VC/Auxiliary/Build/vcvars64.bat'))} >nul`,
    'if errorlevel 1 exit /b %errorlevel%',
    compile,
    'exit /b %errorlevel%', '',
  ].join('\r\n'));
  try { execFileSync(process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe', ['/d', '/c', batch], { stdio: 'inherit', windowsHide: true }); }
  finally { unlinkSync(batch); }
  return artifact;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(buildContainmentPin(process.argv[2]) + '\n');
