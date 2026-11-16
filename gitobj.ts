// gitobj.ts — the git object layer: SHA-1 ids, object encode/decode, trees, commits,
// tags, packfiles (read with REF_DELTA/OFS_DELTA support, write plain), and pkt-lines.
//
// Everything here is pure and deterministic: object ids are SHA-1 over the canonical
// `"<type> <size>\\0<bytes>"` form, exactly as git computes them, so objects the entry
// builds hash identically to objects a real git client builds from the same bytes.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SHA40_RE = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function isObjectId(value: string): boolean {
  return SHA40_RE.test(value);
}

/** The SHA-1 of a git object: sha1("<type> <size>\\0" + data). */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The loose-object bytes of one object (its header + data). */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), Buffer.from(data)]);
}

// -------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const mode = Buffer.from(data.subarray(offset, space)).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no name terminator');
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Compare two tree entries in git's order (directories sort as name + '/'). */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Build a tree object's bytes from its entries (sorted in git order). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// commits and tags
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

/** Parse a commit object: headers (tree, parent*, author, committer, others) + message. */
export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: Buffer.from(data) };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a commit object's bytes. `parents` in order; `message` without trailing newline handling. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const lines: string[] = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger}`,
    '',
    fields.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

export interface PackReadResult {
  objects: Map<string, GitObject>;
  entries: GitObject[];
  declaredCount: number;
  version: number;
  deltaCount: number;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let next = start + 1;
  let baseOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next };
}

/** Inflate the zlib stream at `offset`; returns the data and the offset just past it. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes and throws on a truncated stream, so "the slice
  // inflates" is monotonic in the end offset: binary-search the smallest end that works.
  let lo = offset + 1;
  let hi = buffer.length;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = Buffer.from(zlibInflate(buffer.subarray(offset, mid)));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) throw new Error('truncated zlib stream in pack');
  return { data, next: lo };
}

/** Apply a git delta to its base object. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return size;
  };
  const baseSize = readSize();
  const resultSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(Buffer.from(base.subarray(copyOffset, copyOffset + copySize)));
      produced += copySize;
    } else if (op !== 0) {
      out.push(Buffer.from(delta.subarray(offset, offset + op)));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/** The pack's trailer SHA-1 (over everything before it). */
export function packChecksum(pack: Uint8Array): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** Whether the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const expected = packChecksum(pack);
  const actual = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  return { ok: expected === actual, expected, actual };
}

interface RawEntry {
  type: number;
  data: Buffer;
  oid: string;
  offset: number;
  refBase?: string;
  ofsBase?: number;
}

/**
 * Read a packfile: verify the trailer, inflate every entry, resolve REF_DELTA and
 * OFS_DELTA entries against their bases (from the pack itself, or from `resolveBase`
 * for thin packs). Returns the resolved objects by id.
 */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (Buffer.from(pack.subarray(0, 4)).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(Buffer.from(pack), offset);
    void size;
    const type = (first >> 4) & 0x07;
    offset = next;
    if (type === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(Buffer.from(pack), offset);
      offset = after;
      const { data, next: end } = inflateAt(pack, offset);
      offset = end;
      const entry: RawEntry = { type, data, oid: '', offset: entryOffset, ofsBase: entryOffset - baseOffset };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (type === 7) {
      const refBase = Buffer.from(pack.subarray(offset, offset + 20)).toString('hex');
      offset += 20;
      const { data, next: end } = inflateAt(pack, offset);
      offset = end;
      const entry: RawEntry = { type, data, oid: '', offset: entryOffset, refBase };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const { data, next: end } = inflateAt(pack, offset);
      offset = end;
      const oid = hashObject(CODE_TYPE[type] as GitObjectType, data);
      const entry: RawEntry = { type, data, oid, offset: entryOffset };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry, seen: Set<number>): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.type === 6 || entry.type === 7) {
      deltaCount += 1;
      if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
      seen.add(entry.offset);
      let base: { type: GitObjectType; data: Buffer; oid: string };
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.ofsBase as number);
        if (baseEntry === undefined) throw new Error('OFS_DELTA base outside pack');
        base = resolve(baseEntry, seen);
      } else {
        const baseEntry = raw.find((candidate) => candidate.oid === entry.refBase);
        if (baseEntry !== undefined) {
          base = resolve(baseEntry, seen);
        } else {
          const external = options.resolveBase?.(entry.refBase as string);
          if (external === undefined) throw new Error(`REF_DELTA base ${entry.refBase} not in pack`);
          base = { type: external.type, data: Buffer.from(external.data), oid: entry.refBase as string };
        }
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data, oid: hashObject(base.type, data) };
    }
    return { type: CODE_TYPE[entry.type] as GitObjectType, data: entry.data, oid: entry.oid };
  };
  const entries: GitObject[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry, new Set<number>());
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({ type: resolved.type, data: resolved.data });
  }
  return { objects, entries, declaredCount, version, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's; git does
 * not require a particular order. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(zlibDeflate(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

/** One pkt-line: 4 hex length digits (including the 4) + payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = bytes.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, bytes]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode several lines; 'flush'/'delim' entries become the control packets. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines (flush/delim/response-end included). */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const length = parseInt(Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('malformed pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush', raw: Buffer.from(bytes.subarray(offset, offset + 4)) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', raw: Buffer.from(bytes.subarray(offset, offset + 4)) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', raw: Buffer.from(bytes.subarray(offset, offset + 4)) });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({
        kind: 'data',
        payload: Buffer.from(bytes.subarray(offset + 4, offset + length)),
        raw: Buffer.from(bytes.subarray(offset, offset + length)),
      });
      offset += length;
    }
  }
  return packets;
}

/** A streaming pkt-line decoder: push chunks, pull packets out. */
export class PktLineDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
  }

  next(): GitPacket | null {
    if (this.#buffer.length < 4) return null;
    const length = parseInt(this.#buffer.subarray(0, 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('malformed pkt-line length');
    if (length === 0) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', raw: Buffer.from(raw) };
    }
    if (length === 1) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', raw: Buffer.from(raw) };
    }
    if (length === 2) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'response-end', raw: Buffer.from(raw) };
    }
    if (this.#buffer.length < length) return null;
    const raw = this.#buffer.subarray(0, length);
    const payload = this.#buffer.subarray(4, length);
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload: Buffer.from(payload), raw: Buffer.from(raw) };
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new Error('trailing bytes after pkt-line stream');
  }
}
