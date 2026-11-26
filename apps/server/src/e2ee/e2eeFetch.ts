// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalJsonInEffect:off - The X25519 handshake and the AEAD have no Effect API, the wrapper rides the host's fetch like the bridge's own calls do, and the envelope rides JSON-RPC bodies.
import * as NodeCrypto from "node:crypto";

import {
  E2EE_HTTP_ACCEPT_HEADER,
  E2EE_HTTP_HELLO_HEADER,
  E2EE_HTTP_KEY_ID_HEADER,
  type E2eeAccept,
  type E2eeHello,
  McpE2eeEnvelope,
} from "@s8code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { aeadDecrypt, aeadEncrypt } from "./aead.ts";

const decodeEnvelope = Schema.decodeUnknownSync(McpE2eeEnvelope);

/** What one E2EE session to one /mcp endpoint holds. */
interface E2eeSession {
  /** The id the server minted, echoed on every envelope POST. */
  readonly keyId: string;
  /** The client encrypts with this; the server decrypts with it. */
  readonly send: Buffer;
  /** The server encrypts with this; the client decrypts with it. */
  readonly receive: Buffer;
  sendCounter: number;
  receiveCounter: number;
}

const counterBytes = (counter: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  return bytes;
};

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
};

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** The plaintext inside a decrypted envelope: `{ t: "plain", message }`. */
export interface McpE2eePlayback {
  readonly t: "plain";
  readonly message: unknown;
}

/** One answered POST: like `Response`, with the JSON-RPC message already read. */
export interface E2eeFetchResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** The JSON-RPC message, the messages of one SSE response in order, or null. */
  readonly message: unknown;
  readonly text: string;
}

const toRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
};

/**
 * The client side of the /mcp E2EE handshake on node:crypto, verifying the
 * same values the browser client in client-runtime does. `keyId` arrives
 * separately, from the response headers.
 */
const acceptMcpServerHandshake = (
  accept: E2eeAccept,
  client: NodeCrypto.KeyPairKeyObjectResult,
  pinnedFingerprint: string | undefined,
  keyId: string,
): E2eeSession => {
  const serverEphemeral = NodeCrypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: accept.se },
    format: "jwk",
  });
  const dh1 = NodeCrypto.diffieHellman({
    privateKey: client.privateKey,
    publicKey: serverEphemeral,
  });
  const handshakeKey = Buffer.from(
    NodeCrypto.hkdfSync("sha256", dh1, Buffer.alloc(0), Buffer.from("s8-e2ee-1 hs"), 32),
  );
  const counter = counterBytes(0);
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    handshakeKey,
    Buffer.concat([Buffer.alloc(4), counter]),
  );
  decipher.setAAD(counter);
  decipher.setAuthTag(Buffer.from(Buffer.from(accept.ct, "base64url").subarray(-16)));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(Buffer.from(accept.ct, "base64url").subarray(0, -16))),
      decipher.final(),
    ]).toString("utf8"),
  ) as { sp: string; ep: string; sig: string };
  const staticPublic = Buffer.from(payload.sp, "base64url");
  const identityPublic = Buffer.from(payload.ep, "base64url");
  const clientEphemeral = Buffer.from(
    (client.publicKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
    "base64url",
  );
  const verified = NodeCrypto.verify(
    null,
    Buffer.concat([
      Buffer.from("s8-e2ee-1", "utf8"),
      clientEphemeral,
      Buffer.from(
        (serverEphemeral.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
        "base64url",
      ),
      staticPublic,
    ]),
    NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: identityPublic.toString("base64url") },
      format: "jwk",
    }),
    Buffer.from(payload.sig, "base64url"),
  );
  if (!verified) throw new Error("The server's E2EE handshake signature did not verify.");
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(Buffer.concat([identityPublic, staticPublic]))
    .digest("base64url");
  if (pinnedFingerprint !== undefined && fingerprint !== pinnedFingerprint) {
    throw new Error("The server's E2EE fingerprint does not match the pinned one.");
  }
  const dh2 = NodeCrypto.diffieHellman({
    privateKey: client.privateKey,
    publicKey: NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: payload.sp },
      format: "jwk",
    }),
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
  return {
    keyId,
    // Client send key first, client receive key second.
    send: material.subarray(32),
    receive: material.subarray(0, 32),
    sendCounter: 0,
    receiveCounter: 0,
  };
};

export interface E2eeFetchOptions {
  readonly endpoint: string;
  /** Extra headers every POST carries: authorization, mode limits, session id. */
  readonly headers: () => Record<string, string>;
  /** The host fetch, injectable for tests; the ambient one by default. */
  readonly fetchImplementation?:
    | ((url: string, init?: RequestInit) => Promise<Response>)
    | undefined;
  /**
   * The fingerprint the descriptor advertised; the handshake refuses a server
   * whose identity does not match it.
   */
  readonly pinnedFingerprint?: string | undefined;
}

/**
 * The client half of /mcp E2EE over plain `fetch`. The handshake rides the
 * first POST: a server that answers the hello without an accept header has no
 * E2EE identity, and the fetch stays plaintext for the connection's life. A
 * server that accepts keys every message after it into envelopes.
 */
