// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

// @effect-diagnostics nodeBuiltinImport:off - direct key generation and temp-dir bookkeeping.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { keyChallengePayload } from "./KeyPairing.ts";
import * as KeyPairing from "./KeyPairing.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const VERIFY_PATH = "/auth/key-verify";
const VERIFY_ORIGIN = "http://localhost";

const layerEnvironmentAuth = (baseDir: string) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const layerKeyPairing = (baseDir: string) =>
  KeyPairing.layer.pipe(Layer.provideMerge(layerEnvironmentAuth(baseDir)));

/** Writes the allowlist before the server layers build, since `Effect.provide` builds first. */
const withAllowlist = <A, E, R>(
  entries: readonly {
    readonly label: string;
    /** Written as-is instead of a fresh key, for entries the lookup must reject. */
    readonly malformed?: string;
  }[],
  use: (
    baseDir: string,
    keys: ReadonlyMap<
      string,
      { readonly privateKey: NodeCrypto.KeyObject; readonly publicKey: string }
    >,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join("/tmp", "t3-key-pairing-")),
      );
      const keys = new Map<
        string,
        { readonly privateKey: NodeCrypto.KeyObject; readonly publicKey: string }
      >();
      const listed = entries.map((entry) => {
        if (entry.malformed !== undefined)
          return { label: entry.label, publicKey: entry.malformed };
        const { privateKey, publicKey } = generateKeyPair();
        keys.set(entry.label, { privateKey, publicKey });
        return { label: entry.label, publicKey };
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(baseDir, "userdata", "mcp-allowlist.json"),
          JSON.stringify(listed),
        );
      });
      return { baseDir, keys };
    }),
    ({ baseDir, keys }) => use(baseDir, keys),
    ({ baseDir }) => Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })),
  );

const generateKeyPair = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    privateKey,
    publicKey: Buffer.from(rawPublic).toString("base64url"),
  };
};

const signChallenge = (privateKey: NodeCrypto.KeyObject, nonce: string): string =>
  NodeCrypto.sign(
    null,
    Buffer.from(
      keyChallengePayload({
        nonce,
        origin: VERIFY_ORIGIN,
        method: "POST",
        path: VERIFY_PATH,
      }),
      "utf8",
    ),
    privateKey,
  ).toString("base64url");

const makeVerifyRequest = (): HttpServerRequest.HttpServerRequest =>
  ({
    url: VERIFY_PATH,
    originalUrl: VERIFY_PATH,
    method: "POST",
    headers: {},
    source: undefined,
  }) as unknown as HttpServerRequest.HttpServerRequest;

