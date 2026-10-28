import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CDP } from "../src/cdp.ts";

test("a request nobody answers fails instead of waiting forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "open-eyes-cdp-"));
  const path = join(dir, "silent.sock");
  // Like a page stuck in an endless script: the connection is there, no answer comes.
  const sockets: Socket[] = [];
  const server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const saved = CDP.replyTimeoutMs;
  CDP.replyTimeoutMs = 200;
  const cdp = await CDP.connect(`unix:${path}`);
  try {
    await assert.rejects(cdp.send("Runtime.evaluate", { expression: "1" }), /the page stopped responding \(no answer to Runtime\.evaluate in 0\.2s\)/);
  } finally {
    CDP.replyTimeoutMs = saved;
    cdp.close();
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