export const makeE2eeFetch = (options: E2eeFetchOptions) => {
  const doFetch = options.fetchImplementation ?? fetch;
  const client = NodeCrypto.generateKeyPairSync("x25519");
  // Undefined until the hello resolves; "plain" once the server declines.
  let established: E2eeSession | "plain" | undefined;
  // The handshake, the counter handoffs, and the send-then-read are not
  // concurrency-safe; one writer at a time, as JSON-RPC HTTP clients go.
  const mutex = Semaphore.makeUnsafe(1);

  const plainPost = (message: unknown, extraHeaders: Record<string, string>) =>
    Effect.tryPromise({
      try: async () => {
        const response = await doFetch(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...options.headers(),
            ...extraHeaders,
          },
          body: JSON.stringify(message),
        });
        const text = await response.text();
        return {
          status: response.status,
          headers: toRecord(response.headers),
          message: parseJson(text),
          text,
        } satisfies E2eeFetchResult;
      },
      catch: asError,
    });

  const postHello = Effect.tryPromise({
    try: async () => {
      const hello: E2eeHello = {
        t: "hello",
        v: 1,
        ce: Buffer.from(
          (client.publicKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
          "base64url",
        ).toString("base64url"),
      };
      const response = await doFetch(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          [E2EE_HTTP_HELLO_HEADER]: JSON.stringify(hello),
          ...options.headers(),
        },
      });
      const acceptHeader = response.headers.get(E2EE_HTTP_ACCEPT_HEADER);
      const keyId = response.headers.get(E2EE_HTTP_KEY_ID_HEADER);
      await response.body?.cancel().catch(() => undefined);
      if (acceptHeader === null || keyId === null) return undefined;
      return { accept: JSON.parse(acceptHeader) as E2eeAccept, keyId };
    },
    catch: asError,
  });

  const envelopePost = (
    session: E2eeSession,
    message: unknown,
    extraHeaders: Record<string, string>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const counter = session.sendCounter;
        session.sendCounter = counter + 1;
        const envelope: McpE2eeEnvelope = {
          t: "e2ee",
          v: 1,
          c: counter,
          ct: aeadEncrypt(
            session.send,
            counter,
            new TextEncoder().encode(JSON.stringify(message)),
          ).toString("base64url"),
        };
        const response = await doFetch(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            [E2EE_HTTP_KEY_ID_HEADER]: session.keyId,
            ...options.headers(),
            ...extraHeaders,
          },
          body: JSON.stringify(envelope),
        });
        return { response, counter };
      },
      catch: asError,
    });

  const playResponse = (session: E2eeSession, response: Response, counter: number) =>
    Effect.tryPromise({
      try: async () => {
        const text = await response.text();
        const parsed = parseJson(text);
        const envelope = parsed === undefined ? undefined : decodeEnvelope(parsed);
        if (envelope === undefined || envelope.c !== counter) {
          throw new Error("The E2EE envelope answer did not match its request.");
        }
        const plain = JSON.parse(
          aeadDecrypt(session.receive, counter, Buffer.from(envelope.ct, "base64url")).toString(
            "utf8",
          ),
        ) as McpE2eePlayback;
        return {
          status: response.status,
          headers: toRecord(response.headers),
          message: plain.t === "plain" ? plain.message : undefined,
          text,
        } satisfies E2eeFetchResult;
      },
      catch: asError,
    });

  return {
    // Per-call headers ride beside the fixed ones, as the session id does.
    post: (
      message: unknown,
      extraHeaders: Record<string, string> = {},
    ): Effect.Effect<E2eeFetchResult, Error> =>
      mutex.withPermits(1)(
        Effect.suspend(() => {
          if (established === "plain") return plainPost(message, extraHeaders);
          const session = established;
          if (session !== undefined) {
            return Effect.flatMap(
              envelopePost(session, message, extraHeaders),
              ({ response, counter }) => playResponse(session, response, counter),
            );
          }
          return Effect.flatMap(postHello, (accepted) => {
            if (accepted === undefined) {
              established = "plain";
              return plainPost(message, extraHeaders);
            }
            return Effect.flatMap(
              // A rejected accept — a bad signature or a missed pin — fails
              // the message; the next one retries the handshake.
              Effect.try({
                try: () =>
                  acceptMcpServerHandshake(
                    accepted.accept,
                    client,
                    options.pinnedFingerprint,
                    accepted.keyId,
                  ),
                catch: asError,
              }),
              (session) => {
                established = session;
                return Effect.flatMap(
                  envelopePost(session, message, extraHeaders),
                  ({ response, counter }) => playResponse(session, response, counter),
                );
              },
            );
          });
        }),
      ),
  };
};

/**
 * Wraps the bridge's fetch shape: every POST to `endpoint` rides the envelope
 * once the server accepts the handshake, and its `Response` carries the
 * decrypted JSON-RPC message as the body. Other URLs and other methods pass
 * through untouched.
 */
export const e2eeFetchImplementation =
  (pinnedFingerprint: string | undefined) =>
  (
    baseFetch: (url: string, init?: RequestInit) => Promise<Response>,
    endpoint: string,
    headers: () => Record<string, string>,
  ): ((url: string, init?: RequestInit) => Promise<Response>) => {
    const e2ee = makeE2eeFetch({
      endpoint,
      headers,
      pinnedFingerprint,
      fetchImplementation: baseFetch,
    });
    const asResponse = (result: E2eeFetchResult): Response =>
      new Response(result.message === null ? "" : JSON.stringify(result.message), {
        status: result.status,
        headers: result.headers,
      });
    return (url, init) => {
      if (url !== endpoint || (init?.method !== undefined && init.method !== "POST")) {
        return baseFetch(url, init);
      }
      const run = Effect.runPromise(e2ee.post(parseJson(String(init?.body ?? ""))));
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        return run.then(asResponse, (cause) => Promise.reject(asError(cause)));
      }
      // A cancelled caller settles at once; the POST it started finishes on its own.
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(asError(new Error("The request was aborted."))),
          { once: true },
        );
      });
      return Promise.race([run, aborted]).then(asResponse, (cause) =>
        Promise.reject(asError(cause)),
      );
    };
  };
