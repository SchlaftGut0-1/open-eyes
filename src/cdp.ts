import { createConnection } from "node:net";

type Pending = {
  method: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
};

/** A message channel to the browser: its DevTools WebSocket, or the open-eyes daemon. */
export type Transport = {
  send(message: string): void;
  close(): void;
};

type TransportEvents = { message: (message: string) => void; close: () => void };

/** Minimal Chrome DevTools Protocol client. */
export class CDP {
  #transport: Transport;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  private constructor(open: (events: TransportEvents) => Transport) {
    this.#transport = open({
      message: (message) => this.#onMessage(message),
      close: () => {
        for (const p of this.#pending.values()) p.reject(new Error(`connection closed during ${p.method}`));
        this.#pending.clear();
      },
    });
  }

  /** Connects to a `ws://` DevTools endpoint or a `unix:<path>` daemon socket. */
  static connect(url: string): Promise<CDP> {
    return url.startsWith("unix:") ? CDP.#connectSocket(url.slice("unix:".length)) : CDP.#connectWebSocket(url);
  }

  static #connectWebSocket(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
      ws.addEventListener(
        "open",
        () =>
          resolve(
            new CDP((events) => {
              ws.addEventListener("message", (event) => events.message(String(event.data)));
              ws.addEventListener("close", events.close);
              return { send: (message) => ws.send(message), close: () => ws.close() };
            }),
          ),
        { once: true },
      );
    });
  }

  /** The daemon speaks the same protocol over a local socket, one JSON message per line. */
  static #connectSocket(path: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", () => reject(new Error(`could not connect to the open-eyes daemon at ${path}`)));
      socket.once("connect", () =>
        resolve(
          new CDP((events) => {
            socket.setEncoding("utf8");
            let buffer = "";
            socket.on("data", (chunk: string) => {
              buffer += chunk;
              let newline;
              while ((newline = buffer.indexOf("\n")) !== -1) {
                events.message(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
              }
            });
            socket.on("close", events.close);
            return { send: (message) => socket.write(`${message}\n`), close: () => socket.end() };
          }),
        ),
      );
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.#nextId++;
    this.#transport.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { method, resolve, reject }));
  }

  close(): void {
    this.#transport.close();
  }

  #onMessage(raw: string): void {
    const message = JSON.parse(raw);
    if (message.id === undefined) return; // Events are not used yet.
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result);
  }
}
