// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics globalJsonInEffect:off - The envelope rides JSON-RPC bodies.
import {
  E2EE_HTTP_ACCEPT_HEADER,
  E2EE_HTTP_HELLO_HEADER,
  E2EE_HTTP_KEY_ID_HEADER,
  E2eeHello,
  McpE2eeEnvelope,
} from "@s8code/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { aeadDecrypt, aeadEncrypt } from "../e2ee/aead.ts";
import type { E2eeSessionKeys } from "../e2ee/handshake.ts";
import * as ServerE2ee from "../e2ee/layer.ts";

const decodeEnvelope = Schema.decodeUnknownSync(McpE2eeEnvelope);
const decodeHello = Schema.decodeUnknownSync(E2eeHello);
const encoder = new TextEncoder();

interface Session {
  readonly keys: E2eeSessionKeys;
  sendCounter: number;
  receiveCounter: number;
}

const e2eeFailure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: code, message },
    { status, headers: { "cache-control": "no-store" } },
  );

const encryptedMessage = (
  session: Session,
  counter: number,
  message: unknown,
): McpE2eeEnvelope => ({
  t: "e2ee",
  v: 1,
  c: counter,
  ct: Buffer.from(
    aeadEncrypt(session.keys.send, counter, encoder.encode(JSON.stringify(message))),
  ).toString("base64url"),
});

const envelopeResponse = (
  session: Session,
  counter: number,
  message: unknown,
  headers: Record<string, string>,
) =>
  HttpServerResponse.uint8Array(
    encoder.encode(JSON.stringify(encryptedMessage(session, counter, message))),
    {
      contentType: "application/json",
      headers: { "cache-control": "no-store", ...headers },
    },
  );

/**
 * Reads the JSON-RPC message, or the JSON error body, the transport answered
 * with. None keeps the response byte-for-byte: an empty body, typically an
 * accepted notification, stays empty.
 */
const responseMessage = (
  response: HttpServerResponse.HttpServerResponse,
): Option.Option<unknown> => {
  const body = response.body;
  if (body._tag !== "Uint8Array" || body.contentLength === 0) return Option.none();
  const source = body.text ?? Buffer.from(body.body).toString("utf8");
  const parsed = (() => {
    try {
      return JSON.parse(source) as unknown;
    } catch {
      return undefined;
    }
  })();
  return parsed === undefined ? Option.none() : Option.some(parsed);
};

/**
 * Decrypts the POST body of an established E2EE session into its JSON-RPC
 * message. The inbound counter must be exactly one past the last message, as
 * the wire format prescribes. A body the session refuses stops the transport
 * and answers the plaintext refusal response.
 */
const decryptSessionBody = Effect.fn("mcpE2ee.decryptSessionBody")(function* (
  session: Session,
  body: string,
) {
  const parsed: unknown = yield* Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: () => e2eeFailure(400, "bad_e2ee_frame", "The E2EE message body must be JSON."),
  });
  if (typeof parsed !== "object" || parsed === null || (parsed as { t?: unknown }).t !== "e2ee") {
    return yield* Effect.fail(
      e2eeFailure(400, "plaintext_in_e2ee_session", "This session only takes E2EE envelopes."),
    );
  }
  const envelope = (() => {
    try {
      return decodeEnvelope(parsed);
    } catch {
      return undefined;
    }
  })();
  if (envelope === undefined || envelope.c !== session.receiveCounter) {
    return yield* Effect.fail(
      e2eeFailure(400, "bad_e2ee_frame", "The E2EE message counter is malformed or out of order."),
    );
  }
  const plaintext = yield* Effect.try({
    try: () =>
      Buffer.from(
        aeadDecrypt(session.keys.receive, envelope.c, Buffer.from(envelope.ct, "base64url")),
      ).toString("utf8"),
    catch: () => e2eeFailure(400, "bad_e2ee_frame", "The E2EE message could not be decrypted."),
  });
  session.receiveCounter += 1;
  return yield* Effect.try({
    try: () => JSON.parse(plaintext) as unknown,
    catch: () =>
      e2eeFailure(400, "bad_e2ee_frame", "The E2EE message must carry a JSON-RPC message."),
  });
});

type TransportHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

