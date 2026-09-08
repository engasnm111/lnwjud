import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type PosixProcessIdentityProbe = (pid: number) => Promise<string | null>;

/**
 * Read the host process start identity without invoking a shell.  `ps` is
 * available on both supported POSIX targets and its lstart output is more
 * stable than parsing platform-specific /proc files.  A missing/ambiguous
 * result is deliberately represented as null so callers can refuse a
 * destructive signal instead of guessing.
 */
export function createPosixProcessIdentityProbe(platform: NodeJS.Platform): PosixProcessIdentityProbe {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('POSIX process identity requires macOS or Linux');
  return async (pid: number): Promise<string | null> => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 1_750,
        maxBuffer: 16 * 1024,
      });
      const value = stdout.trim();
      if (value.length === 0) return null;
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) return null;
      const timestamp = new Date(parsed).toISOString();
      return ISO_UTC_MILLISECONDS.test(timestamp) ? timestamp : null;
    } catch (error: unknown) {
      if (isMissingProcess(error)) return null;
      // An unavailable or malformed probe must fail closed.  Throwing keeps
      // the distinction from a process that has genuinely exited.
      throw new Error('POSIX process start identity could not be verified', { cause: error });
    }
  };
}

function isMissingProcess(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; stdout?: unknown };
  if (typeof value.stdout === 'string' && value.stdout.trim().length > 0) return false;
  return value.code === 1 || value.code === 'ESRCH' || value.code === 'ENOENT';
}
