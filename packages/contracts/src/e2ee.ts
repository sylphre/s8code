// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import * as Schema from "effect/Schema";

/** WS upgrade query parameter a client sets to start the E2EE handshake. */
export const E2EE_QUERY_PARAM = "e2ee";
export const E2EE_PROTOCOL_VERSION = 1;

/**
 * E2EE covers the /ws RPC frames only. Health, probes, descriptor, pairing,
 * OAuth, attachments, terminal and device streams stay as they are, and mobile
 * connects without this query parameter.
 */
export const E2eeHello = Schema.Struct({
  t: Schema.Literal("hello"),
  v: Schema.Literal(1),
  /** Client ephemeral X25519 public key, base64url. */
  ce: Schema.String,
});
export type E2eeHello = typeof E2eeHello.Type;

export const E2eeAccept = Schema.Struct({
  t: Schema.Literal("accept"),
  v: Schema.Literal(1),
  /** Server ephemeral X25519 public key, base64url. */
  se: Schema.String,
  /** AES-256-GCM under the ephemeral-only key; decodes to E2eeAcceptPayload. */
  ct: Schema.String,
});
export type E2eeAccept = typeof E2eeAccept.Type;

export const E2eeAcceptPayload = Schema.Struct({
  /** Server static X25519 public key, base64url. */
  sp: Schema.String,
  /** Server Ed25519 identity public key, base64url. */
  ep: Schema.String,
  /** Ed25519 signature over the handshake transcript, base64url. */
  sig: Schema.String,
});
export type E2eeAcceptPayload = typeof E2eeAcceptPayload.Type;

/**
 * A post-handshake frame: `counter (8 bytes big-endian)` || `AES-256-GCM
 * ciphertext with its 16-byte tag`. The nonce is `4 zero bytes || counter`
 * (12-byte GCM nonce) and the AAD is the counter bytes alone.
 */
export const E2EE_FRAME_COUNTER_BYTES = 8;

export const encodeE2eeFrameCounter = (counter: number): Uint8Array => {
  const bytes = new Uint8Array(E2EE_FRAME_COUNTER_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter));
  return bytes;
};

export class E2eeFrameError extends Schema.TaggedError<E2eeFrameError>()("E2eeFrameError", {}) {
  override get message(): string {
    return "Malformed E2EE frame.";
  }
}

export const decodeE2eeFrame = (frame: Uint8Array): { counter: number; ciphertext: Uint8Array } => {
  if (frame.byteLength <= E2EE_FRAME_COUNTER_BYTES) throw new E2eeFrameError();
  const counterBytes = frame.slice(0, E2EE_FRAME_COUNTER_BYTES);
  return {
    counter: Number(new DataView(counterBytes.buffer, counterBytes.byteOffset).getBigUint64(0)),
    ciphertext: frame.slice(E2EE_FRAME_COUNTER_BYTES),
  };
};
