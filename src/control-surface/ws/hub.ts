import crypto from "node:crypto";
import type http from "node:http";
import type net from "node:net";
import {
  CONTROL_SURFACE_WS_PATH,
  type ConnectedWebSocketEvent,
  type ControlSurfaceWebSocketClientEvent,
  type ControlSurfaceWebSocketServerEvent,
} from "../../contracts/index.ts";

export type WebSocketClient = {
  id: string;
  socket: net.Socket;
  buffer: Buffer;
  subscriptions: Set<string>;
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

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer | undefined, expectedToken: string): boolean {
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
      subscriptions: new Set(),
    };
    this.clients.set(client.id, client);
    socket.on("data", (chunk) => {
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
    const sessionId = "sessionId" in payload ? (payload as any).sessionId as string | undefined : undefined;
    const frame = encodeFrame(JSON.stringify(payload));
    for (const client of this.clients.values()) {
      // No sessionId on event → global event, deliver to all
      if (!sessionId) {
        client.socket.write(frame);
        continue;
      }
      // Client has no subscriptions → skip (they haven't subscribed to anything)
      if (client.subscriptions.size === 0) continue;
      // Wildcard or matching subscription
      if (client.subscriptions.has("*") || client.subscriptions.has(sessionId)) {
        client.socket.write(frame);
      }
    }
  }

  subscribeClient(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.subscriptions.add(sessionId);
  }

  unsubscribeClient(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.subscriptions.delete(sessionId);
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
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  private async consumeFrames(client: WebSocketClient): Promise<void> {
    while (true) {
      const frame = decodeFrame(client.buffer);
      if (!frame) return;
      client.buffer = client.buffer.subarray(frame.bytesConsumed);
      if (frame.opcode === 0x8) {
        this.clients.delete(client.id);
        client.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        client.socket.write(encodePongFrame(frame.payload));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      const text = frame.payload.toString("utf8");
      let parsed: ControlSurfaceWebSocketClientEvent | unknown = text;
      try {
        parsed = JSON.parse(text) as ControlSurfaceWebSocketClientEvent;
      } catch {
        // plain text frame
      }
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

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; bytesConsumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
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
      decoded[index] = payload[index] ^ mask[index % 4];
    }
    payload = decoded;
  }
  return { opcode, payload, bytesConsumed: offset + maskBytes + payloadLength };
}
