// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import {
  AuthMcpClientAccess,
  type AuthSessionId,
  AuthMcpKeyAllowlist,
  type AuthMcpKeyAllowlistEntry,
} from "@s8code/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

// @effect-diagnostics nodeBuiltinImport:off - Ed25519 verification has no Effect API.
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as ServerE2ee from "../e2ee/layer.ts";
import { forkParked } from "../serverActivation.ts";
import { requestUrl } from "../requestUrl.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

export const KEY_CHALLENGE_MARKER_PREFIX = "key-challenge-";

const KEY_CHALLENGE_TTL = Duration.minutes(5);
const KEY_PUBLIC_KEY_BYTES = 32;
// DER header wrapping a raw Ed25519 public key, so node:crypto can build a KeyObject from it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const CREDENTIAL_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

export class KeyPairingError extends Schema.TaggedError<KeyPairingError>()("KeyPairingError", {
  reason: Schema.Literals([
    "invalid_request",
    "unknown_key",
    "unknown_challenge",
    "challenge_expired",
    "invalid_signature",
  ]),
}) {
  override get message(): string {
    return `Key pairing rejected: ${this.reason}.`;
  }
}

export const KeyVerifyRequest = Schema.Struct({
  publicKey: Schema.String,
  nonce: Schema.String,
  signature: Schema.String,
  label: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(AuthMcpClientAccess),
});
export type KeyVerifyRequest = typeof KeyVerifyRequest.Type;

export interface KeyChallenge {
  readonly nonce: string;
  readonly expiresAt: DateTime.Utc;
}

export interface KeyPairingResult {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly expiresAt: DateTime.DateTime;
}

/** The canonical string the client signs: the nonce plus where the verify request lands. */
export const keyChallengePayload = (input: {
  readonly nonce: string;
  readonly origin: string;
  readonly method: string;
  readonly path: string;
}): string => [input.nonce, input.origin, input.method, input.path].join("\n");

const challengeMarkerName = (nonceBytes: Uint8Array) =>
  `${KEY_CHALLENGE_MARKER_PREFIX}${NodeCrypto.createHash("sha256")
    .update(nonceBytes)
    .digest("base64url")}`;

const decodeBase64Url = (value: string): Uint8Array | undefined => {
  const bytes = Buffer.from(value, "base64url");
  return Buffer.from(bytes).toString("base64url") === value ? Uint8Array.from(bytes) : undefined;
};

const decodeMarkerExpiry = Schema.decodeOption(Schema.DateTimeUtcFromString);

const parseMarkerExpiry = (contents: Uint8Array): DateTime.Utc | undefined => {
  const line = new TextDecoder()
    .decode(contents)
    .split("\n")
    .find((line) => line.startsWith("expiresAt="));
  return line === undefined
    ? undefined
    : Option.getOrUndefined(decodeMarkerExpiry(line.slice("expiresAt=".length)));
};

const decodeAllowlistJson = Schema.decodeEffect(Schema.fromJsonString(AuthMcpKeyAllowlist));

const loadAllowlist = Effect.fn("KeyPairing.loadAllowlist")(function* (allowlistPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(allowlistPath).pipe(Effect.result);
  if (Result.isFailure(contents)) {
    if (contents.failure.reason._tag === "NotFound") return [];
    yield* Effect.logWarning("Failed to read mcp-allowlist.json; key pairing is off.", {
      cause: contents.failure,
    });
    return [];
  }
  const decoded = yield* decodeAllowlistJson(contents.success).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    yield* Effect.logWarning("Failed to decode mcp-allowlist.json; key pairing is off.", {
      cause: decoded.failure,
    });
    return [];
  }
  const entries: AuthMcpKeyAllowlistEntry[] = [];
  for (const entry of decoded.success) {
    if (decodeBase64Url(entry.publicKey)?.length !== KEY_PUBLIC_KEY_BYTES) {
      yield* Effect.logWarning("Dropped an mcp-allowlist.json entry with an invalid public key.", {
        label: entry.label,
      });
      continue;
    }
    entries.push(entry);
  }
  return entries;
});

