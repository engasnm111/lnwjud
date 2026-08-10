import { MAX_PROCESS_LOG_BYTES } from '@lnwjud/domain';
import type { LogQuery, ProcessLogEntry, ProcessLogResult, ProcessLogStream } from './process-types.js';

const DEFAULT_MAX_BYTES = MAX_PROCESS_LOG_BYTES;

export class LogRingBuffer {
  private readonly entries: ProcessLogEntry[] = [];
  private sequence = 0;
  private bytes = 0;
  private evicted = false;

  public constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  public append(stream: ProcessLogStream, text: string): void {
    const chunks = text.split(/(?<=\n)/).filter((chunk) => chunk.length > 0);
    for (const chunk of chunks) this.appendChunk(stream, chunk);
  }

  public read(query: LogQuery): ProcessLogResult {
    const sinceSequence = query.sinceSequence ?? 0;
    let entries = this.entries.filter((entry) => entry.sequence > sinceSequence);
    if (query.tailLines !== undefined) entries = entries.slice(-query.tailLines);
    const oldest = this.entries[0]?.sequence;
    const cursorMissedEvicted = oldest !== undefined && query.sinceSequence !== undefined && oldest > sinceSequence + 1;
    return {
      entries,
      truncated: this.evicted || cursorMissedEvicted,
      nextSequence: this.sequence,
    };
  }

  private appendChunk(stream: ProcessLogStream, input: string): void {
    let text = input;
    let size = Buffer.byteLength(text, 'utf8');
    if (size > this.maxBytes) {
      text = Buffer.from(text, 'utf8').subarray(-this.maxBytes).toString('utf8');
      size = Buffer.byteLength(text, 'utf8');
      this.evicted = true;
    }
    while (this.entries.length > 0 && this.bytes + size > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed.text, 'utf8');
      this.evicted = true;
    }
    this.sequence += 1;
    this.entries.push({ sequence: this.sequence, stream, text });
    this.bytes += size;
  }
}