const bearerRequest = (token: string): HttpServerRequest.HttpServerRequest =>
  ({
    cookies: {},
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const isKeyPairingError = Schema.is(KeyPairing.KeyPairingError);

const errorReason = (error: unknown): string =>
  isKeyPairingError(error) ? error.reason : String(error);

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))("KeyPairing.layer", (it) => {
  it.effect("pairs an allowlisted key into an MCP client session", () =>
    withAllowlist([{ label: "Muse laptop" }], (baseDir, keys) =>
      Effect.gen(function* () {
        const { publicKey } = keys.get("Muse laptop")!;
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        const issued = yield* keyPairing.verify(makeVerifyRequest(), {
          publicKey,
          nonce: challenge.nonce,
          signature: signChallenge(keys.get("Muse laptop")!.privateKey, challenge.nonce),
          label: "Muse laptop",
        });

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const client = yield* serverAuth.authenticateMcpClient(bearerRequest(issued.token));
        expect(client.access).toBe("approval-required");
        expect(client.label).toBe("Muse laptop");

        const listed = yield* serverAuth.listSessions();
        expect(listed.find((entry) => entry.sessionId === issued.sessionId)?.subject).toBe(
          EnvironmentAuth.KEY_PAIRED_SUBJECT,
        );
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );

  it.effect("refuses a challenge twice", () =>
    withAllowlist([{ label: "Muse laptop" }], (baseDir, keys) =>
      Effect.gen(function* () {
        const { publicKey } = keys.get("Muse laptop")!;
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        const payload = {
          publicKey,
          nonce: challenge.nonce,
          signature: signChallenge(keys.get("Muse laptop")!.privateKey, challenge.nonce),
        };
        expect((yield* keyPairing.verify(makeVerifyRequest(), payload)).token).toBeTruthy();
        expect(
          yield* keyPairing.verify(makeVerifyRequest(), payload).pipe(Effect.flip),
        ).toMatchObject({ reason: "unknown_challenge" });
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );

  it.effect("refuses a key outside the allowlist", () =>
    withAllowlist([{ label: "Muse laptop" }], (baseDir) =>
      Effect.gen(function* () {
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        const { privateKey, publicKey } = generateKeyPair();
        const error = yield* keyPairing
          .verify(makeVerifyRequest(), {
            publicKey,
            nonce: challenge.nonce,
            signature: signChallenge(privateKey, challenge.nonce),
          })
          .pipe(Effect.flip);
        expect(errorReason(error)).toBe("unknown_key");
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );

  it.effect("refuses a signature that does not match the challenge payload", () =>
    withAllowlist([{ label: "Muse laptop" }], (baseDir, keys) =>
      Effect.gen(function* () {
        const { publicKey } = keys.get("Muse laptop")!;
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        const tampered = NodeCrypto.sign(
          null,
          Buffer.from(`${challenge.nonce}\n${VERIFY_ORIGIN}\nPOST\n/other`, "utf8"),
          keys.get("Muse laptop")!.privateKey,
        ).toString("base64url");
        const error = yield* keyPairing
          .verify(makeVerifyRequest(), { publicKey, nonce: challenge.nonce, signature: tampered })
          .pipe(Effect.flip);
        expect(errorReason(error)).toBe("invalid_signature");
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );

  it.effect("refuses an expired challenge", () =>
    withAllowlist([{ label: "Muse laptop" }], (baseDir, keys) =>
      Effect.gen(function* () {
        const { publicKey } = keys.get("Muse laptop")!;
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        yield* TestClock.adjust("6 minutes");
        const error = yield* keyPairing
          .verify(makeVerifyRequest(), {
            publicKey,
            nonce: challenge.nonce,
            signature: signChallenge(keys.get("Muse laptop")!.privateKey, challenge.nonce),
          })
          .pipe(Effect.flip);
        expect(errorReason(error)).toBe("challenge_expired");
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );

  it.effect("drops malformed allowlist entries and keeps the rest", () =>
    withAllowlist([{ label: "broken", malformed: "not-base64url!!" }], (baseDir) =>
      Effect.gen(function* () {
        const keyPairing = yield* KeyPairing.KeyPairing;
        const challenge = yield* keyPairing.issueChallenge();
        const { privateKey, publicKey } = generateKeyPair();
        const error = yield* keyPairing
          .verify(makeVerifyRequest(), {
            publicKey,
            nonce: challenge.nonce,
            signature: signChallenge(privateKey, challenge.nonce),
          })
          .pipe(Effect.flip);
        expect(errorReason(error)).toBe("unknown_key");
      }).pipe(Effect.provide(layerKeyPairing(baseDir))),
    ),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "key-paired sessions outside KeyPairing",
  (it) => {
    it.effect("keeps a key-paired session off the HTTP API audience", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueMcpClientSession({
          subject: EnvironmentAuth.KEY_PAIRED_SUBJECT,
          label: "Key-paired client",
          access: "approval-required",
          peerLink: false,
          client: { deviceType: "bot" },
        });

        const client = yield* serverAuth.authenticateMcpClient(bearerRequest(issued.token));
        expect(client.access).toBe("approval-required");

        const rejected = yield* serverAuth
          .authenticateHttpRequest(bearerRequest(issued.token))
          .pipe(Effect.flip);
        expect(rejected._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerEnvironmentAuth("/tmp/t3-key-pairing-audience"))),
    );
  },
);
