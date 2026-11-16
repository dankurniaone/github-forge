// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send:
// viewer, repository reads, __type introspection, issue/pull-request reads,
// createIssue / closeIssue / createPullRequest / mergePullRequest / addComment,
// node(id:) round-trips, batched operation documents, and cursor pagination.
//
// A small hand-written parser covers the subset those documents use: operations
// with variables, aliases, arguments (variables, strings, ints, enums, lists,
// inline input objects, null), and inline fragments. Unknown fields are a
// GraphQL error (HTTP 200 with an errors array naming the field), never an
// HTTP 400; an unknown repository is data.repository = null with no errors.

import { parseCommit } from './gitobj.ts';
import {
  createCommentRecord,
  createIssueRecord,
  createPullRecord,
  diffTrees,
  getObject,
  globalId,
  mergeConflict,
  resolveGlobalId,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  type: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class GqlParseError extends Error {}

class Lexer {
  readonly tokens: string[];
  pos = 0;

  constructor(source: string) {
    const tokens: string[] = [];
    let i = 0;
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        i += 1;
        continue;
      }
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      if ('{}()[]:!=$@'.includes(ch)) {
        tokens.push(ch);
        i += 1;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let out = '';
        while (j < source.length && source[j] !== '"') {
          if (source[j] === '\\' && j + 1 < source.length) {
            const esc = source[j + 1] as string;
            out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            j += 2;
          } else {
            out += source[j] as string;
            j += 1;
          }
        }
        if (j >= source.length) throw new GqlParseError('unterminated string');
        tokens.push(JSON.stringify(out));
        i = j + 1;
        continue;
      }
      if (/[0-9-]/.test(ch)) {
        let j = i;
        while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
        tokens.push(source.slice(i, j));
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
        tokens.push(source.slice(i, j));
        i = j;
        continue;
      }
      throw new GqlParseError(`unexpected character ${JSON.stringify(ch)}`);
    }
    this.tokens = tokens;
  }

  peek(): string | null {
    return this.pos < this.tokens.length ? (this.tokens[this.pos] as string) : null;
  }

  next(): string {
    const token = this.peek();
    if (token === null) throw new GqlParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlParseError(`expected ${token}, got ${got}`);
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const token = lexer.next();
  if (token === '$') return { kind: 'variable', name: lexer.next() };
  if (token === '[') {
    const items: ValueNode[] = [];
    while (lexer.peek() !== ']') items.push(parseValue(lexer));
    lexer.expect(']');
    return { kind: 'list', items };
  }
  if (token === '{') {
    const fields: Record<string, ValueNode> = {};
    while (lexer.peek() !== '}') {
      const name = lexer.next();
      lexer.expect(':');
      fields[name] = parseValue(lexer);
    }
    lexer.expect('}');
    return { kind: 'object', fields };
  }
  if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
  if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
  if (token === 'true') return { kind: 'boolean', value: true };
  if (token === 'false') return { kind: 'boolean', value: false };
  if (token === 'null') return { kind: 'null' };
  return { kind: 'enum', value: token };
}

function parseSelectionSet(lexer: Lexer): Selection[] {
  lexer.expect('{');
  const selections: Selection[] = [];
  while (lexer.peek() !== '}') {
    if (lexer.peek() === '...') {
      lexer.next();
      const next = lexer.next();
      if (next !== 'on') throw new GqlParseError('only inline fragments are supported');
      const type = lexer.next();
      selections.push({ kind: 'fragment', type, selections: parseSelectionSet(lexer) });
      continue;
    }
    const first = lexer.next();
    let alias = first;
    let name = first;
    if (lexer.peek() === ':') {
      lexer.next();
      name = lexer.next();
    }
    const args: Record<string, ValueNode> = {};
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')') {
        const argName = lexer.next();
        lexer.expect(':');
        args[argName] = parseValue(lexer);
      }
      lexer.expect(')');
    }
    let sub: Selection[] = [];
    if (lexer.peek() === '{') sub = parseSelectionSet(lexer);
    selections.push({ kind: 'field', alias, name, args, selections: sub });
  }
  lexer.expect('}');
  return selections;
}

