// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import { E2EE_FRAME_COUNTER_BYTES, encodeE2eeFrameCounter } from "@s8code/contracts";
import * as Schema from "effect/Schema";

/**
 * Pure WebCrypto core of the E2EE client: key derivation, frame encoding and
 * decoding, and the client side of the handshake. No socket or Effect code
 * lives here, so every step is testable against node:crypto on its own.
 */

export const HANDSHAKE_INFO = "s8-e2ee-1 hs";
export const KEYS_INFO = "s8-e2ee-1 k";
export const TRANSCRIPT_LABEL = "s8-e2ee-1";

export class E2eeClientHandshakeError extends Schema.TaggedError<E2eeClientHandshakeError>()(
  "E2eeClientHandshakeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class E2eeFrameError extends Schema.TaggedError<E2eeFrameError>()("E2eeFrameError", {}) {
  override get message(): string {
    return "Malformed E2EE frame.";
  }
}

export interface E2eeSessionKeys {
  /** The client encrypts under this key. */
  readonly send: Uint8Array;
  /** The server sends under this key; the client decrypts with it. */
  readonly receive: Uint8Array;
}

const subtle = globalThis.crypto.subtle;

/** The 12-byte GCM nonce: 4 zero bytes, then the 8-byte counter. */
const frameNonce = (counter: number): Uint8Array =>
  concatBytes(new Uint8Array(4), encodeE2eeFrameCounter(counter));

export const sharedBitsWith = (
  keyPair: CryptoKeyPair,
  peerPublic: Uint8Array,
): Promise<Uint8Array> =>
  subtle
    .importKey("raw", peerPublic as BufferSource, { name: "X25519" }, false, [])
    .then((publicKey) =>
      subtle
        .deriveBits({ name: "X25519", public: publicKey }, keyPair.privateKey, 256)
        .then((bits) => new Uint8Array(bits)),
    );

/** AES-256-GCM frame body: ciphertext with the 16-byte tag appended. */
export const encryptFrame = (
  key: CryptoKey,
  counter: number,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> =>
  subtle.encrypt(
    {
      name: "AES-GCM",
      iv: frameNonce(counter) as Uint8Array<ArrayBuffer>,
      additionalData: encodeE2eeFrameCounter(counter) as Uint8Array<ArrayBuffer>,
      tagLength: 128,
    },
    key,
    plaintext,
  );

export const importFrameKey = (key: Uint8Array): Promise<CryptoKey> =>
  subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);

export const decryptFrame = (
  key: CryptoKey,
  counter: number,
  frame: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> =>
  subtle
    .decrypt(
      {
        name: "AES-GCM",
        iv: frameNonce(counter) as Uint8Array<ArrayBuffer>,
        additionalData: encodeE2eeFrameCounter(counter) as Uint8Array<ArrayBuffer>,
        tagLength: 128,
      },
      key,
      frame,
    )
    .then((plain) => new Uint8Array(plain));

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

/** HKDF-SHA256 with an empty salt, matching the server's node:crypto hkdfSync. */
const hkdf = (ikm: Uint8Array, info: string, length: number): Promise<Uint8Array> =>
  subtle
    .importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"])
    .then((key) =>
      subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(info),
        },
        key,
        length * 8,
      ),
    )
    .then((bits) => new Uint8Array(bits));

export const deriveHandshakeKey = (dh1: Uint8Array): Promise<Uint8Array> =>
  hkdf(dh1, HANDSHAKE_INFO, 32);

export const deriveSessionKeys = (dh1: Uint8Array, dh2: Uint8Array): Promise<E2eeSessionKeys> =>
  hkdf(concatBytes(dh1, dh2), KEYS_INFO, 64).then((keys) => ({
    send: keys.slice(32, 64),
    receive: keys.slice(0, 32),
  }));

export const handshakeTranscript = (
  clientEphemeral: Uint8Array,
  serverEphemeral: Uint8Array,
  staticPublic: Uint8Array,
): Uint8Array<ArrayBuffer> =>
  concatBytes(
    new TextEncoder().encode(TRANSCRIPT_LABEL),
    clientEphemeral,
    serverEphemeral,
    staticPublic,
  );

/**
 * One direction's frame state: AES key with its strictly increasing counter.
 * The next inbound counter must be exactly one past the last one.
 */
export class FrameCipher {
  #nextCounter = 0;

  readonly key: CryptoKey;

  constructor(key: CryptoKey) {
    this.key = key;
  }

  get nextCounter(): number {
    return this.#nextCounter;
  }

  /** Encrypts and returns `counter || ciphertext`, advancing the counter. */
  async encrypt(plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const counter = this.#nextCounter;
    this.#nextCounter += 1;
    const counterBytes = encodeE2eeFrameCounter(counter);
    const body = new Uint8Array(await encryptFrame(this.key, counter, plaintext));
    return concatBytes(counterBytes, body);
  }

  /** Accepts only `counter || ciphertext` whose counter is exactly the next one. */
  async decrypt(frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    if (frame.byteLength <= E2EE_FRAME_COUNTER_BYTES) {
      return await Promise.reject(new E2eeFrameError());
    }
    const counterBytes = frame.slice(0, E2EE_FRAME_COUNTER_BYTES);
    const expected = encodeE2eeFrameCounter(this.#nextCounter);
    for (let index = 0; index < E2EE_FRAME_COUNTER_BYTES; index += 1) {
      if (counterBytes[index] !== expected[index]) {
        return await Promise.reject(new E2eeFrameError());
      }
    }
    const body = frame.slice(E2EE_FRAME_COUNTER_BYTES);
    const plaintext = await decryptFrame(this.key, this.#nextCounter, body);
    this.#nextCounter += 1;
    return plaintext;
  }
}
