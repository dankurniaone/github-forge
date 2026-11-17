# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dankurniaone/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dankurniaone/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (v0 + v2, fetch, push, shallow, tags), the REST v3 API (repos, branches, commits, contents, labels, issues, pull requests), GraphQL v4, and a Model Context Protocol endpoint — all backed by one deterministic in-memory store.

## Run it

```sh
PORT=8080 node --experimental-strip-types dev.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=adyjn11j&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it does

`github-forge` is a self-contained GitHub clone that speaks the protocols real
clients speak, so `git`, `gh` and MCP agents can use it without modification:

- **Git smart HTTP** — `git clone`, `fetch`, `push` over HTTP, protocol v0 and
  v2, shallow clones (`--depth`), `deepen`, annotated tags with peeling,
  fast-forward-only pushes (mixed `ok`/`ng` reports), 100-file pushes, pack
  integrity (SHA-1 checksum, deltas, sideband-64k framing).
- **REST v3** (`/api/v3`) — repositories (create/read/update/delete, paginated
  `Link` headers), branches, commits, git refs, contents (create/update/delete
  with stale-sha 409s), labels, issues (filter/sort, comments), pull requests
  (files, squash merge with conflict detection). Every reply is JSON with a
  non-empty `X-GitHub-Request-Id`; missing token is 401, another owner's repo
  is 404.
- **GraphQL v4** (`/api/graphql`) — `viewer`, `repository` reads, `__type`
  introspection, issue/pull-request connections with cursor pagination,
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment`, `node(id:)` round-trips, batched operation documents, and
  invalid-field errors that name the field.
- **MCP** (`/mcp`) — Streamable HTTP JSON-RPC 2.0, era `2026-07-28`
  (`server/discover`, plus `initialize` for older clients), six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Design

- **One store, four surfaces.** REST, GraphQL and MCP all read and write the
  same in-memory store, so a repo created over MCP is cloneable over git and
  visible over GraphQL.
- **Deterministic.** No wall clock and no unseeded randomness anywhere in
  request handling: timestamps come from a logical clock seeded by the trial
  seed, and the scenario (viewer `adaiversen`, teammates, org) is derived from
  the fixed seed `6a09e667f3bcc909`. Two runs of the same requests leave
  identical state.
- **Stdlib only, no install step.** Node 22+, `node --experimental-strip-types
  main.ts`. No dependencies, no network beyond the trial env, no git binary.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry <-> env lifecycle (bind, register, poll `done`) |
| `app.ts` | HTTP server: routing, auth, JSON plumbing, request ids |
| `gitproto.ts` | Git smart HTTP: v0/v2 advertisements, upload-pack, receive-pack |
| `gitobj.ts` | SHA-1 objects, trees/commits/tags, pack read/write, pkt-lines |
| `store.ts` | In-memory store, logical clock, reachability, merges, serializers |
| `rest.ts` | REST v3 handlers |
| `graphql.ts` | GraphQL parser + executor |
| `mcp.ts` | MCP JSON-RPC endpoint + tools |
| `scenario.ts` | Deterministic scenario (seed, users, org) |
| `dev.ts` | Local dev server (no trial env needed) |

## Local development

```sh
# Start on http://127.0.0.1:8080 (any non-empty Bearer token is accepted locally)
PORT=8080 node --experimental-strip-types dev.ts

# With a fixed token, like the trial env issues:
MAKEFUN_SHOP_TOKEN=shpat_<32 hex> PORT=8080 node --experimental-strip-types dev.ts
```

Then, for example:

```sh
# Create a repo and push a first commit
curl -H 'Authorization: Bearer test' -X POST localhost:8080/api/v3/user/repos \
  -d '{"name":"hello"}'
git clone http://test@localhost:8080/adaiversen/hello.git
```

## License

MIT — see [LICENSE](LICENSE).
