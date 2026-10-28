// Run by test/cookies.test.ts inside Electron: a login cookie set in one space's session is
// exported, imported into another space, and sent from there. Prints the result as JSON.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { app, session } from "electron";
import { exportCookies, importCookies } from "../../src/cookies.ts";

app.setPath("userData", process.argv.at(-1)!);
app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    if (request.url === "/login") response.setHeader("Set-Cookie", ["sid=s3cret; HttpOnly; Path=/; Max-Age=3600", "gone=1; Path=/; Max-Age=0"]);
    response.end(request.headers.cookie ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const from = session.fromPartition("persist:space-a");
  const to = session.fromPartition("persist:space-b");
  await (await from.fetch(`${base}/login`)).text();
  const exported = await exportCookies(from);
  const before = await (await to.fetch(`${base}/`)).text();
  const failed = await importCookies(to, [...exported, { name: "bad", domain: "evil example", path: "/" }]);
  const after = await (await to.fetch(`${base}/`)).text();
  console.log(JSON.stringify({ exported, before, after, failed }));
  server.close();
  app.quit();
});
