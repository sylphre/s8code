// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - The client stand-in needs node:crypto.
import * as NodeCrypto from "node:crypto";

import { decodeE2eeFrame } from "@s8code/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

import { aeadDecrypt } from "./aead.ts";
import type { ServerHandshakeResult } from "./handshake.ts";
import { e2eeServerSocket } from "./socket.ts";

const x25519RawPublic = (keyObject: NodeCrypto.KeyObject): Buffer => {
  // createPublicKey(keyObject) rejects public keys; public keys export directly.
  const jwk =
    keyObject.type === "private"
      ? NodeCrypto.createPublicKey(keyObject).export({ format: "jwk" })
      : keyObject.export({ format: "jwk" });
  return Buffer.from((jwk as NodeCrypto.JsonWebKey).x!, "base64url");
};

// A raw in-memory stand-in for the WS transport: writes are captured for the
// test to inspect, and the hello rides one Deferred-fed pull.
const wireSocket = Effect.gen(function* () {
  const sent: Array<string | Uint8Array> = [];
  const pullGate = yield* Deferred.make<string | Uint8Array>();
  const socket: Socket.Socket = {
    [Socket.TypeId]: Socket.TypeId,
    reader: Effect.succeed({
      pull: Effect.map(Deferred.await(pullGate), (frame) => [frame]),
      upgrade: () => Effect.die(new Error("no upgrade in the test wire")),
    }),
    writer: Effect.succeed({
      write: (chunk) => Effect.sync(() => void sent.push(chunk as string | Uint8Array)),
      writeAll: (chunks) =>
        Effect.sync(() => {
          for (const chunk of chunks) sent.push(chunk as string | Uint8Array);
        }),
    }),
  };
  return { socket, sent, hello: pullGate };
});

it.effect("sends post-handshake frames the wire format can decode", () =>
  Effect.gen(function* () {
    const client = NodeCrypto.generateKeyPairSync("x25519");
    const clientEphemeral = x25519RawPublic(client.publicKey);

    // The session keys the protocol prescribes, from the server side of the DH.
    const ephemeralPair = NodeCrypto.generateKeyPairSync("x25519");
    const dh1 = NodeCrypto.diffieHellman({
      privateKey: ephemeralPair.privateKey,
      publicKey: client.publicKey,
    });
    const staticPair = NodeCrypto.generateKeyPairSync("x25519");
    const dh2 = NodeCrypto.diffieHellman({
      privateKey: staticPair.privateKey,
      publicKey: client.publicKey,
    });
    const material = Buffer.from(
      NodeCrypto.hkdfSync(
        "sha256",
        Buffer.concat([dh1, dh2]),
        Buffer.alloc(0),
        Buffer.from("s8-e2ee-1 k", "utf8"),
        64,
      ),
    );
    const keys = { send: material.subarray(0, 32), receive: material.subarray(32, 64) };
    const result: ServerHandshakeResult = {
      accept: { t: "accept", v: 1, se: "", ct: "" },
      keys,
    };

    const wire = yield* wireSocket;
    const wrapped = yield* e2eeServerSocket(wire.socket, () => Effect.succeed(result));
    // The handshake runs inside the reader's first pull, so it must be pulled
    // before any encrypted write can go out.
    yield* Effect.forkChild(Effect.flatMap(wrapped.reader, ({ pull }) => pull));

    yield* Deferred.succeed(
      wire.hello,
      JSON.stringify({ t: "hello", v: 1, ce: clientEphemeral.toString("base64url") }),
    );
    const writer = yield* wrapped.writer;
    yield* writer.write("ping");
    const dataFrame = wire.sent[1];
    expect(typeof dataFrame).not.toBe("string");
    const { counter, ciphertext } = decodeE2eeFrame(Buffer.from(dataFrame as Uint8Array));
    // The accepted session must frame its ciphertext the way the client decodes it.
    expect(aeadDecrypt(keys.send, counter, ciphertext).toString("utf8")).toBe("ping");
  }),
);
