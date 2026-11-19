import assert from 'node:assert/strict';
import test from 'node:test';
import { pinBuildBatchLines } from './build.mjs';

test('LLVM pin builds fall back to MSVC when the installed STL rejects clang-cl', () => {
  const batch = pinBuildBatchLines({
    vcvars64: 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat',
    clangCompile: '"C:\\Program Files\\LLVM\\bin\\clang-cl.exe" /nologo pin.cc',
    msvcCompile: 'cl.exe /nologo pin.cc',
    useLlvm: true,
  });
  const lines = batch.split('\r\n');
  const clangIndex = lines.findIndex((line) => line.includes('clang-cl.exe'));
  const fallbackIndex = lines.findIndex((line) => line === 'if not errorlevel 1 exit /b 0');
  const msvcIndex = lines.findIndex((line) => line.startsWith('cl.exe '));
  assert.ok(clangIndex >= 0 && fallbackIndex > clangIndex && msvcIndex > fallbackIndex, batch);
  assert.match(batch, /echo LLVM pin build failed; falling back to the MSVC compiler\. 1>&2/);
  assert.ok(lines.at(-1) === 'exit /b %errorlevel%' || lines.at(-1) === '');
  assert.ok(batch.includes('set "VSCMD_SKIP_SENDTELEMETRY=1"'));
});

test('an MSVC-only pin build never emits an LLVM command', () => {
  const batch = pinBuildBatchLines({
    vcvars64: 'C:\\VS\\vcvars64.bat',
    clangCompile: '"C:\\Program Files\\LLVM\\bin\\clang-cl.exe" /nologo pin.cc',
    msvcCompile: 'cl.exe /nologo pin.cc',
    useLlvm: false,
  });
  assert.ok(!batch.includes('clang-cl.exe'));
  assert.ok(batch.includes('cl.exe /nologo pin.cc'));
});

test('refuses a batch command containing expansion or line breaks', () => {
  const base = { vcvars64: 'C:\\VS\\vcvars64.bat', clangCompile: 'clang-cl.exe', msvcCompile: 'cl.exe' };
  assert.throws(() => pinBuildBatchLines({ ...base, vcvars64: 'C:\\VS\\%USERPROFILE%\\vcvars64.bat' }), /invalid/);
  assert.throws(() => pinBuildBatchLines({ ...base, msvcCompile: 'cl.exe\r\ndel /s /q C:\\' }), /invalid/);
});
