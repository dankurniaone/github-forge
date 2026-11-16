// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (the
// app layer adds those headers); errors carry {"message": string}; a missing
// token is 401 (the app layer enforces it); a repository under any owner but
// the token's is 404, never 403.

import {
  isObjectId,
  parseCommit,
  parseTree,
} from './gitobj.ts';
import {
  commentJson,
  commitFile,
  createCommentRecord,
  createIssueRecord,
  createPullRecord,
  deleteFile,
  diffTrees,
  flattenTree,
  getObject,
  issueJson,
  isoFromSeconds,
  listCommits,
  mergeConflict,
  pullJson,
  repoJson,
  squashMerge,
  userJson,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { DEFAULT_BRANCH, VIEWER } from './scenario.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments under /api/v3 (['repos', owner, name, ...]). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown | null;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(message = 'Not Found'): RestResult {
  return err(404, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function strField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/** Paginate a list: slice + a Link header (absolute, same-origin) when more pages exist. */
function paginate<T>(
  req: RestRequest,
  items: readonly T[],
  basePath: string,
): { page: T[]; headers: Record<string, string> } {
  const rawPerPage = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  const rawPage = Number.parseInt(req.query.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${req.host}${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: items.slice(start, start + perPage), headers: { link: links.join(', ') } };
}

/** A repository the token may read: the owner must be the viewer and it must exist. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(name) ?? null;
}

/** Resolve a ref (branch name or commit sha) to a commit id, or null. */
function resolveRefToCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ?? null;
  }
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (isObjectId(ref)) {
    const obj = getObject(repo, ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return null;
}

/** The author/committer view of a commit ident line (`Name <email> ts +0000`). */
function identJson(ident: string): Record<string, unknown> {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: isoFromSeconds(Number.parseInt(match[3] as string, 10)),
  };
}

function lineCount(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

export function handleRest(store: Store, req: RestRequest): RestResult {
  const [first, second, third] = req.segments;
  const method = req.method;

  // --- API root and meta -------------------------------------------------------
  if (req.segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (first === 'meta' && req.segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // --- the token's own user ----------------------------------------------------
  if (first === 'user' && req.segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      ...userJson(VIEWER.login, VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      company: null,
      blog: '',
      location: null,
      bio: null,
      public_repos: store.listRepos().length,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: store.nowIso(),
    });
  }

  // --- POST /user/repos, GET /user/repos ---------------------------------------
  if (first === 'user' && second === 'repos' && req.segments.length === 2) {
    if (method === 'POST') {
      const body = bodyOf(req);
      const name = strField(body, 'name');
      if (name === undefined || name === '') return err(422, 'name is required');
      if (store.getRepo(name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, strField(body, 'description') ?? '', body['private'] === true);
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(repo));
    }
    if (method === 'GET') {
      const { page, headers } = paginate(req, store.listRepos(), '/api/v3/user/repos');
      return ok(200, page.map((repo) => repoJson(repo)), headers);
    }
    return notFound();
  }

  // --- /repos/{owner}/{name}/... ----------------------------------------------
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const repo = findRepo(store, second, third);
    if (repo === null) return notFound();
    const tail = req.segments.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = bodyOf(req);
        const description = strField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body['private'] === 'boolean') repo.private = body['private'] as boolean;
        repo.updatedAt = store.nowIso();
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.name);
        return { status: 204, body: null };
      }
      return notFound();
    }

    const [sub, sub2, ...subRest] = tail;

    // Branches.
    if (sub === 'branches' && sub2 === undefined) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string } }));
      return ok(200, branches);
    }
    if (sub === 'branches' && sub2 !== undefined && subRest.length === 0) {
      if (method !== 'GET') return notFound();
      const sha = repo.refs.get(`refs/heads/${sub2}`);
      if (sha === undefined) return notFound();
      return ok(200, { name: sub2, commit: { sha } });
    }

    // Commits.
    if (sub === 'commits' && sub2 === undefined) {
      if (method !== 'GET') return notFound();
      const tip = resolveRefToCommit(repo, req.query.get('sha'));
      if (tip === null) return ok(200, []);
      const commits = listCommits(repo, tip).map((sha) => {
        const commit = parseCommit((getObject(repo, sha) as { data: Buffer }).data);
        return {
          sha,
          commit: {
            message: commit.message,
            author: identJson(commit.author),
            committer: identJson(commit.committer),
            tree: { sha: commit.tree },
          },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        };
      });
      return ok(200, commits);
    }

    // Git Data: refs.
    if (sub === 'git' && sub2 === 'refs' && subRest.length === 0) {
      if (method === 'POST') {
        const body = bodyOf(req);
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'invalid ref');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const obj = getObject(repo, sha);
        if (obj === undefined) return err(422, 'object not found');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: obj.type } });
      }
      if (method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((name) => {
          const sha = repo.refs.get(name) as string;
          const obj = getObject(repo, sha);
          return { ref: name, object: { sha, type: obj === undefined ? 'commit' : obj.type } };
        });
        return ok(200, refs);
      }
      return notFound();
    }
    if (sub === 'git' && sub2 === 'refs' && subRest.length >= 2 && subRest[0] === 'heads') {
      if (method !== 'GET') return notFound();
      const branch = subRest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      const obj = getObject(repo, sha);
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: obj === undefined ? 'commit' : obj.type } });
    }

    // Contents.
    if (sub === 'contents') {
      const path = [sub2, ...subRest].filter((part) => part !== undefined).join('/');
      if (method === 'GET') return contentsGet(store, repo, path, req.query.get('ref'));
      if (method === 'PUT') return contentsPut(store, repo, path, bodyOf(req));
      if (method === 'DELETE') return contentsDelete(store, repo, path, bodyOf(req));
      return notFound();
    }

    // Labels.
    if (sub === 'labels' && sub2 === undefined) {
      if (method !== 'POST') return notFound();
      const body = bodyOf(req);
      const name = strField(body, 'name');
      if (name === undefined || name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, { name: existing.name, color: existing.color });
      const label = { name, color: strField(body, 'color') ?? 'ededed' };
      repo.labels.set(name, label);
      return ok(201, { name: label.name, color: label.color });
    }

    // Issues.
    if (sub === 'issues' && sub2 === undefined) {
      if (method === 'GET') return issuesList(req, repo);
      if (method === 'POST') return issueCreate(store, repo, bodyOf(req));
      return notFound();
    }
    if (sub === 'issues' && sub2 !== undefined && subRest.length === 0) {
      const number = Number.parseInt(sub2, 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) return notFound();
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = bodyOf(req);
        const state = strField(body, 'state');
        if (state !== undefined) {
          if (state !== 'open' && state !== 'closed') return err(422, 'invalid state');
          issue.state = state;
        }
        const title = strField(body, 'title');
        if (title !== undefined) issue.title = title;
        const text = strField(body, 'body');
        if (text !== undefined) issue.body = text;
        issue.updatedAt = store.nowIso();
        return ok(200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (sub === 'issues' && sub2 !== undefined && subRest[0] === 'comments' && subRest.length === 1) {
      const number = Number.parseInt(sub2, 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      }
      if (method === 'POST') {
        const body = bodyOf(req);
        const text = strField(body, 'body');
        if (text === undefined) return err(422, 'body is required');
        const comment = createCommentRecord(store, issue, text);
        return ok(201, commentJson(repo, issue, comment));
      }
      return notFound();
    }

    // Pull requests.
    if (sub === 'pulls' && sub2 === undefined) {
      if (method === 'GET') return pullsList(req, repo);
      if (method === 'POST') return pullCreate(store, repo, bodyOf(req));
      return notFound();
    }
    if (sub === 'pulls' && sub2 !== undefined && subRest.length === 0) {
      const number = Number.parseInt(sub2, 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return notFound();
      if (method !== 'GET') return notFound();
      return ok(200, pullJson(repo, pull));
    }
    if (sub === 'pulls' && sub2 !== undefined && subRest[0] === 'files' && subRest.length === 1) {
      if (method !== 'GET') return notFound();
      const number = Number.parseInt(sub2, 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return notFound();
      return ok(200, pullFiles(repo, pull));
    }
    if (sub === 'pulls' && sub2 !== undefined && subRest[0] === 'merge' && subRest.length === 1) {
      if (method !== 'PUT') return notFound();
      const number = Number.parseInt(sub2, 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return notFound();
      if (pull.merged) return err(405, 'Pull request already merged');
      if (mergeConflict(repo, pull) !== null) return err(405, 'Merge conflict');
      const sha = squashMerge(store, repo, pull);
      if (sha === null) return err(405, 'Merge conflict');
      return ok(200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged` });
    }
  }

  return notFound();
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function contentsGet(store: Store, repo: Repo, path: string, ref: string | null): RestResult {
  const tip = resolveRefToCommit(repo, ref);
  if (tip === null) return notFound();
  const treeOid = parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
  if (path === '') {
    return ok(200, directoryEntries(repo, treeOid, ''));
  }
  const parts = path.split('/');
  let currentTree = treeOid;
  let currentPath = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
    const obj = getObject(repo, currentTree);
    if (obj === undefined) return notFound();
    const entry = parseTree(obj.data).find((candidate) => candidate.name === part);
    if (entry === undefined) return notFound();
    const last = i === parts.length - 1;
    if (entry.mode === '40000') {
      if (last) return ok(200, directoryEntries(repo, entry.oid, currentPath));
      currentTree = entry.oid;
    } else {
      if (!last) return notFound();
      const blob = getObject(repo, entry.oid);
      if (blob === undefined) return notFound();
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: part,
        path: currentPath,
        content: blob.data.toString('base64'),
        sha: entry.oid,
      });
    }
  }
  return notFound();
}

function directoryEntries(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = getObject(repo, treeOid);
  if (obj === undefined) return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (getObject(repo, entry.oid)?.data.length ?? 0),
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
  }));
}

function contentsPut(store: Store, repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const message = strField(body, 'message') ?? 'Update file';
  const content = strField(body, 'content');
  if (content === undefined) return err(422, 'content is required');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  const branch = strField(body, 'branch') ?? DEFAULT_BRANCH;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const sha = strField(body, 'sha');
  if (sha !== undefined) {
    if (tip === undefined) return err(409, 'sha does not match the current file');
    const treeOid = parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
    const current = flattenTree(repo, treeOid).get(path);
    if (current === undefined || current.oid !== sha) return err(409, 'sha does not match the current file');
  }
  const result = commitFile(store, repo, branch, path, bytes, message);
  const status = result.created ? 201 : 200;
  return ok(status, {
    content: {
      name: path.split('/').pop() as string,
      path,
      sha: result.contentSha,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: result.commitSha, message },
  });
}

function contentsDelete(store: Store, repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const branch = strField(body, 'branch') ?? DEFAULT_BRANCH;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return notFound();
  const treeOid = parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
  const current = flattenTree(repo, treeOid).get(path);
  if (current === undefined) return notFound();
  const sha = strField(body, 'sha');
  if (sha !== undefined && sha !== current.oid) return err(409, 'sha does not match the current file');
  const message = strField(body, 'message') ?? 'Delete file';
  const result = deleteFile(store, repo, branch, path, message);
  if (result === null) return notFound();
  return ok(200, { commit: { sha: result.commitSha, message } });
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function issuesList(req: RestRequest, repo: Repo): RestResult {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return err(422, 'invalid state');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, headers } = paginate(req, issues, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return ok(200, page.map((issue) => issueJson(repo, issue)), headers);
}

function issueCreate(store: Store, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = strField(body, 'title');
  if (title === undefined || title === '') return err(422, 'title is required');
  const labels: { name: string; color: string }[] = [];
  const wanted = body['labels'];
  if (Array.isArray(wanted)) {
    for (const name of wanted) {
      if (typeof name !== 'string') continue;
      const label = repo.labels.get(name);
      if (label === undefined) return err(422, `label ${name} does not exist`);
      labels.push(label);
    }
  }
  const issue = createIssueRecord(store, repo, title, strField(body, 'body') ?? '', labels);
  return ok(201, issueJson(repo, issue));
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function pullsList(req: RestRequest, repo: Repo): RestResult {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') return err(422, 'invalid state');
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(req, pulls, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return ok(200, page.map((pull) => pullJson(repo, pull)), headers);
}

function pullCreate(store: Store, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = strField(body, 'title');
  const head = strField(body, 'head');
  const base = strField(body, 'base') ?? repo.defaultBranch;
  if (title === undefined || head === undefined) return err(422, 'title and head are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head.ref === head && existing.base.ref === base) {
      return err(422, 'a pull request already exists for this head and base');
    }
  }
  const pull = createPullRecord(store, repo, title, strField(body, 'body') ?? '', head, base);
  if (pull === null) return err(422, 'head or base branch does not exist');
  return ok(201, pullJson(repo, pull));
}

function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseCommit = parseCommit((getObject(repo, pull.base.sha) as { data: Buffer }).data);
  const headCommit = parseCommit((getObject(repo, pull.head.sha) as { data: Buffer }).data);
  const changes = diffTrees(repo, baseCommit.tree, headCommit.tree);
  return changes.map((change) => {
    const oldContent = change.oldOid === null ? '' : (getObject(repo, change.oldOid)?.data.toString('utf8') ?? '');
    const newContent = change.newOid === null ? '' : (getObject(repo, change.newOid)?.data.toString('utf8') ?? '');
    const additions = change.status === 'removed' ? 0 : lineCount(newContent);
    const deletions = change.status === 'added' ? 0 : lineCount(oldContent);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.head.sha}/${change.path}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.head.sha}/${change.path}`,
    };
  });
}