const make = Effect.gen(function* () {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const e2ee = yield* ServerE2ee.ServerE2ee;

  const allowlistPath = pathService.join(config.stateDir, "mcp-allowlist.json");
  const allowlist = yield* Ref.make<AuthMcpKeyAllowlist>(yield* loadAllowlist(allowlistPath));

  const issueChallenge: KeyPairing["Service"]["issueChallenge"] = Effect.fn(
    "KeyPairing.issueChallenge",
  )(function* () {
    const nonceBytes = yield* secureRandom.randomBytes(KEY_PUBLIC_KEY_BYTES);
    const nonce = Buffer.from(nonceBytes).toString("base64url");
    const now = yield* DateTime.now;
    const expiresAt = DateTime.toUtc(
      DateTime.add(now, { milliseconds: Duration.toMillis(KEY_CHALLENGE_TTL) }),
    );
    yield* secretStore.create(
      challengeMarkerName(nonceBytes),
      new TextEncoder().encode(
        `issuedAt=${DateTime.formatIso(now)}\nexpiresAt=${DateTime.formatIso(expiresAt)}`,
      ),
    );
    return { nonce, expiresAt } satisfies KeyChallenge;
  });

  const verify = Effect.fn("KeyPairing.verify")(function* (
    request: HttpServerRequest.HttpServerRequest,
    payload: KeyVerifyRequest,
  ) {
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return yield* new KeyPairingError({ reason: "invalid_request" });
    }
    const nonceBytes = decodeBase64Url(payload.nonce);
    const publicKeyBytes = decodeBase64Url(payload.publicKey);
    const signatureBytes = decodeBase64Url(payload.signature);
    if (
      nonceBytes?.length !== KEY_PUBLIC_KEY_BYTES ||
      publicKeyBytes?.length !== KEY_PUBLIC_KEY_BYTES ||
      signatureBytes === undefined
    ) {
      return yield* new KeyPairingError({ reason: "invalid_request" });
    }

    const markerName = challengeMarkerName(nonceBytes);
    const marker = yield* secretStore.get(markerName);
    if (Option.isNone(marker)) {
      return yield* new KeyPairingError({ reason: "unknown_challenge" });
    }
    const expiry = parseMarkerExpiry(marker.value);
    const now = yield* DateTime.now;
    if (expiry === undefined || !DateTime.isGreaterThan(expiry, now)) {
      return yield* new KeyPairingError({ reason: "challenge_expired" });
    }

    const entries = yield* Ref.get(allowlist);

    const matchingKey = Buffer.from(publicKeyBytes);
    const paired = entries.find((entry) =>
      NodeCrypto.timingSafeEqual(Buffer.from(entry.publicKey, "base64url"), matchingKey),
    );
    if (paired === undefined) {
      return yield* new KeyPairingError({ reason: "unknown_key" });
    }

    const keyObject = NodeCrypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    const signed = Buffer.from(
      keyChallengePayload({
        nonce: payload.nonce,
        origin: url.value.origin,
        method: request.method,
        path: url.value.pathname,
      }),
      "utf8",
    );
    if (!NodeCrypto.verify(null, signed, keyObject, Buffer.from(signatureBytes))) {
      return yield* new KeyPairingError({ reason: "invalid_signature" });
    }

    // Consuming after the signature check keeps a failed verify from burning the challenge.
    yield* secretStore.remove(markerName);
    return yield* serverAuth.issueMcpClientSession({
      subject: EnvironmentAuth.KEY_PAIRED_SUBJECT,
      label: payload.label ?? "Key-paired client",
      access: payload.access ?? "approval-required",
      peerLink: false,
      client: deriveAuthClientMetadata({ request }),
    });
  });

  // Reload the allowlist when its file changes, so pairing keys turn over without a restart.
  const watchDirectory = pathService.dirname(allowlistPath);
  const watchAllowlist = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(watchDirectory, { recursive: true });
    yield* fileSystem.watch(watchDirectory).pipe(
      Stream.filter(
        (event) =>
          event.path === pathService.basename(allowlistPath) || event.path === allowlistPath,
      ),
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const entries = yield* loadAllowlist(allowlistPath);
          yield* Ref.set(allowlist, entries);
        }),
      ),
      Stream.runDrain,
    );
  }).pipe(Effect.ignoreCause({ log: true }));
  yield* forkParked(watchAllowlist);

  return KeyPairing.of({
    issueChallenge,
    verify,
    e2eeFingerprint: Option.filter(
      yield* e2ee.fingerprint,
      (fingerprint) => fingerprint.length > 0,
    ),
  });
});