function parseDocument(source: string): Operation[] {
  const lexer = new Lexer(source);
  const operations: Operation[] = [];
  while (lexer.peek() !== null) {
    const head = lexer.peek();
    if (head === '{') {
      operations.push({ kind: 'query', name: null, selections: parseSelectionSet(lexer) });
      continue;
    }
    if (head === 'query' || head === 'mutation') {
      lexer.next();
      const kind = head as 'query' | 'mutation';
      let name: string | null = null;
      if (lexer.peek() !== null && lexer.peek() !== '{' && lexer.peek() !== '(') name = lexer.next();
      if (lexer.peek() === '(') {
        // Variable definitions: ($name: Type = default, ...) — types are not needed.
        let depth = 0;
        while (lexer.peek() !== null) {
          const token = lexer.next();
          if (token === '(') depth += 1;
          else if (token === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
      operations.push({ kind, name, selections: parseSelectionSet(lexer) });
      continue;
    }
    throw new GqlParseError(`unexpected token ${JSON.stringify(head)} at document top level`);
  }
  return operations;
}

// -------------------------------------------------------------------------------------------
// schema
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: [
    'ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PACKAGE',
    'MARKETPLACE', 'TOPIC', 'LABEL', 'APP', 'PROJECT', 'ORGANIZATION', 'TEAM', 'MANNEQUIN', 'BOT',
  ],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

class GqlError extends Error {}

type Obj = Record<string, unknown> & { __typename: string };

interface Ctx {
  store: Store;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(sel: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sel.args)) out[key] = resolveValue(value, variables);
  return out;
}

function userObj(): Obj {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function executeSelections(typeName: string, obj: Obj, selections: Selection[], ctx: Ctx, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.type === typeName) {
        Object.assign(out, executeSelections(typeName, obj, sel.selections, ctx, variables));
      }
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias] = typeName;
      continue;
    }
    const fields = TYPE_FIELDS[typeName] ?? [];
    if (!fields.includes(sel.name)) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    out[sel.alias] = resolveField(typeName, obj, sel, ctx, variables);
  }
  return out;
}

