// types
export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, ...args: any[]) => void;

export interface WSOptions<T = any> {
  source: string;
  type: string;
  url?: string;
  getUrl?: () => string | Promise<string>;
  protocols?: string | string[];
  onOpen?: (ws: WebSocket) => void | Promise<void>;
  onMessage: (data: T, raw: string) => Promise<void> | void;
  onClose?: (ev: { code: number; reason: string }) => void;
  shouldRetry?: (ev: { code: number; reason: string }) => boolean;
  onReconnectAttempt?: (
    attempt: number,
    delayMs: number,
    ev?: { code: number; reason: string }
  ) => void;

  log?: Logger;
  parse?: (raw: string) => T | undefined;
  headers?: Record<string, string>;

  pingIntervalMs?: number;
  pongTimeoutMs?: number;

  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectJitter?: number;

  // backpressure
  concurrency?: number;
  maxQueueSize?: number;
  onDroppedMessage?: (raw: string) => void;

  // portability
  wsImpl?: typeof WebSocket; // inject in Node with `ws`
}

type State = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export class SocketFlow<T = any> {
  private ws?: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private closedByUser = false;
  private backoffMs: number;
  private readonly maxBackoff: number;
  private state: State = "idle";
  private attempts = 0;

  // backpressure
  private q: string[] = [];
  private inFlight = 0;

  constructor(private opts: WSOptions<T>) {
    this.opts = {
      pingIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      reconnectJitter: 0.2,
      concurrency: 4,
      maxQueueSize: 10_000,
      parse: (raw) => JSON.parse(raw) as T,
      log: (lvl, ...args) => {
        const host = this.opts.url ? new URL(this.opts.url).host : "ws";
        const tag = `[ws:${host}]`;
        (lvl === "info"
          ? console.log
          : lvl === "warn"
          ? console.warn
          : console.error)(tag, ...args);
      },
      shouldRetry: () => true,
      ...opts,
    };
    this.backoffMs = this.opts.reconnectBaseMs!;
    this.maxBackoff = this.opts.reconnectMaxMs!;
  }

  getState() {
    return this.state;
  }

  /** Safe accessor for the raw socket */
  public get socket(): WebSocket | undefined {
    return this.ws;
  }

  start() {
    this.closedByUser = false;
    void this.connect();
  }

  stop() {
    this.closedByUser = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {}
    this.ws = undefined;
    this.state = "closed";
  }

  private async connect() {
    this.clearTimers();
    this.state = this.attempts === 0 ? "connecting" : "reconnecting";

    const url = this.opts.url ?? (await this.opts.getUrl?.());
    if (!url) throw new Error("SocketFlow: url or getUrl() required");

    const Impl = this.opts.wsImpl ?? (WebSocket as any);

    let ws: any;
    if (this.opts.headers && Impl === (WebSocket as any)) {
      // browser WebSocket doesn’t support headers
      ws = new Impl(url, this.opts.protocols);
    } else if (this.opts.headers) {
      // Node ws supports headers
      ws = new Impl(url, this.opts.protocols, { headers: this.opts.headers });
    } else {
      ws = new Impl(url, this.opts.protocols);
    }

    this.ws = ws;


    // Browser style
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", this.onOpen);
      ws.addEventListener("message", this.onMessage);
      ws.addEventListener("error", this.onError);
      ws.addEventListener("close", this.onClose);
    }

    // Node 'ws' style
    if (typeof ws.on === "function") {
      ws.on("open", this.onOpen);
      ws.on("message", this.onMessage);
      ws.on("error", this.onError);
      ws.on("close", this.onClose);
      ws.on("pong", () => this.resetPongTimer());
    }
  }

  private onOpen = async () => {
    this.opts.log!("info", "connected");
    this.state = "open";
    this.attempts = 0;
    this.backoffMs = this.opts.reconnectBaseMs!;
    this.startHeartbeat();
    await this.opts.onOpen?.(this.ws!);
  };

  private onMessage = async (evt: any) => {
    const raw =
      typeof evt?.data === "string"
        ? evt.data
        : typeof evt === "string"
        ? evt
        : evt?.toString?.() ?? "";
    if (this.q.length >= this.opts.maxQueueSize!) {
      this.opts.onDroppedMessage?.(raw);
      return;
    }
    this.q.push(raw);
    this.drain();
  };

  private drain() {
    const max = this.opts.concurrency!;
    while (this.inFlight < max && this.q.length) {
      const raw = this.q.shift()!;
      let parsed: T | undefined;
      try {
        parsed = this.opts.parse!(raw);
      } catch (e) {
        this.opts.log!("warn", "parse error:", (e as Error).message);
        continue;
      }
      if (parsed === undefined) continue;

      this.inFlight++;
      Promise.resolve(this.opts.onMessage(parsed, raw))
        .catch((e) =>
          this.opts.log!("error", "onMessage threw:", (e as Error).message)
        )
        .finally(() => {
          this.inFlight--;
          if (this.q.length) this.drain();
        });
    }
  }

  private onError = (err: any) =>
    this.opts.log!("warn", "socket error:", err);

  private onClose = (ev: any) => {
    const code = ev?.code ?? 0;
    const reason = (ev?.reason ?? "").toString();
    this.opts.log!("warn", `closed code=${code} reason=${reason}`);
    this.opts.onClose?.({ code, reason });
    this.clearTimers();
    if (!this.closedByUser && this.opts.shouldRetry!({ code, reason })) {
      this.scheduleReconnect(false, { code, reason });
    } else {
      this.state = "closed";
    }
  };

  private startHeartbeat() {
    const ms = this.opts.pingIntervalMs!;
    if (!ms || ms <= 0) return;
    this.pingTimer = setInterval(() => {
      try {
        if (!this.ws) return;
        const OPEN = (this.ws as any).OPEN ?? 1;
        if ((this.ws as any).readyState === OPEN) {
          if (typeof (this.ws as any).ping === "function")
            (this.ws as any).ping();
          else (this.ws as any).send?.(JSON.stringify({ type: "ping" }));
          this.resetPongTimer();
        }
      } catch (e) {
        this.opts.log!("warn", "ping failed:", e);
      }
    }, ms);
    this.resetPongTimer();
  }

  private resetPongTimer() {
    const timeoutMs = this.opts.pongTimeoutMs!;
    if (!timeoutMs || timeoutMs <= 0) return;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.opts.log!("warn", "pong timeout; reconnecting");
      try {
        this.ws?.close();
      } catch {}
      this.scheduleReconnect(true);
    }, timeoutMs + 100);
  }

  private scheduleReconnect(force = false, ev?: { code: number; reason: string }) {
    if (this.closedByUser) return;
    const base = this.opts.reconnectBaseMs!,
      cap = this.maxBackoff;
    const jitterDelay = Math.max(
      250,
      Math.min(this.decorrelatedJitter(base, cap), cap)
    );
    const delay = force ? 0 : jitterDelay;
    this.attempts += 1;
    this.opts.onReconnectAttempt?.(this.attempts, delay, ev);
    this.opts.log!("info", `reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private decorrelatedJitter(base: number, cap: number) {
    // AWS Architecture Blog pattern
    const max = Math.min(cap, this.backoffMs * 3);
    const delay = Math.floor(Math.random() * (max - base) + base);
    this.backoffMs = Math.min(cap, Math.max(base, delay));
    return this.backoffMs;
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.reconnectTimer = undefined;
  }
}
