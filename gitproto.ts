// gitproto.ts — git smart HTTP: ref advertisements (protocol v0 and v2),
// upload-pack (fetch, v0 and v2, including shallow) and receive-pack (push with
// report-status). The wire shapes follow the suite's git-client.ts exactly:
// v2 advertisements start with `version 2`, v0 with `# service=...` + flush,
// ls-refs answers HEAD with symref-target and peeled tags, fetches answer
// acknowledgments / shallow-info / packfile sections with sideband framing,
// and pushes answer a sideband-framed report-status stream.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseTag,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import {
  collectReachable,
  getObject,
  isAncestor,
  peelToCommit,
  type Repo,
  type Store,
} from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function result(status: number, contentType: string, body: Buffer): HttpResult {
  return { status, contentType, body };
}

function textResult(status: number, text: string): HttpResult {
  return result(status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref names of a repo (heads then tags, each sorted). */
export function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The commit a tag object peels to, or null when the ref is not an annotated tag. */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

/** A v0 ref advertisement: service line, flush, ref lines (caps on the first), flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const lines: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const names = sortedRefNames(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  const emitRef = (name: string, oid: string, first: boolean): void => {
    lines.push(encodePktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
    const peeled = peeledOid(repo, oid);
    if (peeled !== null) lines.push(encodePktLine(`${peeled} ${name}^{}\n`));
  };
  if (names.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainTip !== undefined) {
      emitRef('HEAD', mainTip, first);
      first = false;
    }
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      emitRef(name, oid, first);
      first = false;
    }
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

/** A v2 capability advertisement: `version 2`, one line per capability, flush. */
function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — the ref/capability advertisement.
 * Upload-pack honours `Git-Protocol: version=2`; receive-pack is v0-only.
 */
export function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): HttpResult {
  if (service === 'git-receive-pack') {
    return result(200, RECEIVE_AD, v0Advertisement(repo, service));
  }
  if (gitProtocol !== undefined && gitProtocol.trim() === 'version=2') {
    return result(200, UPLOAD_AD, v2Advertisement());
  }
  return result(200, UPLOAD_AD, v0Advertisement(repo, service));
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

function sidebandPackets(pack: Buffer): Buffer {
  // One band-1 pkt-line per chunk; a pkt-line is at most 65520 bytes, so a chunk
  // carries at most 65515 pack bytes behind its 1 band byte.
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** Build the pack for a fetch: wanted objects minus held ones, in oid order. */
function buildFetchPack(
  repo: Repo,
  args: FetchArgs,
): { pack: Buffer; boundary: string[]; unshallow: string[]; common: string[] } {
  const held = collectReachable(repo, args.haves, { stopAt: new Set(args.shallow) }).ids;
  const wanted = collectReachable(repo, args.wants, { depth: args.depth ?? undefined });
  const send: GitObject[] = [];
  for (const oid of [...wanted.ids].sort()) {
    if (held.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj !== undefined) send.push(obj);
  }
  const pack = writePack(send);
  const unshallow = args.shallow.filter((oid) => wanted.commits.has(oid) && !wanted.boundary.includes(oid));
  const common = args.haves.filter((oid) => wanted.ids.has(oid));
  return { pack, boundary: wanted.boundary, unshallow, common };
}

function handleFetchV2(repo: Repo, args: FetchArgs): HttpResult {
  const { pack, boundary, unshallow, common } = buildFetchPack(repo, args);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (common.length > 0) {
    for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineDelim());
  if (boundary.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of boundary) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPackets(pack));
  parts.push(pktLineFlush());
  return result(200, UPLOAD_RESULT, Buffer.concat(parts));
}

function handleFetchV0(repo: Repo, args: FetchArgs): HttpResult {
  const { pack, boundary, unshallow, common } = buildFetchPack(repo, args);
  const parts: Buffer[] = [];
  if (common.length > 0) {
    for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of boundary) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPackets(pack));
  parts.push(pktLineFlush());
  return result(200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** v2 ls-refs: HEAD with symref-target, peeled tags, server-side ref-prefix filtering. */
function handleLsRefs(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; prefixes: string[] },
): HttpResult {
  const names = sortedRefNames(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (mainTip !== undefined && keep('HEAD')) {
    lines.push(opts.symrefs ? `${mainTip} HEAD symref-target:refs/heads/main\n` : `${mainTip} HEAD\n`);
  }
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktLineFlush());
  return result(200, UPLOAD_RESULT, Buffer.concat(parts));
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack — a v2 command request or a v0
 * want/have request. A body that is not a pkt-line stream is a 400; the server
 * stays up for the next request either way.
 */
export function handleUploadPack(repo: Repo, body: Buffer): HttpResult {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return textResult(400, 'malformed pkt-line stream');
  }
  const dataLines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    dataLines.push(packet.payload.toString('utf8'));
  }
  if (dataLines.length === 0) return textResult(400, 'empty upload-pack request');
  const first = dataLines[0] as string;

  // --- protocol v2: `command=ls-refs` / `command=fetch`, args after the delim.
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    // Split the request at the delim packet: everything before it is the command
    // section (agent/object-format lines), everything after it is the arguments.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex < 0 ? [] : packets.slice(delimIndex + 1);
    const args: string[] = [];
    for (const packet of argPackets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const arg of args) {
        if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
        else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      return handleLsRefs(repo, { peel, symrefs, prefixes });
    }
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const n = Number.parseInt(arg.slice(7).trim(), 10);
          if (Number.isFinite(n)) fetchArgs.depth = n;
        } else if (arg === 'thin-pack') fetchArgs.thinPack = true;
      }
      if (fetchArgs.wants.some((oid) => !isObjectId(oid))) return textResult(400, 'fetch wants a bad object id');
      return handleFetchV2(repo, fetchArgs);
    }
    return textResult(400, `unknown upload-pack command ${command}`);
  }

  // --- protocol v0: wants (with shallow/deepen) to the first flush, then haves + done.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  const wantSection = sections[0] ?? [];
  for (const line of wantSection) {
    // The first want line may carry capabilities after a space; later lines too.
    const [head, ...caps] = line.split(' ');
    if (head === 'want' && caps.length > 0) {
      const oid = caps[0] as string;
      if (isObjectId(oid)) fetchArgs.wants.push(oid);
      const features = caps.slice(1).join(' ');
      if (features.includes('thin-pack')) fetchArgs.thinPack = true;
    } else if (line.startsWith('want ')) {
      fetchArgs.wants.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      fetchArgs.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) fetchArgs.depth = n;
    }
  }
  const haveSection = sections[1] ?? [];
  for (const line of haveSection) {
    if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
  }
  if (fetchArgs.wants.length === 0) return textResult(400, 'fetch with no wants');
  if (fetchArgs.wants.some((oid) => !isObjectId(oid))) return textResult(400, 'fetch wants a bad object id');
  return handleFetchV0(repo, fetchArgs);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack — v0 only. Command pkt-lines to the
 * flush, then the pack. Every command is validated (fast-forward for branches)
 * and reported per-ref; a refused ref never moves, and the pack's objects stay
 * stored either way.
 */