function resolveField(typeName: string, obj: Obj, sel: FieldSelection, ctx: Ctx, variables: Record<string, unknown>): unknown {
  const args = resolveArgs(sel, variables);
  const repo = obj['repo'] as Repo | undefined;

  if (typeName === 'Query') {
    if (sel.name === 'viewer') {
      return executeSelections('User', userObj(), sel.selections, ctx, variables);
    }
    if (sel.name === 'repository') {
      const owner = args['owner'];
      const name = args['name'];
      if (owner !== VIEWER.login || typeof name !== 'string') return null;
      const found = ctx.store.getRepo(name);
      if (found === undefined) return null;
      return executeSelections('Repository', repoObj(found), sel.selections, ctx, variables);
    }
    if (sel.name === 'node') {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      const resolved = resolveGlobalId(ctx.store, id);
      if (resolved === null) return null;
      if (resolved.kind === 'Repository') {
        return executeSelections('Repository', repoObj(resolved.repo), sel.selections, ctx, variables);
      }
      if (resolved.kind === 'Issue' && resolved.issue !== undefined) {
        return executeSelections('Issue', issueObj(resolved.repo, resolved.issue), sel.selections, ctx, variables);
      }
      if (resolved.kind === 'PullRequest' && resolved.pull !== undefined) {
        return executeSelections('PullRequest', pullObj(resolved.repo, resolved.pull), sel.selections, ctx, variables);
      }
      return null;
    }
    if (sel.name === '__type') {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      const fields = TYPE_FIELDS[name];
      const enums = ENUM_VALUES[name];
      if (fields === undefined && enums === undefined) return null;
      const typeObj: Obj = { __typename: '__Type', typeName: name, fields: fields ?? null, enums: enums ?? null };
      return executeSelections('__Type', typeObj, sel.selections, ctx, variables);
    }
  }

  if (typeName === 'User') {
    if (sel.name === 'login') return obj['login'];
    if (sel.name === 'id') return globalId('User', obj['id'] as number);
    if (sel.name === 'name') return obj['name'];
    if (sel.name === 'email') return obj['email'];
  }

  if (typeName === 'Ref') {
    if (sel.name === 'name') return obj['name'];
  }

  if (typeName === '__Type') {
    if (sel.name === 'name') return obj['typeName'];
    if (sel.name === 'fields') {
      const fields = obj['fields'] as readonly string[] | null;
      if (fields === null) return null;
      return fields.map((name) => ({ __typename: '__Field', name }));
    }
    if (sel.name === 'enumValues') {
      const enums = obj['enums'] as readonly string[] | null;
      if (enums === null) return null;
      return enums.map((name) => ({ __typename: '__EnumValue', name }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (sel.name === 'name') return obj['name'];
  }

  if (typeName === 'IssueCommentEdge') {
    if (sel.name === 'node') {
      const node = obj['node'] as Obj;
      return executeSelections('IssueComment', node, sel.selections, ctx, variables);
    }
  }

  if (typeName === 'IssueComment') {
    if (sel.name === 'id') return obj['id'];
    if (sel.name === 'body') return obj['body'];
  }

  if (repo === undefined) throw new GqlError(`field ${sel.name} on ${typeName} needs a repository`);

  if (typeName === 'Repository') {
    if (sel.name === 'id') return globalId('Repository', repo.id);
    if (sel.name === 'databaseId') return repo.id;
    if (sel.name === 'name') return repo.name;
    if (sel.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (sel.name === 'owner') return executeSelections('User', userObj(), sel.selections, ctx, variables);
    if (sel.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return executeSelections('Ref', { __typename: 'Ref', name: repo.defaultBranch }, sel.selections, ctx, variables);
    }
    if (sel.name === 'viewerPermission') return 'ADMIN';
    if (sel.name === 'hasIssuesEnabled') return true;
    if (sel.name === 'issue') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      return executeSelections('Issue', issueObj(repo, issue), sel.selections, ctx, variables);
    }
    if (sel.name === 'issues') return issuesConnection(repo, args, sel, ctx, variables);
    if (sel.name === 'pullRequests') {
      const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      const nodeSelections: Selection[] = [];
      for (const sub of sel.selections) {
        if (sub.kind === 'field' && sub.name === 'nodes') nodeSelections.push(...sub.selections);
      }
      return { nodes: page.map((pull) => executeSelections('PullRequest', pullObj(repo, pull), nodeSelections, ctx, variables)) };
    }
    if (sel.name === 'pullRequest') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      return executeSelections('PullRequest', pullObj(repo, pull), sel.selections, ctx, variables);
    }
  }

  if (typeName === 'Issue') {
    const issue = obj['issue'] as Issue;
    if (sel.name === 'id') return globalId('Issue', repo.id, issue.number);
    if (sel.name === 'number') return issue.number;
    if (sel.name === 'title') return issue.title;
    if (sel.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (sel.name === 'body') return issue.body;
  }

  if (typeName === 'PullRequest') {
    const pull = obj['pull'] as Pull;
    if (sel.name === 'id') return globalId('PullRequest', repo.id, pull.number);
    if (sel.name === 'number') return pull.number;
    if (sel.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (sel.name === 'merged') return pull.merged;
    if (sel.name === 'headRefName') return pull.head.ref;
    if (sel.name === 'baseRefName') return pull.base.ref;
    if (sel.name === 'mergeable') {
      const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
      return mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (sel.name === 'files') {
      const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
      const baseCommit = parseCommit((getObject(repo, pull.base.sha) as { data: Buffer }).data);
      const headCommit = parseCommit((getObject(repo, pull.head.sha) as { data: Buffer }).data);
      const changes = diffTrees(repo, baseCommit.tree, headCommit.tree);
      const page = first === undefined ? changes : changes.slice(0, first);
      const nodeSelections: Selection[] = [];
      for (const sub of sel.selections) {
        if (sub.kind === 'field' && sub.name === 'nodes') nodeSelections.push(...sub.selections);
      }
      return {
        nodes: page.map((change) => {
          const out: Record<string, unknown> = {};
          for (const sub of nodeSelections) {
            if (sub.kind === 'field' && sub.name === 'path') out[sub.alias] = change.path;
          }
          return out;
        }),
      };
    }
  }

  throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
}

function issuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
  sel: FieldSelection,
  ctx: Ctx,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args['states'];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : String(state))));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args['orderBy'];
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const record = orderBy as Record<string, unknown>;
    if (typeof record['direction'] === 'string') direction = record['direction'] as string;
  }
  // Creation order is number order, so orderBy.field never changes the result.
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = numberFromCursor(args['after'] as string | null | undefined);
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < after : issue.number > after));
  }
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined && issues.length > first;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
  const nodeSelections: Selection[] = [];
  for (const sub of sel.selections) {
    if (sub.kind === 'field' && sub.name === 'nodes') nodeSelections.push(...sub.selections);
  }
  const nodes = page.map((issue) => executeSelections('Issue', issueObj(repo, issue), nodeSelections, ctx, variables));
  return {
    nodes,
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

// Payload field resolution: each payload object holds its child under one key.
const PAYLOAD_CHILD: Record<string, string> = {
  CreateIssuePayload: 'issue',
  CloseIssuePayload: 'issue',
  CreatePullRequestPayload: 'pullRequest',
  MergePullRequestPayload: 'pullRequest',
  AddCommentPayload: 'commentEdge',
};

function executePayloadSelections(
  typeName: string,
  obj: Obj,
  selections: Selection[],
  ctx: Ctx,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.type === typeName) Object.assign(out, executePayloadSelections(typeName, obj, sel.selections, ctx, variables));
      continue;
    }
    const childKey = PAYLOAD_CHILD[typeName];
    if (sel.name === childKey) {
      const child = obj[childKey] as Obj;
      out[sel.alias] = executeSelections(child.__typename, child, sel.selections, ctx, variables);
      continue;
    }
    throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
  }
  return out;
}

