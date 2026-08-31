import { spawn } from 'node:child_process';
import path from 'node:path';

export async function protectTunnelSecret(plainText: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$plain = [Console]::In.ReadToEnd()',
    '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
    'ConvertFrom-SecureString -SecureString $secure',
  ].join('; ');
  return runWindowsPowerShellWithStdin(script, plainText);
}

export async function unprotectTunnelSecret(cipherText: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$encrypted = [Console]::In.ReadToEnd().Trim()',
    '$secure = ConvertTo-SecureString -String $encrypted',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('; ');
  return runWindowsPowerShellWithStdin(script, cipherText);
}

export function resolveWindowsPowerShellExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (systemRoot === undefined || systemRoot.trim().length === 0) {
    throw new Error('Windows PowerShell is unavailable because SystemRoot/WINDIR is not set');
  }
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function buildWindowsPowerShellChildEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() !== 'psmodulepath') childEnvironment[name] = value;
  }
  return childEnvironment;
}

function runWindowsPowerShellWithStdin(command: string, input: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows DPAPI is only available on Windows'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveWindowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        env: buildWindowsPowerShellChildEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code ?? 'unknown'}`));
        return;
      }
      const value = stdout.replace(/\r?\n$/, '');
      if (value.length === 0) {
        reject(new Error('PowerShell returned an empty result'));
        return;
      }
      resolve(value);
    });
    child.stdin.end(input, 'utf8');
  });
}
