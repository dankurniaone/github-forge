// Boot: connect this process to the trial environment.
//
// The environment publishes its address in MAKEFUN_ENV_URL. This process
// picks an ephemeral port, reports it, and then waits until the
// environment says the trial finished. Nothing else happens here: the
// graded work is the server that app.ts builds.

import { createApp } from './app.ts';

const envAddress = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envAddress === '') {
  process.stderr.write('no trial environment address in MAKEFUN_ENV_URL\n');
  process.exit(1);
}

const CALL_TIMEOUT = 30_000;
const FIRST_PAUSE = 250;
const LONGEST_PAUSE = 2_000;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function nextPause(n: number): number {
  const doubled = FIRST_PAUSE * 2 ** Math.min(n, 8);
  return doubled > LONGEST_PAUSE ? LONGEST_PAUSE : doubled;
}

class Fatal extends Error {}

async function withRetries(task: () => Promise<boolean>): Promise<void> {
  let tries = 0;
  for (;;) {
    try {
      if (await task()) return;
    } catch (err) {
      if (err instanceof Fatal) throw err;
    }
    await pause(nextPause(tries));
    tries += 1;
  }
}

async function register(port: number): Promise<void> {
  await withRetries(async () => {
    const res = await fetch(`${envAddress}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) throw new Fatal(`env refused registration (HTTP ${res.status})`);
    return false;
  });
}

async function waitForDone(): Promise<void> {
  await withRetries(async () => {
    const res = await fetch(`${envAddress}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Fatal('server bound no TCP port');
  process.stdout.write(`bound port ${bound.port}\n`);
  await register(bound.port);
  process.stdout.write('registered with the trial environment\n');
  await waitForDone();
  server.close();
  process.stdout.write('trial done\n');
}

boot().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`entry failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
