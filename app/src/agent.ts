import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { WebContents } from "electron";

export function agentSocketPath(profile: string): string {
  const id = createHash("sha256").update(profile).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\open-eyes-browser-${id}`;
  return join(process.env.XDG_RUNTIME_DIR ?? profile, `open-eyes-browser-${id}.sock`);
}

export type AgentHost = {
  product: string;
  open(url: string): WebContents;
  close(contents: WebContents): void;
};

type TargetInfo = { targetId: string; type: string; url: string; title: string; openerId?: string };
type Tab = { contents: WebContents; info: TargetInfo };
type Client = { send(message: object): void; discover: boolean };
type Message = { id: number; method: string; params?: Record<string, any>; sessionId?: string };

export class AgentBridge {
  #host: AgentHost;
  #tabs = new Map<string, Tab>();
  #clients = new Set<Client>();
  #sessions = new Map<string, { client: Client; tab: Tab }>();

  constructor(host: AgentHost) {
    this.#host = host;
  }

  isAgentTab(contents: WebContents): boolean {
    return [...this.#tabs.values()].some((tab) => tab.contents === contents);
  }

  async adopt(contents: WebContents, opener?: WebContents): Promise<string> {
    const debug = contents.debugger;
    debug.attach("1.3");
    // Electron applies this command but never answers it.
    void debug.sendCommand("Emulation.setAutomationOverride", { enabled: true }).catch(() => {});
    const { targetInfo } = await debug.sendCommand("Target.getTargetInfo");
    const openerId = opener && [...this.#tabs.values()].find((t) => t.contents === opener)?.info.targetId;
    const tab: Tab = { contents, info: { ...targetInfo, ...(openerId ? { openerId } : {}) } };
    this.#tabs.set(targetInfo.targetId, tab);
    debug.on("message", (_event, method, params, sessionId) => this.#route(tab, method, params, sessionId));
    debug.on("detach", () => this.#forget(tab));
    contents.once("destroyed", () => this.#forget(tab));
    for (const client of this.#clients) if (client.discover) client.send({ method: "Target.targetCreated", params: { targetInfo: this.#info(tab) } });
    return targetInfo.targetId;
  }

  listen(path: string): Server {
    const server = createServer((socket) => this.#serve(socket));
    if (process.platform !== "win32") rmSync(path, { force: true });
    const umask = process.umask(0o077);
    server.listen(path, () => {
      process.umask(umask);
      if (process.platform !== "win32") chmodSync(path, 0o600);
    });
    return server;
  }

  #serve(socket: Socket): void {
    const client: Client = { send: (message) => socket.write(`${JSON.stringify(message)}\n`), discover: false };
    this.#clients.add(client);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        this.#answer(client, message).then(
          (result) => client.send({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
          (error: Error) => client.send({ id: message.id, error: { code: -32000, message: error.message }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
        );
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.#clients.delete(client);
      for (const [sessionId, owner] of this.#sessions) {
        if (owner.client !== client) continue;
        this.#sessions.delete(sessionId);
        if (!owner.tab.contents.isDestroyed()) void owner.tab.contents.debugger.sendCommand("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    });
  }

  async #answer(client: Client, { method, params = {}, sessionId }: Message): Promise<object> {
    if (sessionId) {
      const owner = this.#sessions.get(sessionId);
      if (!owner || owner.client !== client) throw new Error(`no session ${sessionId}`);
      return owner.tab.contents.debugger.sendCommand(method, params, sessionId);
    }
    const tab = params.targetId === undefined ? undefined : this.#tabs.get(params.targetId);
    switch (method) {
      case "Browser.getVersion":
        return { product: this.#host.product, protocolVersion: "1.3" };
      case "Target.setDiscoverTargets":
        client.discover = params.discover === true;
        return {};
      case "Target.getTargets":
        return { targetInfos: [...this.#tabs.values()].map((t) => this.#info(t)) };
      case "Target.getTargetInfo":
        if (!tab) throw new Error("No target with given id found");
        return { targetInfo: this.#info(tab) };
      case "Target.createTarget":
        return { targetId: await this.adopt(this.#host.open(String(params.url ?? "about:blank"))) };
      case "Target.closeTarget":
        if (!tab) throw new Error("No target with given id found");
        this.#host.close(tab.contents);
        return { success: true };
      case "Target.attachToTarget": {
        if (!tab) throw new Error("No target with given id found");
        const { sessionId: attached } = await tab.contents.debugger.sendCommand("Target.attachToTarget", { targetId: tab.info.targetId, flatten: true });
        this.#sessions.set(attached, { client, tab });
        return { sessionId: attached };
      }
      case "Target.detachFromTarget": {
        const owner = this.#sessions.get(params.sessionId);
        if (!owner || owner.client !== client) throw new Error(`no session ${params.sessionId}`);
        this.#sessions.delete(params.sessionId);
        return owner.tab.contents.debugger.sendCommand("Target.detachFromTarget", { sessionId: params.sessionId });
      }
      case "Browser.setDownloadBehavior": {
        const owned = [...this.#sessions.values()].find((owner) => owner.client === client);
        if (!owned) throw new Error("attach to a tab first");
        return owned.tab.contents.debugger.sendCommand(method, params);
      }
      default:
        throw new Error(`${method} is not available in open-eyes Browser`);
    }
  }

  #route(tab: Tab, method: string, params: any, sessionId: string): void {
    if (sessionId) {
      const owner = this.#sessions.get(sessionId);
      if (!owner) return;
      if (method === "Target.attachedToTarget") this.#sessions.set(params.sessionId, owner);
      if (method === "Target.detachedFromTarget") this.#sessions.delete(params.sessionId);
      owner.client.send({ method, params, sessionId });
      return;
    }
    if (method.startsWith("Target.")) {
      const owner = this.#sessions.get(params.sessionId);
      if (method === "Target.detachedFromTarget") this.#sessions.delete(params.sessionId);
      owner?.client.send({ method, params });
      return;
    }
    const clients = new Set([...this.#sessions.values()].filter((owner) => owner.tab === tab).map((owner) => owner.client));
    for (const client of clients) client.send({ method, params });
  }

  #info(tab: Tab): TargetInfo {
    const { contents, info } = tab;
    return contents.isDestroyed() ? info : { ...info, url: contents.getURL(), title: contents.getTitle() };
  }

  #forget(tab: Tab): void {
    if (this.#tabs.get(tab.info.targetId) !== tab) return;
    this.#tabs.delete(tab.info.targetId);
    for (const [sessionId, owner] of this.#sessions) {
      if (owner.tab !== tab) continue;
      this.#sessions.delete(sessionId);
      owner.client.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: tab.info.targetId } });
    }
    for (const client of this.#clients) if (client.discover) client.send({ method: "Target.targetDestroyed", params: { targetId: tab.info.targetId } });
  }
}