export function handleReceivePack(repo: Repo, body: Buffer): HttpResult {
  // Scan pkt-lines by hand: the pack follows the flush packet as raw bytes, so the
  // body as a whole is not a pkt-line stream.
  const commands: PushCommand[] = [];
  let offset = 0;
  let flushFound = false;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) return textResult(400, 'malformed pkt-line stream');
    if (len === 0) {
      offset += 4;
      flushFound = true;
      break;
    }
    if (len < 4 || offset + len > body.length) return textResult(400, 'truncated pkt-line stream');
    const line = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length < 3) return textResult(400, 'malformed receive-pack command');
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    offset += len;
  }
  if (!flushFound) return textResult(400, 'receive-pack with no flush');
  if (commands.length === 0) return textResult(400, 'receive-pack with no commands');
  const packBytes = body.subarray(offset);

  // Unpack first: a refused update still unpacks, and the report says so.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  }
  const report = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += 65515) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktLineFlush());
  return result(200, RECEIVE_RESULT, Buffer.concat(parts));
}

/** Validate and apply one push command; returns the refusal reason or null. */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\u0000-\u001f]/.test(ref)) return 'invalid ref';
  if (!isObjectId(oldOid) || !isObjectId(newOid)) return 'bad object id';
  const current = repo.refs.get(ref);
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return 'already exists';
  } else if (current !== oldOid) {
    return 'old ref value does not match';
  }
  if (newOid === ZERO_OID) {
    if (current === undefined) return 'remote ref does not exist';
    repo.refs.delete(ref);
    return null;
  }
  const obj = getObject(repo, newOid);
  if (obj === undefined) return 'object not found';
  if (oldOid !== ZERO_OID && ref.startsWith('refs/heads/')) {
    // Fast-forward only: the new tip must descend from the old one.
    if (!isAncestor(repo, oldOid, newOid)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}
