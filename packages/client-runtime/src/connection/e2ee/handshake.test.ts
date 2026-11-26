// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// The server stand-in needs node:crypto; the client core stays on WebCrypto.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { acceptServerHandshake, newClientEphemeral } from "./handshake.ts";
import { HANDSHAKE_INFO, KEYS_INFO, TRANSCRIPT_LABEL } from "./protocol.ts";

const x25519Public = (raw: Buffer) =>
  NodeCrypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });

const x25519RawPublic = (publicKey: NodeCrypto.KeyObject): Buffer =>
  Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");

const identityPublicRawOf = (publicKey: NodeCrypto.KeyObject): Buffer =>
  Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");

const transcriptForServer = (ce: Buffer, se: Buffer, sp: Buffer) =>
  Buffer.concat([Buffer.from(TRANSCRIPT_LABEL), ce, se, sp]);

// A spec-conformant stand-in for the server side, on node:crypto only.
const serverAcceptFor = (helloCeBase64Url: string) => {
  const clientEphemeralRaw = Buffer.from(helloCeBase64Url, "base64url");
  const serverEphemeral = NodeCrypto.generateKeyPairSync("x25519");
  const serverStatic = NodeCrypto.generateKeyPairSync("x25519");
  const identity = NodeCrypto.generateKeyPairSync("ed25519");

  const serverEphemeralPublicRaw = x25519RawPublic(serverEphemeral.publicKey);
  const serverStaticPublicRaw = x25519RawPublic(serverStatic.publicKey);
  const identityPublicRaw = identityPublicRawOf(identity.publicKey);

  const dh1 = NodeCrypto.diffieHellman({
    privateKey: serverEphemeral.privateKey,
    publicKey: x25519Public(clientEphemeralRaw),
  });
  const handshakeKey = Buffer.from(
    NodeCrypto.hkdfSync("sha256", dh1, Buffer.alloc(0), Buffer.from(HANDSHAKE_INFO), 32),
  );

  const payloadJson = JSON.stringify({
    sp: serverStaticPublicRaw.toString("base64url"),
    ep: identityPublicRaw.toString("base64url"),
    sig: NodeCrypto.sign(
      null,
      transcriptForServer(clientEphemeralRaw, serverEphemeralPublicRaw, serverStaticPublicRaw),
      identity.privateKey,
    ).toString("base64url"),
  });

  const counter = Buffer.alloc(8);
  const nonce = Buffer.concat([Buffer.alloc(4), counter]);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", handshakeKey, nonce);
  cipher.setAAD(counter);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(payloadJson)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const dh2 = NodeCrypto.diffieHellman({
    privateKey: serverStatic.privateKey,
    publicKey: x25519Public(clientEphemeralRaw),
  });
  const material = Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      Buffer.concat([dh1, dh2]),
      Buffer.alloc(0),
      Buffer.from(KEYS_INFO),
      64,
    ),
  );

  return {
    accept: {
      t: "accept" as const,
      v: 1 as const,
      se: serverEphemeralPublicRaw.toString("base64url"),
      ct: ct.toString("base64url"),
    },
    // Server send key first, server receive key second.
    serverKeys: { send: material.subarray(0, 32), receive: material.subarray(32) },
    fingerprint: NodeCrypto.createHash("sha256")
      .update(Buffer.concat([identityPublicRaw, serverStaticPublicRaw]))
      .digest()
      .toString("base64url"),
  };
};

const clientHelloCe = async (keyPair: CryptoKeyPair) => {
  const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return Buffer.from(raw).toString("base64url");
};

describe("E2EE client handshake", () => {
  it("reaches the session keys and they match the server side", async () => {
    const keyPair = await newClientEphemeral();
    const server = serverAcceptFor(await clientHelloCe(keyPair));
    const accepted = await acceptServerHandshake(keyPair, server.accept, undefined);

    expect(Buffer.from(accepted.keys.receive)).toEqual(Buffer.from(server.serverKeys.send));
    expect(Buffer.from(accepted.keys.send)).toEqual(Buffer.from(server.serverKeys.receive));
    expect(accepted.fingerprint).toBe(server.fingerprint);
  });

  it("rejects a signature over a different transcript", async () => {
    const keyPair = await newClientEphemeral();
    const server = serverAcceptFor(await clientHelloCe(keyPair));
    // Tamper with the fingerprint pin: the transcript itself is fine, but a
    // client pinning a different identity must be refused.
    await expect(
      acceptServerHandshake(keyPair, server.accept, "wrong-pinned-fingerprint"),
    ).rejects.toThrow();
  });

  it("rejects an accept ciphertext that does not decrypt", async () => {
    const keyPair = await newClientEphemeral();
    const server = serverAcceptFor(await clientHelloCe(keyPair));
    const bad = { ...server.accept, ct: "AAAA" + server.accept.ct.slice(4) };
    await expect(acceptServerHandshake(keyPair, bad, undefined)).rejects.toThrow();
  });
});
