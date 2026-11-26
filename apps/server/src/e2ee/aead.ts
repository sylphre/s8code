// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - AES-256-GCM framing has no Effect API.
import * as NodeCrypto from "node:crypto";

import {
  E2EE_FRAME_COUNTER_BYTES,
  E2eeFrameError,
  encodeE2eeFrameCounter,
} from "@s8code/contracts";

const frameNonce = (counter: number): Buffer =>
  Buffer.concat([Buffer.alloc(12 - E2EE_FRAME_COUNTER_BYTES), encodeE2eeFrameCounter(counter)]);

export const aeadEncrypt = (key: Uint8Array, counter: number, plaintext: Uint8Array): Buffer => {
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(key), frameNonce(counter));
  cipher.setAAD(encodeE2eeFrameCounter(counter));
  return Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
};

export const aeadDecrypt = (key: Uint8Array, counter: number, ciphertext: Uint8Array): Buffer => {
  if (ciphertext.byteLength <= 16) {
    throw new E2eeFrameError();
  }
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key),
    frameNonce(counter),
  );
  decipher.setAAD(encodeE2eeFrameCounter(counter));
  decipher.setAuthTag(Buffer.from(ciphertext.subarray(ciphertext.byteLength - 16)));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext.subarray(0, ciphertext.byteLength - 16))),
    decipher.final(),
  ]);
};
