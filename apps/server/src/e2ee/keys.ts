// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - X25519 and Ed25519 key handling has no Effect API.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const IDENTITY_SECRET_NAME = "e2ee-identity-key";
const IDENTITY_SECRET_BYTES = 64;
// PKCS8 prefixes that wrap a raw 32-byte seed for each OKP curve.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface ServerIdentityKeys {
  readonly signing: NodeCrypto.KeyObject;
  readonly signingPublic: Uint8Array;
  readonly static: NodeCrypto.KeyObject;
  readonly staticPublic: Uint8Array;
  /** sha256 over both public keys, base64url, as clients pin it. */
  readonly fingerprint: string;
}

const privateFromSeed = (prefix: Buffer, seed: Uint8Array): NodeCrypto.KeyObject =>
  NodeCrypto.createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });

const rawPublicOf = (keyObject: NodeCrypto.KeyObject): Uint8Array =>
  Uint8Array.from(
    Buffer.from(
      (NodeCrypto.createPublicKey(keyObject).export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
      "base64url",
    ),
  );

const decodeIdentitySecret = (secret: Uint8Array): ServerIdentityKeys => {
  const signing = privateFromSeed(ED25519_PKCS8_PREFIX, secret.slice(0, 32));
  const kex = privateFromSeed(X25519_PKCS8_PREFIX, secret.slice(32, IDENTITY_SECRET_BYTES));
  const signingPublic = rawPublicOf(signing);
  const staticPublic = rawPublicOf(kex);
  return {
    signing,
    signingPublic,
    static: kex,
    staticPublic,
    fingerprint: fingerprintOf(signingPublic, staticPublic),
  };
};

const fingerprintOf = (signingPublic: Uint8Array, staticPublic: Uint8Array): string =>
  NodeCrypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from(signingPublic), Buffer.from(staticPublic)]))
    .digest("base64url");

/**
 * The Ed25519 identity key signs handshakes and its fingerprint is what
 * clients pin. Like server-signing-key, it is a server-side endpoint key,
 * not a client key.
 */
export const loadOrCreateServerIdentity = Effect.fn("e2ee.keys.loadOrCreateServerIdentity")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    const existing = yield* secrets.get(IDENTITY_SECRET_NAME);
    if (Option.isSome(existing) && existing.value.byteLength === IDENTITY_SECRET_BYTES) {
      return decodeIdentitySecret(existing.value);
    }
    const generated = yield* Effect.sync(() => {
      const signing = NodeCrypto.generateKeyPairSync("ed25519");
      const kex = NodeCrypto.generateKeyPairSync("x25519");
      return Uint8Array.from(
        Buffer.concat([
          Buffer.from(
            (signing.privateKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).d!,
            "base64url",
          ),
          Buffer.from(
            (kex.privateKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).d!,
            "base64url",
          ),
        ]),
      );
    });
    yield* secrets
      .create(IDENTITY_SECRET_NAME, generated)
      .pipe(Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void));
    // A concurrent server may have written its own key first; both must agree on one.
    const stored = yield* secrets.get(IDENTITY_SECRET_NAME);
    if (Option.isSome(stored) && stored.value.byteLength === IDENTITY_SECRET_BYTES) {
      return decodeIdentitySecret(stored.value);
    }
    return yield* Effect.die(new Error("Failed to persist the server E2EE identity key."));
  },
);
