type Pending = {
  method: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
};

/** Minimal Chrome DevTools Protocol client over the browser-level WebSocket. */
export class CDP {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    ws.addEventListener("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error(`connection closed during ${p.method}`));
      this.#pending.clear();
    });
  }

  static connect(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { method, resolve, reject }));
  }

  close(): void {
    this.#ws.close();
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
