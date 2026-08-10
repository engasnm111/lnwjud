import { appError, err, MAX_MULTI_FILE_BYTES, ok, type Result } from '@lnwjud/domain';

export interface FilePatch {
  readonly path: string;
  readonly content: string;
}

export interface PatchRequest {
  readonly files: readonly FilePatch[];
}

export class PatchApplier {
  public validate(files: readonly FilePatch[]): Result<void> {
    if (!Array.isArray(files) || files.length === 0 || files.length > 20) {
      return err(appError('INVALID_INPUT', 'Patch must contain 1 to 20 files'));
    }
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      if (typeof file.path !== 'string' || file.path.length === 0 || typeof file.content !== 'string') {
        return err(appError('INVALID_INPUT', 'Patch file entry is invalid'));
      }
      const normalizedPath = file.path.replaceAll('/', '\\').toLowerCase();
      if (paths.has(normalizedPath)) return err(appError('INVALID_INPUT', 'Patch contains duplicate paths'));
      paths.add(normalizedPath);
      totalBytes += Buffer.byteLength(file.content, 'utf8');
      if (totalBytes > MAX_MULTI_FILE_BYTES) return err(appError('FILE_TOO_LARGE', 'Patch exceeds the maximum total size'));
    }
    return ok(undefined);
  }
}
