// store.ts — the forge's in-memory state: repositories, git objects, refs, issues,
// pull requests, labels and comments, plus the git operations the surfaces share
// (tree building, file commits, diffs, squash merges, reachability).
//
// Determinism: the store keeps no wall clock. Every timestamp comes from a logical
// counter that starts at the scenario epoch and ticks once per timestamped event, so
// the same requests in the same order produce the same bytes in both passes of a trial.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { DEFAULT_BRANCH, SCENARIO_EPOCH_SEC, VIEWER } from './scenario.ts';

export { ZERO_OID };

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One counter for issues and pull requests, as GitHub numbers them together. */
  nextNumber: number;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** ISO 8601 (UTC) for a Unix timestamp, computed arithmetically — no Date anywhere. */
export function isoFromSeconds(sec: number): string {
  const days = Math.floor(sec / 86400);
  const rem = sec - days * 86400;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem % 3600) / 60);
  const ss = rem % 60;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss)}Z`;
}

/** An opaque, stable Relay-style global id: base64 of "<kind>:<parts...>". */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back into [kind, ...parts], or null when it is not one. */
export function parseGlobalId(id: string): [string, string[]] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return [parts[0] as string, parts.slice(1)];
  } catch {
    return null;
  }
}

export class Store {
  /** Repositories by name (every repository belongs to the viewer). */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;
  /** The logical clock: seconds since the epoch, ticking once per timestamped event. */
  private clockSec = SCENARIO_EPOCH_SEC;
  private requestSeq = 0;

  /** The next logical timestamp (seconds), advancing the clock. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** The next logical timestamp as an ISO string. */
  tickIso(): string {
    return isoFromSeconds(this.tick());
  }

  /** The current logical time as an ISO string, without advancing. */
  nowIso(): string {
    return isoFromSeconds(this.clockSec);
  }

  /** A non-empty request id for X-GitHub-Request-Id (deterministic, per request). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const now = this.tickIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      nextNumber: 1,
      createdSeq: this.nextSeq,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextIssueDbId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  nextCommentDbId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// -------------------------------------------------------------------------------------------
// git objects on a repository
// -------------------------------------------------------------------------------------------

/** Store an object (when absent) and return its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Resolve a ref through annotated tags to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Whether `ancestor` is reachable from `descendant` following commit parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const target = peelToCommit(repo, descendant);
  if (target === null) return false;
  const seen = new Set<string>();
  const queue: string[] = [target];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The object ids of a whole tree closure (the tree, its subtrees and its blobs). */
export function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    into.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else into.add(entry.oid);
    }
  }
}

export interface ReachableResult {
  /** Every object id reachable from the roots (commits, trees, blobs, tags). */
  ids: Set<string>;
  /** Commits whose parents were cut by the depth limit (the shallow-info boundary). */
  boundary: string[];
  /** The commits included. */
  commits: Set<string>;
}

/**
 * The closure of `roots`: commits (following parents, depth-limited), their trees and
 * blobs, and tag targets. `stopAt` commits are included but their parents are not
 * traversed (a shallow clone's held boundary); `depth` counts generations from a root.
 */
export function collectReachable(
  repo: Repo,
  roots: readonly string[],
  opts: { depth?: number; stopAt?: ReadonlySet<string> } = {},
): ReachableResult {
  const ids = new Set<string>();
  const boundary: string[] = [];
  const commits = new Set<string>();
  const seen = new Set<string>();
  const queue: { oid: string; dist: number }[] = roots.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    ids.add(oid);
    if (obj.type === 'tag') {
      queue.push({ oid: parseTag(obj.data).object, dist });
      continue;
    }
    if (obj.type !== 'commit') continue;
    commits.add(oid);
    const commit = parseCommit(obj.data);
    addTreeClosure(repo, commit.tree, ids);
    const cut = opts.depth !== undefined && dist + 1 >= opts.depth;
    const stop = opts.stopAt !== undefined && opts.stopAt.has(oid);
    if (commit.parents.length > 0 && cut) boundary.push(oid);
    if (cut || stop) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return { ids, boundary, commits };
}

/** A repo's whole file tree as path -> {oid, mode}, flattened from a tree object. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the tree objects for a flat path map; returns the root tree id. */
export function buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface DirNode {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const serialize = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: serialize(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return serialize(root);
}

/** Create a commit object on a repo (author/committer are the viewer, logical time). */
export function makeCommit(
  store: Store,
  repo: Repo,
  fields: { tree: string; parents: readonly string[]; message: string },
): string {
  const ts = store.tick();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const data = buildCommit({ tree: fields.tree, parents: fields.parents, author: ident, committer: ident, message: fields.message });
  return putObject(repo, 'commit', data);
}

/**
 * Commit one file on a branch (creating the branch from the default tip when it does
 * not exist, and the repository's first commit when there is no tip at all).
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string; created: boolean } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const baseTree = tip === undefined ? null : parseCommit((repo.objects.get(tip) as GitObject).data).tree;
  const files = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const created = !files.has(path);
  const contentSha = putObject(repo, 'blob', content);
  files.set(path, { oid: contentSha, mode: '100644' });
  const tree = buildTreeFromMap(repo, files);
  const commitSha = makeCommit(store, repo, { tree, parents: tip === undefined ? [] : [tip], message });
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha, created };
}

/** Delete one file from a branch's tip, committing the removal. Returns null when absent. */
export function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const baseTree = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
  const files = flattenTree(repo, baseTree);
  if (!files.has(path)) return null;
  files.delete(path);
  const tree = buildTreeFromMap(repo, files);
  const commitSha = makeCommit(store, repo, { tree, parents: [tip], message });
  repo.refs.set(ref, commitSha);
  return { commitSha };
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (null = the empty tree). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): DiffEntry[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/** The commit list reachable from `tip`, newest first (parents after the commit). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** Whether a pull request merges cleanly, and why not when it does not. */
export function mergeConflict(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) return 'the base branch no longer exists';
  const baseCommit = peelToCommit(repo, pull.base.sha);
  const headCommit = peelToCommit(repo, pull.head.sha);
  if (baseCommit === null || headCommit === null) return 'a pull request endpoint is missing';
  const baseTree = parseCommit((repo.objects.get(baseCommit) as GitObject).data).tree;
  const headTree = parseCommit((repo.objects.get(headCommit) as GitObject).data).tree;
  const currentTree = parseCommit((repo.objects.get(peelToCommit(repo, baseTip) as string) as GitObject).data).tree;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const currentFiles = flattenTree(repo, currentTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    const baseBlob = baseFiles.get(change.path)?.oid ?? null;
    const headBlob = headFiles.get(change.path)?.oid ?? null;
    const currentBlob = currentFiles.get(change.path)?.oid ?? null;
    if (currentBlob !== baseBlob && currentBlob !== headBlob) {
      return `conflict in ${change.path}`;
    }
  }
  return null;
}

/**
 * Squash-merge a pull request onto its base branch: the merged tree is the base tip's
 * tree with the pull's diff applied. Returns the merge commit id, or null on conflict.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  if (mergeConflict(repo, pull) !== null) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) as string;
  const baseCommit = peelToCommit(repo, pull.base.sha) as string;
  const headCommit = peelToCommit(repo, pull.head.sha) as string;
  const baseTree = parseCommit((repo.objects.get(baseCommit) as GitObject).data).tree;
  const headTree = parseCommit((repo.objects.get(headCommit) as GitObject).data).tree;
  const currentTree = parseCommit((repo.objects.get(peelToCommit(repo, baseTip) as string) as GitObject).data).tree;
  const files = flattenTree(repo, currentTree);
  const headFiles = flattenTree(repo, headTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    if (change.status === 'removed') files.delete(change.path);
    else {
      const entry = headFiles.get(change.path);
      if (entry !== undefined) files.set(change.path, entry);
    }
  }
  const tree = buildTreeFromMap(repo, files);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
  const mergeSha = makeCommit(store, repo, { tree, parents: [baseTip], message });
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.tickIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = store.nowIso();
  return mergeSha;
}

/** Create an issue record on a repo (shared by REST, GraphQL and MCP). */
export function createIssueRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: Label[],
): Issue {
  const now = store.tickIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: store.nextIssueDbId(),
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Create a comment record on an issue (shared by REST, GraphQL and MCP). */
export function createCommentRecord(store: Store, issue: Issue, body: string): IssueComment {
  const now = store.tickIso();
  const comment: IssueComment = { id: store.nextCommentDbId(), body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  return comment;
}

/** Create a pull request record on a repo (shared by REST, GraphQL and MCP). */
export function createPullRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const now = store.tickIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title,
    body,
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Resolve a global id to its record: ['Repository', repoId] / ['Issue', repoId, number] / ... */
export function resolveGlobalId(
  store: Store,
  id: string,
): { kind: string; repo: Repo; issue?: Issue; pull?: Pull; comment?: IssueComment } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const [kind, parts] = parsed;
  if (kind === 'Repository' && parts.length === 1) {
    const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(parts[0]));
    return repo === undefined ? null : { kind, repo };
  }
  if ((kind === 'Issue' || kind === 'PullRequest' || kind === 'IssueComment') && parts.length >= 2) {
    const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(parts[0]));
    if (repo === undefined) return null;
    if (kind === 'Issue') {
      const issue = repo.issues.get(Number(parts[1]));
      return issue === undefined ? null : { kind, repo, issue };
    }
    if (kind === 'PullRequest') {
      const pull = repo.pulls.get(Number(parts[1]));
      return pull === undefined ? null : { kind, repo, pull };
    }
    const issue = repo.issues.get(Number(parts[1]));
    if (issue === undefined) return null;
    const comment = issue.comments.find((candidate) => candidate.id === Number(parts[2]));
    return comment === undefined ? null : { kind, repo, issue, comment };
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// JSON views (REST v3 shapes the checks read)
// -------------------------------------------------------------------------------------------

export function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: globalId('User', id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    has_issues: true,
    has_projects: true,
    has_discussions: false,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${repo.owner}:${pull.head.ref}`,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJsonForPull(repo),
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${repo.owner}:${pull.base.ref}`,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJsonForPull(repo),
    },
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    draft: false,
  };
}

function repoJsonForPull(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    default_branch: repo.defaultBranch,
  };
}
