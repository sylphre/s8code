// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// The server stand-in needs node:crypto; the client core stays on WebCrypto.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  FrameCipher,
  decryptFrame,
  deriveHandshakeKey,
  deriveSessionKeys,
  encryptFrame,
  importFrameKey,
  HANDSHAKE_INFO,
  KEYS_INFO,
} from "./protocol.ts";

const aesKeyBytes = () => NodeCrypto.randomBytes(32);

describe("E2EE frames", () => {
  it("round-trips a frame through encrypt and decrypt", async () => {
    const key = await importFrameKey(aesKeyBytes());
    const encryptor = new FrameCipher(key);
    const decryptor = new FrameCipher(key);
    const plaintext = new TextEncoder().encode("frame body");

    const frame = await encryptor.encrypt(plaintext);
    expect(frame.byteLength).toBe(8 + plaintext.byteLength + 16);
    // The counter starts at zero.
    expect(frame[0]).toBe(0);
    expect(encryptor.nextCounter).toBe(1);
    expect(decryptor.nextCounter).toBe(0);

    const decrypted = await decryptor.decrypt(frame);
    expect(decryptor.nextCounter).toBe(1);
    expect(new TextDecoder().decode(decrypted)).toBe("frame body");
  });

  it("refuses a frame whose counter is not exactly the next one", async () => {
    const key = await importFrameKey(aesKeyBytes());
    const encryptor = new FrameCipher(key);
    const decryptor = new FrameCipher(key);
    const frame = await encryptor.encrypt(new TextEncoder().encode("first"));
    await decryptor.decrypt(frame);

    // Same counter again: reject.
    await expect(decryptor.decrypt(frame)).rejects.toThrow();

    // A skipped counter: reject.
    const skipped = frame.slice();
    skipped[7] = 2;
    await expect(decryptor.decrypt(skipped)).rejects.toThrow();
  });

  it("refuses a tampered frame body", async () => {
    const key = await importFrameKey(aesKeyBytes());
    const encryptCipher = new FrameCipher(key);
    const decryptCipher = new FrameCipher(key);
    const frame = await encryptCipher.encrypt(new TextEncoder().encode("body"));

    const tampered = frame.slice();
    tampered[tampered.byteLength - 1]! ^= 0x01;
    await expect(decryptCipher.decrypt(tampered)).rejects.toThrow();
  });

  it("keys the two directions independently", async () => {
    const clientToServer = NodeCrypto.randomBytes(32);
    const serverToClient = NodeCrypto.randomBytes(32);
    const message = new TextEncoder().encode("both ways");

    // Each direction's key is shared between its two ends, distinct from the other direction.
    const toServer = new FrameCipher(await importFrameKey(clientToServer));
    const atServer = new FrameCipher(await importFrameKey(clientToServer));
    const toClient = new FrameCipher(await importFrameKey(serverToClient));
    const atClient = new FrameCipher(await importFrameKey(serverToClient));

    const encrypted = await toServer.encrypt(message);
    expect(new TextDecoder().decode(await atServer.decrypt(encrypted))).toBe("both ways");
    const reply = await toClient.encrypt(message);
    expect(new TextDecoder().decode(await atClient.decrypt(reply))).toBe("both ways");

    // Frames from one direction do not decrypt under the other direction's key.
    await expect(atClient.decrypt(encrypted)).rejects.toThrow();
  });

  it("appends the 16-byte tag to the ciphertext", async () => {
    const key = await importFrameKey(aesKeyBytes());
    const plaintext = new TextEncoder().encode("tag appended");
    const encrypted = await encryptFrame(key, 0, plaintext);
    // WebCrypto appends the 16-byte tag to the ciphertext.
    expect(encrypted.byteLength).toBe(plaintext.byteLength + 16);
    const decrypted = await decryptFrame(key, 0, new Uint8Array(encrypted));
    expect(new TextDecoder().decode(decrypted)).toBe("tag appended");
  });

  it("derives the same session keys node:crypto would", async () => {
    const dh1 = NodeCrypto.randomBytes(32);
    const dh2 = NodeCrypto.randomBytes(32);
    const keys = await deriveSessionKeys(dh1, dh2);
    const material = Buffer.from(
      NodeCrypto.hkdfSync(
        "sha256",
        Buffer.concat([Buffer.from(dh1), Buffer.from(dh2)]),
        Buffer.alloc(0),
        Buffer.from(KEYS_INFO),
        64,
      ),
    );
    // First half of the material is what the server sends with (the client's receive key).
    expect(Buffer.from(keys.receive)).toEqual(material.subarray(0, 32));
    expect(Buffer.from(keys.send)).toEqual(material.subarray(32));
  });

  it("derives the handshake key the server derives", async () => {
    const dh1 = NodeCrypto.randomBytes(32);
    const handshakeKey = await deriveHandshakeKey(dh1);
    const material = Buffer.from(
      NodeCrypto.hkdfSync(
        "sha256",
        Buffer.from(dh1),
        Buffer.alloc(0),
        Buffer.from(HANDSHAKE_INFO),
        32,
      ),
    );
    expect(Buffer.from(handshakeKey)).toEqual(material);
  });
});
