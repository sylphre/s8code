// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { E2eeAccept } from "@s8code/contracts";
import { acceptServerHandshake, helloHeadline, newClientEphemeral } from "./handshake.ts";
import { E2eeFrameError, FrameCipher, importFrameKey } from "./protocol.ts";
const decodeAccept = Schema.decodeUnknownSync(Schema.fromJsonString(E2eeAccept));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Ciphers {
  readonly send: FrameCipher;
  readonly receive: FrameCipher;
}

const importFrameKeyPair = async (keys: {
  send: Uint8Array;
  receive: Uint8Array;
}): Promise<Ciphers> => ({
  send: new FrameCipher(await importFrameKey(keys.send)),
  receive: new FrameCipher(await importFrameKey(keys.receive)),
});

const readError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });

const writeError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) });

const decryptFrameString = (keys: Ciphers, frame: string | Uint8Array): Promise<string> => {
  if (typeof frame !== "string") throw new E2eeFrameError();
  const bytes = textEncoder.encode(frame) as Uint8Array<ArrayBuffer>;
  return keys.receive.decrypt(bytes).then(textDecoder.decode);
};

const decryptFrameBytes = (keys: Ciphers, frame: string | Uint8Array): Promise<Uint8Array> => {
  if (typeof frame !== "string") return keys.receive.decrypt(frame as Uint8Array<ArrayBuffer>);
  return keys.receive.decrypt(textEncoder.encode(frame) as Uint8Array<ArrayBuffer>);
};

/**
 * Wraps a socket opened with `e2ee=1` so the first frame on the wire is the
 * hello, the first reply decrypts as the accept, and every later frame is an
 * AEAD frame. Writes wait for the handshake the reader completes, so the RPC
 * layer may start sending before the first pull. `binary` also encrypts
 * binary frames, for sockets whose payloads are not RPC strings.
 */
export const e2eeClientSocket = Effect.fn("e2ee/e2eeSocket.e2eeClientSocket")(function* (
  socket: Socket.Socket,
  pinnedFingerprint: string | undefined,
  { binary = false }: { binary?: boolean } = {},
) {
  const keyPair = yield* Effect.promise(() => newClientEphemeral());
  const hello = yield* Effect.promise(() => helloHeadline(keyPair));
  const ciphers = yield* Deferred.make<Ciphers, Socket.SocketError>();
  const state: { ciphers: Ciphers | null } = { ciphers: null };

  const writer: Socket.Socket["writer"] = Effect.map(socket.writer, (underlying) => {
    const send = (chunk: string): Effect.Effect<void, Socket.SocketError> =>
      Effect.flatMap(Deferred.await(ciphers), (keys) =>
        Effect.flatMap(
          Effect.tryPromise({
            try: () => keys.send.encrypt(textEncoder.encode(chunk)),
            catch: writeError,
          }),
          (frame) => Effect.mapError(underlying.write(frame), writeError),
        ),
      );
    const sendBytes = (chunk: Uint8Array): Effect.Effect<void, Socket.SocketError> =>
      Effect.flatMap(Deferred.await(ciphers), (keys) =>
        Effect.flatMap(
          Effect.tryPromise({
            try: () => keys.send.encrypt(chunk as Uint8Array<ArrayBuffer>),
            catch: writeError,
          }),
          (frame) => Effect.mapError(underlying.write(frame), writeError),
        ),
      );
    return {
      write: (chunk) =>
        typeof chunk === "string"
          ? send(chunk)
          : binary && !(chunk instanceof Socket.CloseEvent)
            ? sendBytes(chunk)
            : Effect.mapError(underlying.write(chunk), writeError),
      writeAll: (chunks) =>
        Effect.mapError(
          Effect.forEach(
            chunks,
            (chunk) =>
              typeof chunk === "string"
                ? send(chunk)
                : binary && !(chunk instanceof Socket.CloseEvent)
                  ? sendBytes(chunk)
                  : Effect.mapError(underlying.write(chunk), writeError),
            { discard: true },
          ),
          writeError,
        ),
    };
  });

  const reader: Socket.Socket["reader"] = Effect.gen(function* () {
    const underlying = yield* socket.reader;
    const underlyingWriter = yield* socket.writer;
    let handshakeDone = false;

    const decryptPull = (): Socket.Reader["pull"] =>
      Effect.flatMap(underlying.pull, (batch) =>
        Effect.map(
          Effect.tryPromise({
            try: () =>
              Promise.all(
                batch.map(async (frame) => {
                  const keys = state.ciphers;
                  if (keys === null) throw new E2eeFrameError();
                  return await decryptFrameString(keys, frame);
                }),
              ),
            catch: readError,
          }),
          (strings) => [strings[0]!, ...strings.slice(1)] as const,
        ),
      );

    const decryptPullBytes = (): Socket.Reader["pull"] =>
      Effect.flatMap(underlying.pull, (batch) =>
        Effect.map(
          Effect.tryPromise({
            try: () =>
              Promise.all(
                batch.map(async (frame) => {
                  const keys = state.ciphers;
                  if (keys === null) throw new E2eeFrameError();
                  return await decryptFrameBytes(keys, frame);
                }),
              ),
            catch: readError,
          }),
          (bytes) => [bytes[0]!, ...bytes.slice(1)] as const,
        ),
      );

    const pull: Socket.Reader["pull"] = Effect.suspend(() => {
      if (!handshakeDone)
        return Effect.flatMap(underlying.pull, (batch) =>
          Effect.gen(function* () {
            const frame = batch[0];
            if (batch.length !== 1 || typeof frame !== "string") {
              // @effect-diagnostics-next-line unnecessaryFailYieldableError:off
              return yield* Effect.fail(
                readError("expected the E2EE accept as the only first frame"),
              );
            }
            const accepted = yield* Effect.tryPromise({
              try: () => acceptServerHandshake(keyPair, decodeAccept(frame), pinnedFingerprint),
              catch: readError,
            });
            const keys = yield* Effect.promise(() => importFrameKeyPair(accepted.keys));
            state.ciphers = keys;
            handshakeDone = true;
            yield* Deferred.succeed(ciphers, keys);
            return yield* (binary ? decryptPullBytes : decryptPull)();
          }),
        );
      return (binary ? decryptPullBytes : decryptPull)();
    });

    // The server answers the hello with the accept, so it goes out before
    // the first pull.
    yield* Effect.mapError(underlyingWriter.write(hello), writeError);
    return { upgrade: underlying.upgrade, pull };
  });

  return Socket.make({ reader, writer });
});
