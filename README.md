# SocketFlow

⚡ A resilient, typed, isomorphic WebSocket client for **Node.js** and **Browsers**.  
Handles reconnects, heartbeats, backpressure, and parsing — so you can focus on your business logic.

---

## Features

- Auto-reconnect with exponential backoff + decorrelated jitter
- Heartbeat / ping-pong keepalive with reconnect-on-timeout
- Backpressure control (bounded queue, concurrency, dropped message hook)
- Type-safe: use generics for parsed messages
- Isomorphic: works in Node (`ws`) and browser (`WebSocket`)
- Customizable logging, parsing, retry policy, and metrics hooks

---

## Installation

```bash
npm install socketflow
# or
yarn add socketflow
```

For **Node.js**, also install the [`ws`](https://www.npmjs.com/package/ws) package:

```bash
npm install ws
```

---

## Quickstart

```ts
import { SocketFlow } from "socketflow";

type FinnhubMsg = { type: string; data?: any[] };

const socket = new SocketFlow<FinnhubMsg>({
  source: "finnhub",
  type: "trades",
  getUrl: () => `wss://ws.finnhub.io?token=${process.env.FINNHUB_TOKEN}`,
  onOpen: (ws) => ws.send(JSON.stringify({ type: "subscribe", symbol: "AAPL" })),
  onMessage: (msg) => {
    if (msg.type === "trade") {
      console.log("Trade:", msg.data);
    }
  },
});

socket.start();
```

---

## ⚙️ API

### `new SocketFlow<T>(options: WSOptions<T>)`

Create a new WebSocket client.

---

### Options (`WSOptions<T>`)

#### Core
| Option              | Type                            | Default     | Description |
|---------------------|---------------------------------|-------------|-------------|
| `source`            | `string`                        | **required** | Identifier for logging/metrics (e.g., "finnhub") |
| `type`              | `string`                        | **required** | Sub-type of source (e.g., "trades") |
| `url`               | `string`                        | —           | Full WebSocket URL (e.g., wss://...) |
| `getUrl`            | `() => string | Promise<string>` | —         | Function to resolve URL dynamically (e.g., for rotating tokens) |
| `protocols`         | `string | string[]`            | —           | Optional subprotocols |
| `wsImpl`            | `typeof WebSocket`              | —           | Supply Node’s `ws` constructor |

---

#### Hooks
| Option              | Type                                | Description |
|---------------------|-------------------------------------|-------------|
| `onOpen`            | `(ws: WebSocket) => void | Promise<void>` | Called after socket connects |
| `onMessage`         | `(msg: T, raw: string) => void | Promise<void>` | Business logic handler for parsed messages |
| `onClose`           | `(ev: { code: number; reason: string }) => void` | Called when socket closes |
| `shouldRetry`       | `(ev: { code: number; reason: string }) => boolean` | Decide if reconnect should happen |
| `onReconnectAttempt`| `(attempt: number, delayMs: number, ev?: { code: number; reason: string }) => void` | Called before each reconnect |

---

#### Parsing & Logging
| Option      | Type                          | Default         | Description |
|-------------|-------------------------------|-----------------|-------------|
| `parse`     | `(raw: string) => T | undefined` | `JSON.parse`   | Custom parser for messages |
| `log`       | `(level: "info" | "warn" | "error", ...args: any[]) => void` | Console | Custom logger |

---

#### Heartbeat / Keepalive
| Option         | Type      | Default  | Description |
|----------------|-----------|----------|-------------|
| `pingIntervalMs` | `number` | `20000`  | Interval to send ping (0 disables) |
| `pongTimeoutMs`  | `number` | `10000`  | Reconnect if no pong within timeout |

---

#### Reconnect
| Option            | Type    | Default  | Description |
|-------------------|---------|----------|-------------|
| `reconnectBaseMs` | `number` | `1000`  | Initial backoff delay (ms) |
| `reconnectMaxMs`  | `number` | `30000` | Maximum backoff delay (ms) |
| `reconnectJitter` | `number` | `0.2`   | Random jitter factor (0–1) |

---

#### Backpressure
| Option            | Type      | Default   | Description |
|-------------------|-----------|-----------|-------------|
| `concurrency`     | `number`  | `4`       | Parallel onMessage handlers allowed |
| `maxQueueSize`    | `number`  | `10000`   | Max buffered messages before dropping |
| `onDroppedMessage`| `(raw: string) => void` | — | Called when message is dropped |

---

### Methods

| Method     | Returns     | Description |
|------------|-------------|-------------|
| `start()`  | `void`      | Connects and begins handling messages |
| `stop()`   | `void`      | Stops, closes socket, cancels reconnects |
| `getState()` | `"idle" | "connecting" | "open" | "reconnecting" | "closed"` | Current state |
| `socket` (getter) | `WebSocket | undefined` | Access underlying raw socket |

---

## 🔒 Example: Custom Retry Policy

```ts
const socket = new SocketFlow<MyMsg>({
  source: "finnhub",
  type: "trades",
  url: "wss://...",
  onMessage: (msg) => console.log(msg),
  shouldRetry: ({ code }) => code !== 4001, // don't retry invalid auth
});
```

---

## ⚡ Example: Backpressure

```ts
const socket = new SocketFlow<MyMsg>({
  source: "firehose",
  type: "stream",
  url: "wss://...",
  concurrency: 8,
  maxQueueSize: 1000,
  onDroppedMessage: (raw) => {
    console.warn("Dropped:", raw.slice(0, 100));
  },
  onMessage: async (msg) => {
    await processHeavy(msg); // processes up to 8 at a time
  },
});
```

---

## 🛠 State Machine

```
idle → connecting → open
         ↑          ↓
        reconnecting ← close/error
```

---

## 🧪 Roadmap
- [ ] Async iterator support (`for await (const msg of socketFlow) {}`)
- [ ] Built-in metrics exporter (Prometheus / OpenTelemetry)
- [ ] Subscription manager (auto-resubscribe to channels after reconnect)

---

## 📜 License

MIT © 2025
