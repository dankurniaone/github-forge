// dev.ts — local dev server: the same app main.ts serves in a trial, but bound
// to a fixed port with no env to register with. Not part of the trial entry.
//
//   PORT=8080 node --experimental-strip-types dev.ts
//   MAKEFUN_SHOP_TOKEN=shpat_<32 hex> PORT=8080 node --experimental-strip-types dev.ts

import { createApp } from './app.ts';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] listening on http://127.0.0.1:${port}\n`);
});
