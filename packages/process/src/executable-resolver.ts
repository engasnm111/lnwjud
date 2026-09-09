import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@lnwjud/domain';

export interface ExecutableResolver {
  resolve(executable: string): Promise<Result<string>>;
}

export class PathExecutableResolver implements ExecutableResolver {
  public constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async resolve(executable: string): Promise<Result<string>> {
    if (executable.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Executable is required', recoverable: false });
    const pathApi = this.platform === 'win32' ? path.win32 : path.posix;
    const pathEntries = (this.environment.Path ?? this.environment.PATH ?? '').split(this.platform === 'win32' ? ';' : ':').filter(Boolean);
    const hasPath = pathApi.isAbsolute(executable) || executable.includes(this.platform === 'win32' ? '\\' : '/');
    const candidates = hasPath
      ? this.withWindowsExtensions(executable)
      : pathEntries.flatMap((entry) => this.withWindowsExtensions(pathApi.join(entry, executable)));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.F_OK);
        if ((await stat(candidate)).isFile()) return ok(candidate);
      } catch {
        continue;
      }
    }
    return err({ code: 'EXECUTABLE_NOT_FOUND', message: `Executable '${executable}' was not found`, recoverable: true });
  }

  private withWindowsExtensions(candidate: string): string[] {
    if (path.win32.extname(candidate).length > 0 || this.platform !== 'win32') return [candidate];
    const extensions = (this.environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
    return [...extensions.map((extension) => `${candidate}${extension.toLowerCase()}`), candidate];
  }
}
