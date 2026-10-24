import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";

type Client = { socket: Socket; sessions: Set<string> };
type Route = { client: Client; id: number; method: string };

/**
 * Keeps one DevTools connection to the user's browser open and shares it with short-lived
 * CLI commands over a local socket. Chrome asks the user to approve every new debugging
 * connection, so without this they would see a prompt for every agent action.
 *
 * Message ids are rewritten so clients cannot collide, and each client's page sessions
 * are detached when it disconnects. Exits when the browser connection closes.
 */
export async function runDaemon(upstreamUrl: string, socketPath: string): Promise<void> {
  const upstream = new WebSocket(upstreamUrl);
  await new Promise<void>((resolve, reject) => {
    upstream.addEventListener("open", () => resolve(), { once: true });
    upstream.addEventListener("error", () => reject(new Error(`could not connect to ${upstreamUrl}`)), { once: true });
  });

  let nextId = 1;
  const routes = new Map<number, Route>();
  const owners = new Map<string, Client>(); // sessionId -> client that attached it
  const clients = new Set<Client>();

  const forward = (message: object) => upstream.send(JSON.stringify(message));
  const reply = (client: Client, message: object) => {
    if (!client.socket.destroyed) client.socket.write(`${JSON.stringify(message)}\n`);
  };

  upstream.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) {
      // Session events go to the client that owns the session; browser-wide events (such as
      // downloads) go to every client.
      if (!message.sessionId) for (const client of clients) reply(client, message);
      const owner = message.sessionId && owners.get(message.sessionId);
      if (owner) {
        // A page session's iframes attach on their own; they belong to the same client.
        if (message.method === "Target.attachedToTarget") {
          owner.sessions.add(message.params.sessionId);
          owners.set(message.params.sessionId, owner);
        }
        reply(owner, message);
      }
      return;
    }
    const route = routes.get(message.id);
    if (!route) return; // Internal request, such as a detach after a client left.
    routes.delete(message.id);
    if (route.method === "Target.attachToTarget" && message.result?.sessionId) {
      if (route.client.socket.destroyed) {
        forward({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId: message.result.sessionId } });
      } else {
        route.client.sessions.add(message.result.sessionId);
        owners.set(message.result.sessionId, route.client);
      }
    }
    reply(route.client, { ...message, id: route.id });
  });

  const server = createServer((socket) => {
    const client: Client = { socket, sessions: new Set() };
    clients.add(client);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: { id: number; method: string; params?: object; sessionId?: string };
        try {
          request = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        const id = nextId++;
        routes.set(id, { client, id: request.id, method: request.method });
        forward({ ...request, id });
      }
    });
    socket.on("close", () => {
      clients.delete(client);
      for (const sessionId of client.sessions) {
        owners.delete(sessionId);
        forward({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId } });
      }
    });
    socket.on("error", () => socket.destroy());
  });

  const shutdown = () => {
    server.close();
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
    process.exit(0);
  };
  upstream.addEventListener("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (process.platform !== "win32") rmSync(socketPath, { force: true }); // A stale socket from a crash.
  // Only this user may drive the browser: create the socket private, not just chmod it after.
  process.umask(0o077);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
}
