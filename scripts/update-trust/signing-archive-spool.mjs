import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { downloadSigningArtifactArchive } from './signing-artifact-download.mjs';
import { inspectSigningArchive } from './signing-archive-entries.mjs';

const destroyReadable = Readable.prototype.destroy;
const readableClosed = Object.getOwnPropertyDescriptor(Readable.prototype, 'closed').get;
const requireNoSigningKey = () => {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM'))
    throw new Error('SIGNING_ARCHIVE_DOWNLOAD_REFUSED');
};

export class ArchiveQuarantineError extends Error {
  #spool;
  #streams;
  constructor(spool, failed, cause, cleanupError, streams = []) {
    super('SIGNING_ARCHIVE_CLEANUP_UNVERIFIED', { cause: new AggregateError(failed ? [cause, cleanupError] : [cleanupError]) });
    this.#spool = spool;
    this.#streams = streams;
  }
  retryDiscard() {
    if (this.#spool === undefined || this.#streams.some(stream => !readableClosed.call(stream))) throw new Error('SIGNING_ARCHIVE_CLEANUP_UNVERIFIED');
    this.#spool.discard();
    this.#spool = undefined;
  }
  releaseWithoutDelete() {
    if (this.#spool === undefined || this.#streams.some(stream => !readableClosed.call(stream))) throw new Error('SIGNING_ARCHIVE_CLEANUP_UNVERIFIED');
    this.#spool.close();
    this.#spool = undefined;
  }
}

export async function withDownloadedSigningArchive({ addon, filename, artifact, token, fetchImpl }, consume) {
  if (!addon || typeof addon.createArchiveSpool !== 'function' || typeof filename !== 'string'
    || !artifact || typeof artifact !== 'object' || typeof consume !== 'function') throw new Error('SIGNING_ARCHIVE_INPUT_INVALID');
  const { artifactId, archiveSha256, archiveSizeBytes } = artifact;
  // Refuse before creating a native file: download-level validation runs only after spool creation.
  requireNoSigningKey();
  if (typeof artifactId !== 'string' || !/^[1-9][0-9]{0,14}$/.test(artifactId)
    || !Number.isSafeInteger(Number(artifactId)) || typeof archiveSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(archiveSha256) || !Number.isSafeInteger(archiveSizeBytes)
    || archiveSizeBytes < 1 || archiveSizeBytes > 5 * 1024 * 1024 * 1024
    || typeof token !== 'string' || token.length < 1 || token.length > 4096
    || (fetchImpl !== undefined && typeof fetchImpl !== 'function')) throw new Error('SIGNING_ARCHIVE_INPUT_INVALID');
  const spool = addon.createArchiveSpool(filename, archiveSizeBytes, archiveSha256);
  const streams = new Map();
  let active = true, failed = false, primary, result;
  const streamErrors = [];
  const check = (offset, length) => {
    if (!active || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset > archiveSizeBytes || length > archiveSizeBytes - offset) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
  };
  const reader = Object.freeze({
    size: archiveSizeBytes,
    readAt(offset, length) {
      check(offset, length);
      if (length > 1024 * 1024) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
      requireNoSigningKey();
      const bytes = spool.readAt(offset, length);
      if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
      return bytes;
    },
    stream(offset, length) {
      check(offset, 0);
      requireNoSigningKey();
      if (length === undefined) length = archiveSizeBytes - offset;
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
      length = Math.min(length, archiveSizeBytes - offset);
      let position = offset, remaining = length;
      const stream = new Readable({ read(requested) {
        try {
          if (!active) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
          requireNoSigningKey();
          if (remaining === 0) { this.push(null); return; }
          const count = Math.min(remaining, Math.max(1, requested), 65536);
          const chunk = spool.readAt(position, count);
          if (!Buffer.isBuffer(chunk) || chunk.length !== count) throw new Error('SIGNING_ARCHIVE_READ_INVALID');
          position += count; remaining -= count; this.push(chunk);
        } catch (error) { destroyReadable.call(this, error); }
      } });
      Object.defineProperty(stream, '_destroy', { value(error, done) { done(error); }, writable: false, configurable: false });
      const completion = finished(stream, { cleanup: true }).catch(error => { streamErrors.push(error); });
      streams.set(stream, completion);
      completion.then(() => streams.delete(stream));
      return stream;
    },
  });
  const destination = new Writable({ write(chunk, _encoding, done) {
    try {
      for (let offset = 0; offset < chunk.length; offset += 1024 * 1024) spool.write(chunk.subarray(offset, offset + 1024 * 1024));
      done();
    } catch (error) { done(error); }
  } });
  try {
    const download = await downloadSigningArtifactArchive({ artifactId, expectedSha256: archiveSha256, token, destination,
      ...(fetchImpl === undefined ? {} : { fetchImpl }) });
    if (download.sizeBytes !== archiveSizeBytes) throw new Error('SIGNING_ARCHIVE_SIZE_MISMATCH');
    // The signer secret must remain absent after the asynchronous network read
    // and throughout consumer inspection; the guard is process-local only.
    requireNoSigningKey();
    spool.seal();
    result = await consume(reader);
    requireNoSigningKey();
  } catch (error) { failed = true; primary = error; }
  active = false;
  const pending = [...streams.entries()];
  if (pending.length > 0 && !failed) { failed = true; primary = new Error('SIGNING_ARCHIVE_READ_INCOMPLETE'); }
  let stopFailed = false, stopError;
  for (const [stream] of pending) {
    try { destroyReadable.call(stream); } catch (error) { if (!stopFailed) stopError = error; stopFailed = true; }
  }
  if (stopFailed) throw new ArchiveQuarantineError(spool, failed, primary, stopError, pending.map(([stream]) => stream));
  await Promise.all(pending.map(([, completion]) => completion));
  if (streamErrors.length > 0 && !failed) { failed = true; primary = streamErrors[0]; }
  try { spool.discard(); }
  catch (cleanupError) { throw new ArchiveQuarantineError(spool, failed, primary, cleanupError); }
  if (failed) throw primary;
  return result;
}

/**
 * Download, verify the immutable archive digest and inspect every bound member
 * before exposing any member bytes to a key-free consumer. Still not signing authority.
 */
export function withInspectedSigningArchive(options, consume) {
  if (typeof consume !== 'function' || !options || typeof options.expectedManifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)) throw new Error('SIGNING_ARCHIVE_INPUT_INVALID');
  // Snapshot caller-supplied identity before the asynchronous download; a mutable
  // options object must not change the accepted source or policy mid-verification.
  const expectedManifestSha256 = options.expectedManifestSha256;
  const expectedSource = options.expectedSource && typeof options.expectedSource === 'object'
    && !Array.isArray(options.expectedSource) ? Object.freeze({ ...options.expectedSource }) : options.expectedSource;
  return withDownloadedSigningArchive(options, async reader => {
    const inspection = await inspectSigningArchive(reader, expectedManifestSha256, expectedSource);
    return consume(reader, inspection);
  });
}
