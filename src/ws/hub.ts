import crypto from "node:crypto";
import type http from "node:http";
import type net from "node:net";
import {
  CONTROL_SURFACE_WS_PATH,
  type ConnectedWebSocketEvent,
  type ControlSurfaceWebSocketClientEvent,
  type ControlSurfaceWebSocketServerEvent,
} from "../contracts/index.ts";

export type WebSocketClient = {
  id: string;
  socket: net.Socket;
  buffer: Buffer;
  subscriptions: Map<string, Set<string> | null>;
  fragmentBuffers: Buffer[];
  fragmentOpcode: number | null;
};

type WebSocketMessageHandler = (
  client: WebSocketClient,
  data: ControlSurfaceWebSocketClientEvent | unknown,
) => void | Promise<void>;

export class WebSocketHub {
  private readonly clients = new Map<string, WebSocketClient>();
  private readonly onMessage?: WebSocketMessageHandler;

  constructor(onMessage?: WebSocketMessageHandler) {
    this.onMessage = onMessage;
  }

  handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer | undefined,
    expectedToken: string,
  ): boolean {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CONTROL_SURFACE_WS_PATH) return false;
    const token = url.searchParams.get("token") ?? getBearerToken(req.headers.authorization);
    if (token !== expectedToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const client: WebSocketClient = {
      id: crypto.randomUUID(),
      socket,
      buffer: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      subscriptions: new Map(),
      fragmentBuffers: [],
      fragmentOpcode: null,
    };
    this.clients.set(client.id, client);
    socket.on("data", (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      void this.consumeFrames(client);
    });
    socket.on("close", () => this.clients.delete(client.id));
    socket.on("error", () => this.clients.delete(client.id));
    if (client.buffer.length > 0) {
      void this.consumeFrames(client);
    }
    const payload: ConnectedWebSocketEvent = { type: "connected", clientId: client.id };
    this.send(client.id, payload);
    return true;
  }

  broadcast(payload: ControlSurfaceWebSocketServerEvent): void {
    const piSessionId =
      "piSessionId" in payload ? (payload.piSessionId as string | undefined) : undefined;
    const eventType = payload.type;
    const frame = encodeFrame(JSON.stringify(payload));
    for (const client of this.clients.values()) {
      if (!piSessionId) {
        this.safeWrite(client, frame);
        continue;
      }
      if (client.subscriptions.size === 0) continue;
      const filter = client.subscriptions.get("*") ?? client.subscriptions.get(piSessionId);
      if (filter === undefined) continue;
      // null filter = all event types; Set filter = only matching types
      if (filter === null || filter.has(eventType)) {
        this.safeWrite(client, frame);
      }
    }
  }

  private safeWrite(client: WebSocketClient, frame: Buffer): void {
    try {
      client.socket.write(frame);
    } catch {
      this.clients.delete(client.id);
    }
  }

  subscribeClient(clientId: string, piSessionId: string, eventTypes?: string[]): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.subscriptions.set(piSessionId, eventTypes ? new Set(eventTypes) : null);
    }
  }

  unsubscribeClient(clientId: string, piSessionId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.subscriptions.delete(piSessionId);
  }

  send(clientId: string, payload: ControlSurfaceWebSocketServerEvent): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.socket.write(encodeFrame(JSON.stringify(payload)));
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.socket.end(encodeCloseFrame());
      } catch {}
    }
    this.clients.clear();
  }

  private async consumeFrames(client: WebSocketClient): Promise<void> {
    while (true) {
      const frame = decodeFrame(client.buffer);
      if (!frame) return;
      client.buffer = client.buffer.subarray(frame.bytesConsumed);

      // Control frames (close, ping) are never fragmented — handle before reassembly
      if (frame.opcode === 0x8) {
        this.clients.delete(client.id);
        client.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        client.socket.write(encodePongFrame(frame.payload));
        continue;
      }

      const iscontinuation = frame.opcode === 0x0;

      if (!frame.fin) {
        if (!iscontinuation) {
          client.fragmentOpcode = frame.opcode;
          client.fragmentBuffers = [frame.payload];
        } else {
          client.fragmentBuffers.push(frame.payload);
        }
        continue;
      }

      let payload: Buffer;
      let opcode: number;

      if (iscontinuation) {
        client.fragmentBuffers.push(frame.payload);
        payload = Buffer.concat(client.fragmentBuffers);
        opcode = client.fragmentOpcode ?? 0x1;
        client.fragmentBuffers = [];
        client.fragmentOpcode = null;
      } else {
        payload = frame.payload;
        opcode = frame.opcode;
      }

      if (opcode !== 0x1) continue;

      const text = payload.toString("utf8");
      let parsed: ControlSurfaceWebSocketClientEvent | unknown = text;
      try {
        parsed = JSON.parse(text) as ControlSurfaceWebSocketClientEvent;
      } catch {}
      await this.onMessage?.(client, parsed);
    }
  }
}

function getBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function encodePongFrame(payload: Buffer): Buffer {
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x8a;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x00]);
}

function decodeFrame(
  buffer: Buffer,
): { opcode: number; fin: boolean; payload: Buffer; bytesConsumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let offset = 2;
  let payloadLength = second & 0x7f;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return undefined;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return undefined;
    const value = Number(buffer.readBigUInt64BE(offset));
    payloadLength = value;
    offset += 8;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + payloadLength) return undefined;
  let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const decoded = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      decoded[index] = payload[index]! ^ mask[index % 4]!;
    }
    payload = decoded;
  }
  return { opcode, fin, payload, bytesConsumed: offset + maskBytes + payloadLength };
}
