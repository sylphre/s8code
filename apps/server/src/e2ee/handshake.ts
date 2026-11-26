// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - The X25519 handshake has no Effect API.
import * as NodeCrypto from "node:crypto";

import type { E2eeAccept, E2eeHello } from "@s8code/contracts";
import * as Schema from "effect/Schema";

import type { ServerIdentityKeys } from "./keys.ts";
import { aeadEncrypt } from "./aead.ts";

const HANDSHAKE_INFO = "s8-e2ee-1 hs";
const KEYS_INFO = "s8-e2ee-1 k";
const TRANSCRIPT_LABEL = "s8-e2ee-1";

export interface E2eeSessionKeys {
  /** The server sends under this key. */
  readonly send: Buffer;
  /** The server receives under this key. */
  readonly receive: Buffer;
}

export interface ServerHandshakeResult {
  readonly accept: E2eeAccept;
  readonly keys: E2eeSessionKeys;
}

export const HANDSHAKE_REPLAY_MARKER_PREFIX = "e2ee-hello-";

export class E2eeHandshakeError extends Schema.TaggedError<E2eeHandshakeError>()(
  "E2eeHandshakeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `E2EE handshake rejected: ${this.detail}.`;
  }
}

export const handshakeReplayMarkerName = (clientEphemeral: Uint8Array): string =>
  `${HANDSHAKE_REPLAY_MARKER_PREFIX}${NodeCrypto.createHash("sha256")
    .update(Buffer.from(clientEphemeral))
    .digest("base64url")}`;

const x25519PublicKey = (raw: Uint8Array): NodeCrypto.KeyObject =>
  NodeCrypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });

const dh = (privateKey: NodeCrypto.KeyObject, peerPublic: Uint8Array): Buffer =>
  Buffer.from(NodeCrypto.diffieHellman({ privateKey, publicKey: x25519PublicKey(peerPublic) }));

const x25519RawPublic = (keyObject: NodeCrypto.KeyObject): Buffer =>
  Buffer.from(
    (NodeCrypto.createPublicKey(keyObject).export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
    "base64url",
  );

const hkdf = (ikm: Buffer, info: string, length: number): Buffer =>
  Buffer.from(
    NodeCrypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), length),
  );

const sessionKeysOf = (dh1: Buffer, dh2: Buffer): E2eeSessionKeys => {
  const keys = hkdf(Buffer.concat([dh1, dh2]), KEYS_INFO, 64);
  return { send: keys.subarray(0, 32), receive: keys.subarray(32, 64) };
};

/** The server signs the transcript: label, both ephemeral keys, then its static key. */
const handshakeTranscript = (
  clientEphemeral: Uint8Array,
  serverEphemeral: Uint8Array,
  staticPublic: Uint8Array,
): Buffer =>
  Buffer.concat([
    Buffer.from(TRANSCRIPT_LABEL, "utf8"),
    Buffer.from(clientEphemeral),
    Buffer.from(serverEphemeral),
    Buffer.from(staticPublic),
  ]);

/**
 * Computes the server's `accept` message and the session keys. The static
 * identity rides encrypted under the ephemeral-only key, so an observer never
 * learns it, and the client still verifies the signature with the identity
 * inside it.
 */
export const serverAccept = (
  identity: ServerIdentityKeys,
  hello: E2eeHello,
): ServerHandshakeResult => {
  const clientEphemeral = Buffer.from(hello.ce, "base64url");
  if (clientEphemeral.length !== 32) {
    throw new E2eeHandshakeError({ detail: "bad hello key" });
  }
  const serverEphemeral = NodeCrypto.generateKeyPairSync("x25519");
  const serverEphemeralPublic = x25519RawPublic(serverEphemeral.publicKey);
  const dh1 = dh(serverEphemeral.privateKey, clientEphemeral);
  const handshakeKey = hkdf(dh1, HANDSHAKE_INFO, 32);
  const staticPublic = Buffer.from(identity.staticPublic);
  const payload = Buffer.from(
    JSON.stringify({
      sp: staticPublic.toString("base64url"),
      ep: Buffer.from(identity.signingPublic).toString("base64url"),
      sig: NodeCrypto.sign(
        null,
        handshakeTranscript(clientEphemeral, serverEphemeralPublic, staticPublic),
        identity.signing,
      ).toString("base64url"),
    }),
    "utf8",
  );
  const accept: E2eeAccept = {
    t: "accept",
    v: 1,
    se: serverEphemeralPublic.toString("base64url"),
    ct: aeadEncrypt(handshakeKey, 0, payload).toString("base64url"),
  };
  return {
    accept,
    keys: sessionKeysOf(dh1, dh(identity.static, clientEphemeral)),
  };
};
