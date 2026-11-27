// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics globalTimers:off - This transport runs without an Effect runtime.

import { acceptServerHandshake, helloHeadline, newClientEphemeral } from "./handshake.ts";
import { FrameCipher, importFrameKey } from "./protocol.ts";

/**
 * The device stream sockets ride the same handshake as /ws, but their frames
 * are binary device payloads, so both frame kinds encrypt here. The wrapper
 * adds `e2ee=1` itself and resolves once the accept verified, with the socket
 * patched to encrypt every `send` and deliver handlers the decrypted frames.
 */
export const e2eeDeviceWebSocket = async (
  url: string,
  pinnedFingerprint: string | undefined,
): Promise<WebSocket> => {
  const ws = new WebSocket(`${url}&e2ee=1`);
  ws.binaryType = "arraybuffer";
  const keyPair = await newClientEphemeral();
  const hello = await helloHeadline(keyPair);
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener(
      "open",
      () => {
        ws.send(hello);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => reject(new Error("The device stream socket could not open.")),
      { once: true },
    );
  });
  const accepted = await new Promise<Awaited<ReturnType<typeof acceptServerHandshake>>>(
    (resolve, reject) => {
      ws.addEventListener(
        "message",
        (event) => {
          if (typeof event.data !== "string") return;
          acceptServerHandshake(keyPair, JSON.parse(event.data), pinnedFingerprint).then(
            resolve,
            reject,
          );
        },
        { once: true },
      );
      void opened.catch(reject);
    },
  );
  const send = new FrameCipher(await importFrameKey(accepted.keys.send));
  const receive = new FrameCipher(await importFrameKey(accepted.keys.receive));
  const rawSend = ws.send.bind(ws);
  ws.send = (data) => {
    const bytes: Promise<Uint8Array<ArrayBuffer>> = Promise.resolve(data).then((chunk) => {
      if (chunk instanceof Blob) return chunk.arrayBuffer().then((body) => new Uint8Array(body));
      if (typeof chunk === "string") return new TextEncoder().encode(chunk);
      return new Uint8Array(chunk as ArrayBuffer);
    });
    void bytes
      .then((plain) => send.encrypt(plain))
      .then((frame) => rawSend(frame))
      .catch(() => ws.close());
  };
  const handlers: Array<(event: MessageEvent) => void> = [];
  let onmessage: ((event: MessageEvent) => unknown) | null = null;
  Object.defineProperty(ws, "onmessage", {
    get: () => onmessage,
    set(handler) {
      onmessage = handler;
    },
  });
  const rawAddEventListener = ws.addEventListener.bind(ws);
  ws.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type !== "message" || typeof listener !== "function") {
      rawAddEventListener(type, listener as EventListener, options);
      return;
    }
    handlers.push(listener);
  }) as typeof ws.addEventListener;
  rawAddEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (!(data instanceof ArrayBuffer)) return;
    receive
      .decrypt(new Uint8Array(data))
      .then((plain) => {
        const frame = plain.buffer.slice(
          plain.byteOffset,
          plain.byteOffset + plain.byteLength,
        ) as ArrayBuffer;
        for (const handler of handlers) handler({ ...(event as MessageEvent), data: frame });
        if (onmessage !== null) onmessage({ ...(event as MessageEvent), data: frame });
      })
      .catch(() => ws.close());
  });
  return ws;
};
