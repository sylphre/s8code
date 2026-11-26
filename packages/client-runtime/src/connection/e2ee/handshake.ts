// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";

import { E2eeAccept, E2eeHello, E2EE_PROTOCOL_VERSION } from "@s8code/contracts";
import {
  E2eeClientHandshakeError,
  decryptFrame,
  deriveHandshakeKey,
  deriveSessionKeys,
  handshakeTranscript,
  importFrameKey,
  sharedBitsWith,
  type E2eeSessionKeys,
} from "./protocol.ts";

const PayloadSchema = Schema.Struct({
  sp: Schema.String,
  ep: Schema.String,
  sig: Schema.String,
});

const decodePayload = Schema.decodeUnknownSync(PayloadSchema);

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> =>
  Result.getOrThrow(Base64Url.decode(value)) as Uint8Array<ArrayBuffer>;

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out as Uint8Array<ArrayBuffer>;
};

const importEd25519 = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);

const fingerprintOf = (identity: Uint8Array, staticPublic: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", concatBytes(identity, staticPublic))
    .then((digest) => Base64Url.encode(new Uint8Array(digest)));

export interface AcceptedServer {
  /** base64url of sha256 over the identity public key, then the static one. */
  readonly fingerprint: string;
  readonly keys: E2eeSessionKeys;
}

export const newClientEphemeral = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey("X25519", true, ["deriveBits"]);

const helloMessage = (clientEphemeral: Uint8Array): E2eeHello => ({
  t: "hello",
  v: E2EE_PROTOCOL_VERSION,
  ce: Base64Url.encode(clientEphemeral),
});

/** The first text frame to send once the socket with `e2ee=1` is open. */
export const helloHeadline = async (keyPair: CryptoKeyPair): Promise<string> =>
  JSON.stringify(
    helloMessage(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))),
  );

export const acceptServerHandshake = async (
  keyPair: CryptoKeyPair,
  accept: E2eeAccept,
  pinnedFingerprint: string | undefined,
): Promise<AcceptedServer> => {
  if (accept.t !== "accept" || accept.v !== 1) {
    throw new E2eeClientHandshakeError({ detail: "unknown handshake version" });
  }
  const serverEphemeral = decodeBase64Url(accept.se);
  const dh1 = await sharedBitsWith(keyPair, serverEphemeral);
  const handshakeKeyBytes = await deriveHandshakeKey(dh1);
  const payload = decodePayload(
    JSON.parse(
      new TextDecoder().decode(
        await decryptFrame(await importFrameKey(handshakeKeyBytes), 0, decodeBase64Url(accept.ct)),
      ),
    ),
  );
  const staticPublic = decodeBase64Url(payload.sp);
  const identityPublic = decodeBase64Url(payload.ep);
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    await importEd25519(identityPublic),
    decodeBase64Url(payload.sig),
    handshakeTranscript(
      await crypto.subtle
        .exportKey("raw", keyPair.publicKey)
        .then((raw) => new Uint8Array(raw) as Uint8Array<ArrayBuffer>),
      serverEphemeral,
      staticPublic,
    ),
  );
  if (!verified) {
    throw new E2eeClientHandshakeError({ detail: "signature" });
  }
  const fingerprint = await fingerprintOf(identityPublic, staticPublic);
  if (pinnedFingerprint !== undefined && fingerprint !== pinnedFingerprint) {
    throw new E2eeClientHandshakeError({ detail: "fingerprint" });
  }
  return {
    fingerprint,
    keys: await deriveSessionKeys(
      await sharedBitsWith(keyPair, serverEphemeral),
      await sharedBitsWith(keyPair, staticPublic),
    ),
  };
};
