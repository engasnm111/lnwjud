import { readFile, stat } from 'node:fs/promises';
import { err, MAX_FILE_READ_BYTES, ok, type Result } from '@lnwjud/domain';

export { MAX_FILE_READ_BYTES } from '@lnwjud/domain';

export interface LineRange {
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface TextFileResult {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

export class TextFileReader {
  public async read(filePath: string, range: LineRange = {}): Promise<Result<TextFileResult>> {
    if (!this.isValidRange(range)) return err({ code: 'INVALID_INPUT', message: 'Line range is invalid', recoverable: false });

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'File was not found', recoverable: false });
    }
    if (size > MAX_FILE_READ_BYTES) {
      return err({ code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum read size', recoverable: false });
    }

    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'File was not found', recoverable: false });
    }
    if (data.subarray(0, 8192).includes(0)) {
      return err({ code: 'BINARY_FILE', message: 'Binary files cannot be read as text', recoverable: false });
    }

    const content = data.toString('utf8');
    const lines = this.splitLines(content);
    const startLine = range.startLine ?? 1;
    const endLine = range.endLine ?? lines.length;
    if (lines.length === 0 && startLine !== 1) return err({ code: 'INVALID_INPUT', message: 'Line range is outside the file', recoverable: false });
    if (lines.length > 0 && startLine > lines.length) return err({ code: 'INVALID_INPUT', message: 'Line range is outside the file', recoverable: false });

    return ok({
      content: lines.slice(startLine - 1, Math.min(endLine, lines.length)).join(''),
      startLine,
      endLine: Math.min(endLine, lines.length),
    });
  }

  private isValidRange(range: LineRange): boolean {
    return (range.startLine === undefined || Number.isInteger(range.startLine) && range.startLine >= 1)
      && (range.endLine === undefined || Number.isInteger(range.endLine) && range.endLine >= 1)
      && (range.startLine === undefined || range.endLine === undefined || range.startLine <= range.endLine);
  }

  private splitLines(content: string): string[] {
    if (content.length === 0) return [];
    const lines = content.split(/(?<=\n)/);
    if (lines.at(-1) === '') lines.pop();
    return lines;
  }
}