type McpE2eeMiddleware = (
  httpEffect: TransportHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeMcpE2eeMiddleware = Effect.gen(function* () {
  const serverE2ee = yield* Effect.serviceOption(ServerE2ee.ServerE2ee);
  const acceptHello = Option.map(serverE2ee, (service) => service.acceptHello);
  // Keys age out with the MCP sessions they mirror; a hello POST re-keys.
  const sessions = yield* Cache.make<string, Session>({
    lookup: () => Effect.die("An E2EE session only ever reads and writes its own keys."),
    capacity: 1_000,
    timeToLive: "24 hours",
  });
  // A server without its E2EE identity leaves the transport untouched, as /ws does.
  const e2eeAvailable = Option.isSome(serverE2ee)
    ? yield* serverE2ee.value.fingerprint
    : Option.none<string>();

  const runHandshake = (hello: E2eeHello) =>
    Option.match(acceptHello, {
      onNone: () =>
        Effect.die(new Error("The E2EE hello arrived with no server identity to answer it.")),
      onSome: (accept) => accept(hello),
    });

  return Effect.fnUntraced(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const helloHeader = request.headers[E2EE_HTTP_HELLO_HEADER];
    const keyId = request.headers[E2EE_HTTP_KEY_ID_HEADER];
    if (Option.isNone(e2eeAvailable)) return yield* httpEffect;
    if (helloHeader !== undefined) {
      const hello = (() => {
        try {
          return decodeHello(JSON.parse(helloHeader));
        } catch {
          return undefined;
        }
      })();
      if (hello === undefined) {
        return e2eeFailure(400, "bad_e2ee_hello", "The E2EE hello header must carry a hello.");
      }
      const accepted = yield* Effect.result(runHandshake(hello));
      if (Result.isFailure(accepted)) {
        return e2eeFailure(400, "e2ee_handshake_failed", "The E2EE handshake was rejected.");
      }
      const fresh: Session = { keys: accepted.success.keys, sendCounter: 0, receiveCounter: 0 };
      // The key id the client echoes back; the keys bind to it, not to a
      // session the transport has not minted yet.
      const freshId = SecureRandom.uuidV4Unsafe();
      yield* Effect.orDie(Cache.set(sessions, freshId, fresh));
      return HttpServerResponse.setHeaders(HttpServerResponse.empty(), {
        "cache-control": "no-store",
        [E2EE_HTTP_ACCEPT_HEADER]: JSON.stringify(accepted.success.accept),
        [E2EE_HTTP_KEY_ID_HEADER]: freshId,
      });
    }
    if (keyId === undefined) return yield* httpEffect;
    // An id this middleware never keyed is a plaintext client, and rides
    // untouched; a keyed one must speak envelopes.
    const session = Option.getOrUndefined(yield* Effect.orDie(Cache.getOption(sessions, keyId)));
    if (session === undefined) return yield* httpEffect;
    const decrypted = yield* Effect.result(
      Effect.flatMap(Effect.orDie(request.text), (body) => decryptSessionBody(session, body)),
    );
    if (Result.isFailure(decrypted)) return decrypted.failure;
    // The transport re-reads the body through the request, so it must see the
    // JSON-RPC message the envelope unwrapped, never the ciphertext.
    const transport = httpEffect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        Object.create(request, {
          text: { value: Effect.succeed(JSON.stringify(decrypted.success)) },
        }),
      ),
    );
    const exit = yield* Effect.exit(transport);
    if (Exit.isFailure(exit)) {
      return e2eeFailure(500, "e2ee_transport_failed", "The MCP transport failed under E2EE.");
    }
    const response = exit.value;
    const counter = session.sendCounter++;
    return envelopeResponse(
      session,
      counter,
      {
        t: "plain",
        message: Option.match(responseMessage(response), {
          onNone: () => null,
          onSome: (value) => value,
        }),
      },
      response.headers["mcp-session-id"] === undefined
        ? {}
        : { "mcp-session-id": response.headers["mcp-session-id"] },
    );
  }) satisfies McpE2eeMiddleware;
});

/**
 * Envelope encryption for /mcp, opt-in through the hello header. Runs outside
 * the auth middleware, so both wrap the transport the same way /ws does.
 */
export const layerMcpE2eeMiddleware = HttpRouter.middleware()(makeMcpE2eeMiddleware).layer;
