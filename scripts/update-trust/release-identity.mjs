import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { hash, parseStrictJson, refuse, validateShape } from './release-envelope.mjs';

const domain = Buffer.from('lnwjud-update-release-identity-v1\0', 'ascii');
const expectedSchemaHash = '35349e5d31e1cab882e18c5c4808d8f65a6ca6a21200d3f0ea78507bb8e47458';
let schemaText;
try {
  schemaText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(new URL('../../config/update-release-identity-v1.json', import.meta.url))).replace(/\r\n/g, '\n');
} catch { refuse('RELEASE_IDENTITY_SCHEMA_VERSION_MISMATCH'); }
const schemaBytes = Buffer.from(schemaText, 'utf8');
if (hash(schemaBytes) !== expectedSchemaHash) refuse('RELEASE_IDENTITY_SCHEMA_VERSION_MISMATCH');
const schema = parseStrictJson(schemaBytes, 65536, 12);

export function encodeReleaseIdentity(bytes) {
  const release = parseStrictJson(bytes, schema.limits.payloadBytes, schema.limits.maxDepth);
  validateShape(release, 'release', schema);
  const chunks = [domain];
  const count = number => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(number);
    chunks.push(bytes);
  };
  const text = value => {
    const bytes = Buffer.from(value, 'utf8');
    count(bytes.length);
    chunks.push(bytes);
  };
  const object = (name, value) => {
    const fields = schema.objects[name].fields;
    const names = Object.keys(fields).sort();
    chunks.push(Buffer.from('O'));
    count(names.length);
    for (const key of names) {
      text(key);
      const field = fields[key];
      if (field.kind === 'object') object(field.object, value[key]);
      else if (field.kind === 'string') { chunks.push(Buffer.from('S')); text(value[key]); }
      else refuse('RELEASE_SCHEMA_UNSUPPORTED');
    }
  };
  object('release', release);
  return Buffer.concat(chunks);
}

export function releaseIdentity(bytes) {
  return hash(encodeReleaseIdentity(bytes));
}
