// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - The client stand-in needs node:crypto.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { aeadDecrypt } from "./aead.ts";
import { serverAccept } from "./handshake.ts";
import type { ServerIdentityKeys } from "./keys.ts";

const rawPublic = (keyObject: NodeCrypto.KeyObject): Buffer =>
  Buffer.from(
    (
      (keyObject.type === "private" ? NodeCrypto.createPublicKey(keyObject) : keyObject).export({
        format: "jwk",
      }) as NodeCrypto.JsonWebKey
    ).x!,
    "base64url",
  );

const identityOf = (): ServerIdentityKeys => {
  const signing = NodeCrypto.generateKeyPairSync("ed25519");
  const kex = NodeCrypto.generateKeyPairSync("x25519");
  const signingPublic = rawPublic(signing.publicKey);
  const staticPublic = rawPublic(kex.publicKey);
  return {
    signing: signing.privateKey,
    signingPublic,
    static: kex.privateKey,
    staticPublic,
    fingerprint: NodeCrypto.createHash("sha256")
      .update(Buffer.concat([signingPublic, staticPublic]))
      .digest("base64url"),
  };
};

interface AcceptPayload {
  sp: string;
  ep: string;
  sig: string;
}

// Stands in for the client side of the handshake on node:crypto.
const acceptClientSide = (
  client: NodeCrypto.KeyPairKeyObjectResult,
  result: ReturnType<typeof serverAccept>,
) => {
  const dh1 = NodeCrypto.diffieHellman({
    privateKey: client.privateKey,
    publicKey: NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: result.accept.se },
      format: "jwk",
    }),
  });
  const handshakeKey = Buffer.from(
    NodeCrypto.hkdfSync("sha256", dh1, Buffer.alloc(0), Buffer.from("s8-e2ee-1 hs"), 32),
  );
  // The accept ciphertext rides the handshake key at counter 0, with no counter prefix.
  return {
    dh1,
    payload: JSON.parse(
      aeadDecrypt(handshakeKey, 0, Buffer.from(result.accept.ct, "base64url")).toString("utf8"),
    ) as AcceptPayload,
  };
};

describe("E2EE server handshake", () => {
  it("answers the hello with an accept and session keys", () => {
    const client = NodeCrypto.generateKeyPairSync("x25519");
    const result = serverAccept(identityOf(), {
      t: "hello",
      v: 1,
      ce: rawPublic(client.publicKey).toString("base64url"),
    });

    expect(result.accept.t).toBe("accept");
    expect(result.accept.v).toBe(1);
    expect(result.accept.se).not.toBe("");
    expect(result.accept.ct).not.toBe("");
    expect(result.keys.send.byteLength).toBe(32);
    expect(result.keys.receive.byteLength).toBe(32);
  });

  it("rejects a hello key that is not a raw X25519 public key", () => {
    const hello = { t: "hello" as const, v: 1 as const, ce: "AAAA" };
    expect(() => serverAccept(identityOf(), hello)).toThrow();
  });

  it("gives a client running the protocol the same keys, over a signed identity", () => {
    const identity = identityOf();
    const client = NodeCrypto.generateKeyPairSync("x25519");
    const clientEphemeral = rawPublic(client.publicKey);
    const result = serverAccept(identity, {
      t: "hello",
      v: 1,
      ce: clientEphemeral.toString("base64url"),
    });

    const { dh1, payload } = acceptClientSide(client, result);
    expect(payload.sp).toBe(Buffer.from(identity.staticPublic).toString("base64url"));
    expect(payload.ep).toBe(Buffer.from(identity.signingPublic).toString("base64url"));
    expect(
      NodeCrypto.verify(
        null,
        Buffer.concat([
          Buffer.from("s8-e2ee-1", "utf8"),
          clientEphemeral,
          Buffer.from(result.accept.se, "base64url"),
          Buffer.from(payload.sp, "base64url"),
        ]),
        NodeCrypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: payload.ep },
          format: "jwk",
        }),
        Buffer.from(payload.sig, "base64url"),
      ),
    ).toBe(true);

    // Both DH results ride the same HKDF, server send key first.
    const dh2 = NodeCrypto.diffieHellman({
      privateKey: client.privateKey,
      publicKey: identity.static,
    });
    const material = Buffer.from(
      NodeCrypto.hkdfSync(
        "sha256",
        Buffer.concat([dh1, dh2]),
        Buffer.alloc(0),
        Buffer.from("s8-e2ee-1 k"),
        64,
      ),
    );
    expect(Buffer.from(result.keys.send)).toEqual(material.subarray(0, 32));
    expect(Buffer.from(result.keys.receive)).toEqual(material.subarray(32));
  });
});
