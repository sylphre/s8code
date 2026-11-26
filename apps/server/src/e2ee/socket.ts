// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import {
  decodeE2eeFrame,
  E2eeFrameError,
  encodeE2eeFrameCounter,
  E2eeHello,
  type E2eeHello as E2eeHelloType,
} from "@s8code/contracts";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { aeadDecrypt, aeadEncrypt } from "./aead.ts";
import type { E2eeHandshakeError, ServerHandshakeResult } from "./handshake.ts";

const decodeHello = Schema.decodeUnknownEffect(Schema.fromJsonString(E2eeHello));

interface Session {
  readonly keys: ServerHandshakeResult["keys"];
  sendCounter: number;
  receiveCounter: number;
}

const readError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });

const writeError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) });

const decryptFrame = (session: Session, frame: Uint8Array): string => {
  const { counter, ciphertext } = decodeE2eeFrame(frame);
  if (counter !== session.receiveCounter) {
    throw new E2eeFrameError();
  }
  session.receiveCounter += 1;
  return Buffer.from(aeadDecrypt(session.keys.receive, counter, ciphertext)).toString("utf8");
};

const decryptBinaryFrame = (session: Session, frame: Uint8Array): Uint8Array => {
  const { counter, ciphertext } = decodeE2eeFrame(frame);
  if (counter !== session.receiveCounter) {
    throw new E2eeFrameError();
  }
  session.receiveCounter += 1;
  return aeadDecrypt(session.keys.receive, counter, ciphertext);
};

const decryptPull = (
  state: { session: Session | null },
  underlying: Socket.Reader,
): Socket.Reader["pull"] =>
  Effect.map(underlying.pull, (batch) =>
    Arr.map(batch, (frame) => {
      const session = state.session;
      if (session === null || typeof frame === "string") throw new E2eeFrameError();
      return decryptFrame(session, frame);
    }),
  );

const decryptPullBytes = (
  state: { session: Session | null },
  underlying: Socket.Reader,
): Socket.Reader["pull"] =>
  Effect.map(underlying.pull, (batch) =>
    Arr.map(batch, (frame) => {
      const session = state.session;
      if (session === null || typeof frame === "string") throw new E2eeFrameError();
      return decryptBinaryFrame(session, frame);
    }),
  );

/**
 * Wraps a WS RPC socket so the first inbound message must be the hello.
 * The accept goes out over the raw socket before any encrypted frame, and
 * writes wait for the session keys the handshake derives.
 */
export const e2eeServerSocket = Effect.fn("e2ee/socket.e2eeServerSocket")(function* (
  socket: Socket.Socket,
  acceptHello: (hello: E2eeHelloType) => Effect.Effect<ServerHandshakeResult, E2eeHandshakeError>,
  { binary = false }: { binary?: boolean } = {},
) {
  const keys = yield* Deferred.make<ServerHandshakeResult["keys"], never>();
  const state: { session: Session | null } = { session: null };

  const handshakePull = (
    underlying: Socket.Reader,
    rawWriter: Socket.Writer,
  ): Socket.Reader["pull"] =>
    Effect.flatMap(underlying.pull, (batch) =>
      Effect.gen(function* () {
        const first = batch[0]!;
        if (batch.length !== 1 || typeof first !== "string") {
          return yield* readError("expected the E2EE hello as the only first frame");
        }
        const hello = yield* decodeHello(first).pipe(Effect.mapError(readError));
        const result = yield* Effect.mapError(acceptHello(hello), readError);
        const sendAccept = (accept: ServerHandshakeResult["accept"]) =>
          rawWriter.write(JSON.stringify(accept));
        yield* Effect.mapError(sendAccept(result.accept), writeError);
        state.session = {
          keys: result.keys,
          sendCounter: 0,
          receiveCounter: 0,
        };
        yield* Deferred.succeed(keys, result.keys);
        return yield* (binary ? decryptPullBytes : decryptPull)(state, underlying);
      }),
    );

  const reader: Socket.Socket["reader"] = Effect.gen(function* () {
    const underlying = yield* socket.reader;
    const rawWriter = yield* socket.writer;
    let handshakeDone = false;
    const pull: Socket.Reader["pull"] = Effect.suspend(() =>
      handshakeDone
        ? (binary ? decryptPullBytes : decryptPull)(state, underlying)
        : handshakePull(underlying, rawWriter),
    );
    return { upgrade: underlying.upgrade, pull };
  });

  const writer: Socket.Socket["writer"] = Effect.map(socket.writer, (underlying) => {
    const send = (chunk: string): Effect.Effect<void, Socket.SocketError> =>
      Effect.flatMap(Deferred.await(keys), () =>
        Effect.suspend(() => {
          const session = state.session;
          if (session === null) return Effect.fail(writeError(new E2eeFrameError()));
          const counter = session.sendCounter++;
          const frame = aeadEncrypt(session.keys.send, counter, Buffer.from(chunk, "utf8"));
          return Effect.mapError(
            underlying.write(Buffer.concat([encodeE2eeFrameCounter(counter), frame])),
            writeError,
          );
        }),
      );
    const sendBytes = (chunk: Uint8Array): Effect.Effect<void, Socket.SocketError> =>
      Effect.flatMap(Deferred.await(keys), () =>
        Effect.suspend(() => {
          const session = state.session;
          if (session === null) return Effect.fail(writeError(new E2eeFrameError()));
          const counter = session.sendCounter++;
          const frame = aeadEncrypt(session.keys.send, counter, chunk);
          return Effect.mapError(
            underlying.write(Buffer.concat([encodeE2eeFrameCounter(counter), frame])),
            writeError,
          );
        }),
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

  return Socket.make({ reader, writer });
});