export class KeyPairing extends Context.Service<
  KeyPairing,
  {
    readonly issueChallenge: () => Effect.Effect<KeyChallenge, ServerSecretStore.SecretStoreError>;
    readonly verify: (
      request: HttpServerRequest.HttpServerRequest,
      payload: KeyVerifyRequest,
    ) => Effect.Effect<
      KeyPairingResult,
      | KeyPairingError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInternalError
      | ServerSecretStore.SecretStoreError
    >;
    /** The server's E2EE identity fingerprint, so a pairing client can pin it without the descriptor. */
    readonly e2eeFingerprint: Option.Option<string>;
  }
>()("t3/auth/KeyPairing") {}

const jsonNoStore = (body: unknown, status: number) =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.map((response) => HttpServerResponse.setHeaders(response, CREDENTIAL_HEADERS)),
  );

const decodeVerifyRequest = Schema.decodeUnknownEffect(KeyVerifyRequest);

const challengeRouteLayer = HttpRouter.add(
  "POST",
  "/auth/key-challenge",
  Effect.gen(function* () {
    const keyPairing = yield* KeyPairing;
    const challenge = yield* keyPairing.issueChallenge();
    return yield* jsonNoStore(
      {
        nonce: challenge.nonce,
        expiresAt: DateTime.formatIso(challenge.expiresAt),
        ...(Option.isSome(keyPairing.e2eeFingerprint)
          ? { e2eeFingerprint: keyPairing.e2eeFingerprint.value }
          : {}),
      },
      200,
    );
  }).pipe(
    Effect.catchIf(ServerSecretStore.isSecretStoreError, () =>
      jsonNoStore({ error: "internal_error" }, 500),
    ),
  ),
);

const verifyRouteLayer = HttpRouter.add(
  "POST",
  "/auth/key-verify",
  Effect.gen(function* () {
    const keyPairing = yield* KeyPairing;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const payload = yield* request.json.pipe(
      Effect.flatMap(decodeVerifyRequest),
      Effect.mapError(() => new KeyPairingError({ reason: "invalid_request" })),
    );
    return yield* keyPairing.verify(request, payload).pipe(
      Effect.flatMap((issued) =>
        jsonNoStore(
          {
            sessionId: issued.sessionId,
            token: issued.token,
            expiresAt: DateTime.formatIso(issued.expiresAt),
            ...(Option.isSome(keyPairing.e2eeFingerprint)
              ? { e2eeFingerprint: keyPairing.e2eeFingerprint.value }
              : {}),
          },
          200,
        ),
      ),
      Effect.catchTags({
        KeyPairingError: (error: KeyPairingError) =>
          jsonNoStore({ error: error.reason }, error.reason === "invalid_request" ? 400 : 401),
        ServerAuthInvalidCredentialError: () => jsonNoStore({ error: "invalid_credential" }, 401),
      }),
      Effect.catchIf(
        (error) =>
          EnvironmentAuth.isServerAuthInternalError(error) ||
          ServerSecretStore.isSecretStoreError(error),
        () => jsonNoStore({ error: "internal_error" }, 500),
      ),
    );
  }),
);

export const layer = Layer.effect(KeyPairing, make);

export const routeLayer = Layer.mergeAll(challengeRouteLayer, verifyRouteLayer);