function executeMutationWithPayloads(
  op: Operation,
  variables: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'fragment') continue;
    const args = resolveArgs(sel, variables);
    if (sel.name === 'createIssue') {
      const input = args['input'] as Record<string, unknown> | undefined;
      const repositoryId = input?.['repositoryId'];
      const title = input?.['title'];
      if (typeof repositoryId !== 'string' || typeof title !== 'string') throw new GqlError('createIssue needs repositoryId and title');
      const resolved = resolveGlobalId(ctx.store, repositoryId);
      if (resolved === null || resolved.kind !== 'Repository') throw new GqlError('createIssue: unknown repository');
      const issue = createIssueRecord(ctx.store, resolved.repo, title, typeof input?.['body'] === 'string' ? (input['body'] as string) : '', []);
      const payload: Obj = { __typename: 'CreateIssuePayload', issue: issueObj(resolved.repo, issue) };
      out[sel.alias] = executePayloadSelections('CreateIssuePayload', payload, sel.selections, ctx, variables);
      continue;
    }
    if (sel.name === 'closeIssue') {
      const input = args['input'] as Record<string, unknown> | undefined;
      const issueId = input?.['issueId'];
      if (typeof issueId !== 'string') throw new GqlError('closeIssue needs issueId');
      const resolved = resolveGlobalId(ctx.store, issueId);
      if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) throw new GqlError('closeIssue: unknown issue');
      resolved.issue.state = 'closed';
      resolved.issue.updatedAt = ctx.store.nowIso();
      const payload: Obj = { __typename: 'CloseIssuePayload', issue: issueObj(resolved.repo, resolved.issue) };
      out[sel.alias] = executePayloadSelections('CloseIssuePayload', payload, sel.selections, ctx, variables);
      continue;
    }
    if (sel.name === 'createPullRequest') {
      const input = args['input'] as Record<string, unknown> | undefined;
      const repositoryId = input?.['repositoryId'];
      const headRefName = input?.['headRefName'];
      const baseRefName = input?.['baseRefName'];
      const title = input?.['title'];
      if (typeof repositoryId !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
        throw new GqlError('createPullRequest needs repositoryId, headRefName, baseRefName and title');
      }
      const resolved = resolveGlobalId(ctx.store, repositoryId);
      if (resolved === null || resolved.kind !== 'Repository') throw new GqlError('createPullRequest: unknown repository');
      const pull = createPullRecord(ctx.store, resolved.repo, title, typeof input?.['body'] === 'string' ? (input['body'] as string) : '', headRefName, baseRefName);
      if (pull === null) throw new GqlError('createPullRequest: head or base branch does not exist');
      const payload: Obj = { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(resolved.repo, pull) };
      out[sel.alias] = executePayloadSelections('CreatePullRequestPayload', payload, sel.selections, ctx, variables);
      continue;
    }
    if (sel.name === 'mergePullRequest') {
      const input = args['input'] as Record<string, unknown> | undefined;
      const pullRequestId = input?.['pullRequestId'];
      if (typeof pullRequestId !== 'string') throw new GqlError('mergePullRequest needs pullRequestId');
      const resolved = resolveGlobalId(ctx.store, pullRequestId);
      if (resolved === null || resolved.kind !== 'PullRequest' || resolved.pull === undefined) throw new GqlError('mergePullRequest: unknown pull request');
      if (resolved.pull.merged) throw new GqlError('mergePullRequest: already merged');
      if (mergeConflict(resolved.repo, resolved.pull) !== null) throw new GqlError('mergePullRequest: merge conflict');
      const sha = squashMerge(ctx.store, resolved.repo, resolved.pull);
      if (sha === null) throw new GqlError('mergePullRequest: merge conflict');
      const payload: Obj = { __typename: 'MergePullRequestPayload', pullRequest: pullObj(resolved.repo, resolved.pull) };
      out[sel.alias] = executePayloadSelections('MergePullRequestPayload', payload, sel.selections, ctx, variables);
      continue;
    }
    if (sel.name === 'addComment') {
      const input = args['input'] as Record<string, unknown> | undefined;
      const subjectId = input?.['subjectId'];
      const text = input?.['body'];
      if (typeof subjectId !== 'string' || typeof text !== 'string') throw new GqlError('addComment needs subjectId and body');
      const resolved = resolveGlobalId(ctx.store, subjectId);
      if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) throw new GqlError('addComment: unknown subject');
      const comment = createCommentRecord(ctx.store, resolved.issue, text);
      const node: Obj = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', resolved.repo.id, resolved.issue.number, comment.id),
        body: comment.body,
      };
      const payload: Obj = {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node },
      };
      out[sel.alias] = executePayloadSelections('AddCommentPayload', payload, sel.selections, ctx, variables);
      continue;
    }
    throw new GqlError(`Cannot query field "${sel.name}" on type "Mutation".`);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphqlResult {
  status: number;
  body: unknown;
}

/**
 * Execute one GraphQL request body ({query, variables} or an array of them).
 * Always HTTP 200 with {data} / {data, errors}; auth is the app layer's job.
 */
export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const ctx: Ctx = { store };
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'request must be an object with query and variables' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record['query'];
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'query must be a string' }] };
    }
    const variables = (record['variables'] ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'empty document' }] };
    }
    const op = operations[0] as Operation;
    try {
      if (op.kind === 'mutation') {
        return { data: executeMutationWithPayloads(op, variables, ctx) };
      }
      const root: Obj = { __typename: 'Query' };
      return { data: executeSelections('Query', root, op.selections, ctx, variables) };
    } catch (err) {
      if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
      throw err;
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
