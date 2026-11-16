// app.ts — the HTTP server: routing, auth, JSON plumbing, request ids.
// main.ts owns the entry <-> env lifecycle and imports createApp() from here.
//
// Routes:
//   GET  /healthz                       200 {"ok":true} (no auth; the env's boot check)
//   /api/v3/*                           REST v3 (auth, JSON, X-GitHub-Request-Id)
//   POST /api/graphql                   GraphQL v4 (auth, JSON)
//   POST /mcp                           Model Context Protocol, Streamable HTTP (auth)
//   /{owner}/{repo}.git/info/refs       git smart-HTTP advertisement (auth)
//   /{owner}/{repo}.git/git-upload-pack git fetch (auth)
//   /{owner}/{repo}.git/git-receive-pack git push (auth)
//   everything else                     JSON 404 {"message":"Not Found"}
//
// Auth: every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
// When the env var is set, only that exact token is accepted; when it is not
// (local dev only), any non-empty Bearer token is accepted. Missing or wrong
// token is 401; a repo under another owner is 404, never 403. A handler that
// throws answers 500 JSON and the server stays up — a malformed git request
// must never take the server down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type HttpResult } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token the env issues for this trial, or '' when running locally. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Deterministic request ids: a counter, hex — no wall clock, no randomness. */
let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, result: HttpResult, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length, ...headers });
  res.end(result.body);
}

/** The Bearer token on the request, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

/** True when the request carries an acceptable token. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Parse a JSON body: undefined for an empty body, a thrown Error for malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const requestId = nextRequestId();

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
          return;
        }

        // Everything below needs the token (401 before any other decision).
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const segments = path.split('/').filter((part) => part !== '').slice(2);
          const query = queryOf(req);
          const host = req.headers['host'] ?? '127.0.0.1';
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            try {
              body = parseJsonBody(raw);
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
              return;
            }
          }
          const restReq: RestRequest = { method, segments, query, body, host };
          const result = handleRest(store, restReq);
          sendJson(res, result.status, result.body, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = parseJsonBody(raw);
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
            return;
          }
          const result = handleGraphql(store, body);
          sendJson(res, result.status, result.body, { 'x-github-request-id': requestId });
          return;
        }

        // Model Context Protocol, Streamable HTTP.
        if (method === 'POST' && path === '/mcp') {
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = parseJsonBody(raw);
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { 'x-github-request-id': requestId });
            return;
          }
          const result = handleMcp(store, body);
          if (result.empty === true) {
            res.writeHead(result.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, { 'x-github-request-id': requestId });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          if (owner !== VIEWER.login) {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          const repo = store.getRepo(repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          if (endpoint === 'info/refs' && method === 'GET') {
            const query = queryOf(req);
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' }, { 'x-github-request-id': requestId });
              return;
            }
            const result = handleInfoRefs(repo, service, req.headers['git-protocol']);
            sendBuffer(res, result, { 'x-github-request-id': requestId });
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            sendBuffer(res, handleUploadPack(repo, raw), { 'x-github-request-id': requestId });
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            sendBuffer(res, handleReceivePack(repo, raw), { 'x-github-request-id': requestId });
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON and keep serving.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, { 'x-github-request-id': requestId });
        } else {
          res.end();
        }
      }
    })();
  });
}
