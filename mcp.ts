// mcp.ts — Model Context Protocol endpoint (Streamable HTTP) at POST /mcp.
// The checks run against the era 2026-07-28 revision: `server/discover` is the
// primary handshake (it also answers `initialize` for older clients). Six tools
// cover repos, issues and pull requests; they share the REST store, so MCP
// changes are visible to REST/GraphQL and vice versa. Tool list is a constant
// (two tools/list calls are byte-identical), auth is the app layer's job.

import {
  createIssueRecord,
  createPullRecord,
  mergeConflict,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

interface McpResult {
  status: number;
  body: unknown;
  // Notifications get no JSON-RPC body back.
  empty?: boolean;
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(id: unknown, value: unknown, isError = false): McpResult {
  const text = JSON.stringify(value);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  });
}

function repoFor(store: Store, owner: unknown, repoName: unknown): Repo | null {
  if (owner !== VIEWER.login || typeof repoName !== 'string') return null;
  const repo = store.getRepo(repoName);
  return repo === undefined ? null : repo;
}

function executeTool(store: Store, id: unknown, name: string, args: Record<string, unknown>): McpResult {
  const match = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (match === undefined) return rpcError(id, -32602, `unknown tool ${name}`);
  const required = REQUIRED[match.name] ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return toolResult(id, { error: `missing required argument ${key}` }, true);
    }
  }
  if (match.name === 'create_repo') {
    const repoName = args['name'] as string;
    if (store.getRepo(repoName) !== undefined) {
      return toolResult(id, { error: 'a repository already exists with that name' }, true);
    }
    const repo = store.createRepo(repoName, typeof args['description'] === 'string' ? (args['description'] as string) : '', args['private'] === true);
    return toolResult(id, {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      default_branch: repo.defaultBranch,
      description: repo.description,
      private: repo.isPrivate,
    });
  }
  if (match.name === 'get_repo') {
    const repo = repoFor(store, args['owner'], args['repo']);
    if (repo === null) return toolResult(id, { error: 'repository not found' }, true);
    return toolResult(id, {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      default_branch: repo.defaultBranch,
      description: repo.description,
      private: repo.isPrivate,
    });
  }
  if (match.name === 'create_issue') {
    const repo = repoFor(store, args['owner'], args['repo']);
    if (repo === null) return toolResult(id, { error: 'repository not found' }, true);
    const issue = createIssueRecord(
      store,
      repo,
      args['title'] as string,
      typeof args['body'] === 'string' ? (args['body'] as string) : '',
      [],
    );
    return toolResult(id, {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      full_name: `${repo.owner}/${repo.name}`,
      repository: repo.name,
    });
  }
  if (match.name === 'list_issues') {
    const repo = repoFor(store, args['owner'], args['repo']);
    if (repo === null) return toolResult(id, { error: 'repository not found' }, true);
    const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
    return toolResult(id, issues);
  }
  if (match.name === 'create_pull_request') {
    const repo = repoFor(store, args['owner'], args['repo']);
    if (repo === null) return toolResult(id, { error: 'repository not found' }, true);
    const pull = createPullRecord(
      store,
      repo,
      args['title'] as string,
      '',
      args['head'] as string,
      args['base'] as string,
    );
    if (pull === null) return toolResult(id, { error: 'head or base branch does not exist' }, true);
    return toolResult(id, {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      head: { ref: pull.head.ref, sha: pull.head.sha },
      base: { ref: pull.base.ref, sha: pull.base.sha },
      full_name: `${repo.owner}/${repo.name}`,
      repository: repo.name,
    });
  }
  if (match.name === 'merge_pull_request') {
    const repo = repoFor(store, args['owner'], args['repo']);
    if (repo === null) return toolResult(id, { error: 'repository not found' }, true);
    const pullNumber = args['pull_number'] as number;
    const pull = repo.pulls.get(pullNumber);
    if (pull === undefined) return toolResult(id, { error: 'pull request not found' }, true);
    if (pull.merged) return toolResult(id, { error: 'pull request already merged' }, true);
    if (mergeConflict(repo, pull) !== null) return toolResult(id, { error: 'merge conflict' }, true);
    const sha = squashMerge(store, repo, pull);
    if (sha === null) return toolResult(id, { error: 'merge conflict' }, true);
    return toolResult(id, {
      number: pull.number,
      merged: true,
      sha,
      state: 'closed',
      full_name: `${repo.owner}/${repo.name}`,
      repository: repo.name,
    });
  }
  return rpcError(id, -32601, `method not found: ${name}`);
}

export function handleMcp(store: Store, body: unknown): McpResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = body as Record<string, unknown>;
  const method = request['method'];
  const id = request['id'] ?? null;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized') {
    // A notification: no JSON-RPC body back (HTTP 202, empty).
    return { status: 202, body: null, empty: true };
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = request['params'];
    if (params === null || typeof params !== 'object') return rpcError(id, -32602, 'params must be an object');
    const paramsRecord = params as Record<string, unknown>;
    const toolName = paramsRecord['name'];
    if (typeof toolName !== 'string') return rpcError(id, -32602, 'tools/call needs a name');
    const args = (paramsRecord['arguments'] ?? {}) as Record<string, unknown>;
    return executeTool(store, id, toolName, args);
  }
  return rpcError(id, -32601, `method not found: ${String(method)}`);
}
