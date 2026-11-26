// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - The client stand-in needs node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  E2EE_HTTP_ACCEPT_HEADER,
  E2EE_HTTP_HELLO_HEADER,
  E2EE_HTTP_KEY_ID_HEADER,
  EnvironmentId,
  type E2eeAccept,
  ProviderInstanceId,
  ThreadId,
} from "@s8code/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerE2ee from "../e2ee/layer.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const token = "providerTokenWithoutDots";
const environmentId = EnvironmentId.make("environment-mcp-e2ee-test");
const threadId = ThreadId.make("thread-mcp-e2ee-test");

const layerServer = McpHttpServer.layerMcpTransport(Layer.empty).pipe(
  Layer.provide(ServerE2ee.layer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (presented) =>
        Effect.succeed(
          presented === token
            ? ({
                environmentId,
                requestNamespace: "provider-session",
                thread: {
                  threadId,
                  providerSessionId: "provider-session",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration"]),
                issuedAt: 1,
              } as never)
            : undefined,
        ),
    }),
  ),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-e2ee-test-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
);

// The client side of the header handshake, on node:crypto.
const acceptClientSide = (accept: E2eeAccept, client: NodeCrypto.KeyPairKeyObjectResult) => {
  const dh1 = NodeCrypto.diffieHellman({
    privateKey: client.privateKey,
    publicKey: NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: accept.se },
      format: "jwk",
    }),
  });
  const handshakeKey = Buffer.from(
    NodeCrypto.hkdfSync("sha256", dh1, Buffer.alloc(0), Buffer.from("s8-e2ee-1 hs"), 32),
  );
  const counter = Buffer.alloc(8);
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    handshakeKey,
    Buffer.concat([Buffer.alloc(4), counter]),
  );
  decipher.setAAD(counter);
  decipher.setAuthTag(Buffer.from(Buffer.from(accept.ct, "base64url").subarray(-16)));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(accept.ct, "base64url").subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  ) as { sp: string; ep: string; sig: string };
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
    // Client send key first, client receive key second.
    keys: { send: material.subarray(32), receive: material.subarray(0, 32) },
  };
};

const envelopeOf = (
  key: Buffer,
  counter: number,
  message: unknown,
): { t: "e2ee"; v: 1; c: number; ct: string } => {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    key,
    Buffer.concat([Buffer.alloc(4), counterBytes]),
  );
  cipher.setAAD(counterBytes);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(message))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { t: "e2ee", v: 1, c: counter, ct: ct.toString("base64url") };
};

const openE2eeSession = (
  httpClient: HttpClient.HttpClient,
  client: NodeCrypto.KeyPairKeyObjectResult,
) =>
  Effect.gen(function* () {
    const hello = {
      t: "hello",
      v: 1,
      ce: Buffer.from(
        (client.publicKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
        "base64url",
      ).toString("base64url"),
    };
    const helloResponse = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        [E2EE_HTTP_HELLO_HEADER]: JSON.stringify(hello),
      },
      body: HttpBody.text("", "application/json"),
    });
    expect(helloResponse.status).toBe(204);
    const accept = JSON.parse(helloResponse.headers[E2EE_HTTP_ACCEPT_HEADER]!) as E2eeAccept;
    const keyId = helloResponse.headers[E2EE_HTTP_KEY_ID_HEADER]!;
    expect(keyId).toBeTruthy();
    return { ...acceptClientSide(accept, client), keyId };
  });

const decryptEnvelope = (key: Buffer, counter: number, ct: string): unknown => {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.concat([Buffer.alloc(4), counterBytes]),
  );
  decipher.setAAD(counterBytes);
  decipher.setAuthTag(Buffer.from(Buffer.from(ct, "base64url").subarray(-16)));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url").subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
};

const postEnvelope = (
  httpClient: HttpClient.HttpClient,
  keyId: string,
  key: Buffer,
  counter: number,
  message: unknown,
) =>
  httpClient.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      [E2EE_HTTP_KEY_ID_HEADER]: keyId,
    },
    body: HttpBody.text(JSON.stringify(envelopeOf(key, counter, message)), "application/json"),
  });

it.effect("derives the same session keys on both sides of the header handshake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );
      const client = NodeCrypto.generateKeyPairSync("x25519");
      const { keys, keyId } = yield* openE2eeSession(httpClient, client);
      expect(keyId).not.toBe("");
      // The server's send key is the client's receive key, and vice versa.
      expect(keys.receive.toString("base64url")).not.toBe("");
      const envelope = envelopeOf(keys.send, 0, { jsonrpc: "2.0", ping: true });
      // The server decrypts with the matching receive key; a wrong one fails.
      expect(() => decryptEnvelope(keys.receive, 0, envelope.ct)).toThrow();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("runs initialize and tools/list through the E2EE envelopes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = NodeCrypto.generateKeyPairSync("x25519");
      const { keys, keyId } = yield* openE2eeSession(
        (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
        ),
        client,
      );
      const httpClient = yield* HttpClient.HttpClient;

      const initialize = yield* postEnvelope(httpClient, keyId, keys.send, 0, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-e2ee-test", version: "1.0.0" },
        },
      });
      expect(initialize.status).toBe(200);
      const rawInitialize = yield* initialize.text;
      expect(rawInitialize).not.toContain('"jsonrpc"');
      const envelope = JSON.parse(rawInitialize) as { t: string; c: number; ct: string };
      expect(envelope.t).toBe("e2ee");
      const initialized = decryptEnvelope(keys.receive, envelope.c, envelope.ct) as {
        result?: { protocolVersion: string };
        error?: unknown;
      };
      expect(initialized.error).toBeUndefined();
      expect(JSON.stringify(initialized)).toContain("2025-06-18");
      const sessionId = initialize.headers["mcp-session-id"];
      expect(sessionId).not.toBeNull();

      const sessionClient = HttpClient.mapRequest(
        HttpClientRequest.setHeader("mcp-session-id", sessionId!),
      )(httpClient);
      const listed = yield* postEnvelope(sessionClient, keyId, keys.send, 1, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(listed.status).toBe(200);
      const rawListed = yield* listed.text;
      expect(rawListed).not.toContain('"jsonrpc"');
      const listedEnvelope = JSON.parse(rawListed) as {
        t: string;
        c: number;
        ct: string;
      };
      expect(listedEnvelope.t).toBe("e2ee");
      const tools = decryptEnvelope(keys.receive, listedEnvelope.c, listedEnvelope.ct);
      expect(JSON.stringify(tools)).toContain('"tools"');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps the plaintext path on initialize and tools/list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );
      const initialize = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-plain-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers["mcp-session-id"];
      expect(sessionId).not.toBeNull();
      const initialized = (yield* initialize.json) as { result: { protocolVersion: string } };
      expect(initialized.result.protocolVersion).toBe("2025-06-18");

      const listed = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      expect(listed.status).toBe(200);
      const tools = (yield* listed.json) as { result: { tools: ReadonlyArray<unknown> } };
      expect(Array.isArray(tools.result.tools)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("rejects replays, skipped counters, and plaintext inside an E2EE session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const bare = yield* HttpClient.HttpClient;
      const httpClient = HttpClient.mapRequest(HttpClientRequest.bearerToken(token))(bare);
      const client = NodeCrypto.generateKeyPairSync("x25519");
      const { keys, keyId } = yield* openE2eeSession(httpClient, client);

      // A plaintext body inside a keyed session answers the refusal, in the clear.
      const plaintext = yield* bare.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          [E2EE_HTTP_KEY_ID_HEADER]: keyId,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":9,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(plaintext.status).toBe(400);
      expect(yield* plaintext.text).toContain("plaintext_in_e2ee_session");

      // A skipped counter never decrypts.
      const skipped = yield* postEnvelope(httpClient, keyId, keys.send, 7, {
        jsonrpc: "2.0",
        id: 10,
        method: "ping",
        params: {},
      });
      expect(skipped.status).toBe(400);
      expect(yield* skipped.text).toContain("bad_e2ee_frame");

      // A garbled ciphertext never decrypts either.
      const garbled = yield* bare.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          [E2EE_HTTP_KEY_ID_HEADER]: keyId,
        },
        body: HttpBody.text(
          JSON.stringify({ t: "e2ee", v: 1, c: 0, ct: "AAAA" }),
          "application/json",
        ),
      });
      expect(garbled.status).toBe(400);
      expect(yield* garbled.text).toContain("bad_e2ee_frame");

      // A hello replay dies on the same marker the WS handshake uses.
      const hello = {
        t: "hello",
        v: 1,
        ce: Buffer.from(
          (client.publicKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
          "base64url",
        ).toString("base64url"),
      };
      const replay = yield* bare.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          [E2EE_HTTP_HELLO_HEADER]: JSON.stringify(hello),
        },
        body: HttpBody.text("", "application/json"),
      });
      expect(replay.status).toBe(500);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const progressToolkit = Toolkit.make(
  Tool.make("emit_progress", {
    description: "Emits one progress notification, then answers.",
    success: Schema.Struct({ ok: Schema.Boolean }),
    dependencies: [McpServer.McpServer],
  }),
);

const layerProgressTool = McpHttpServer.toolkitRegistration(
  progressToolkit,
  McpToolAccess.toLayer(progressToolkit, {
    emit_progress: McpToolAccess.reads(() =>
      Effect.flatMap(McpServer.McpServer, (server) =>
        Effect.as(
          server.notifications["notifications/progress"]({
            progressToken: "e2ee-token",
            progress: 1,
          }),
          { ok: true },
        ),
      ),
    ),
  }),
);

it.effect("carries an SSE tool response as one envelope of ordered messages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(layerProgressTool).pipe(
          Layer.provide(ServerE2ee.layer),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (presented) =>
                Effect.succeed(
                  presented === token
                    ? ({
                        environmentId,
                        requestNamespace: "provider-session",
                        thread: {
                          threadId,
                          providerSessionId: "provider-session",
                          providerInstanceId: ProviderInstanceId.make("codex"),
                        },
                        client: undefined,
                        capabilities: new Set(["orchestration"]),
                        issuedAt: 1,
                      } as never)
                    : undefined,
                ),
            }),
          ),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-e2ee-sse-test-" })),
          Layer.provide(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const bare = yield* HttpClient.HttpClient;
      const httpClient = HttpClient.mapRequest(HttpClientRequest.bearerToken(token))(bare);
      const client = NodeCrypto.generateKeyPairSync("x25519");
      const { keys, keyId } = yield* openE2eeSession(httpClient, client);

      const initialize = yield* postEnvelope(httpClient, keyId, keys.send, 0, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-e2ee-sse-test", version: "1.0.0" },
        },
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers["mcp-session-id"];
      expect(sessionId).not.toBeNull();

      const called = yield* postEnvelope(
        HttpClient.mapRequest(HttpClientRequest.setHeader("mcp-session-id", sessionId!))(
          httpClient,
        ),
        keyId,
        keys.send,
        1,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "emit_progress",
            arguments: {},
            _meta: { progressToken: "e2ee-token" },
          },
        },
      );
      expect(called.status).toBe(200);
      const rawCalled = yield* called.text;
      expect(called.headers["content-type"]).toContain("application/json");
      expect(rawCalled).not.toContain('"jsonrpc"');
      const calledEnvelope = JSON.parse(rawCalled) as { t: string; c: number; ct: string };
      expect(calledEnvelope.t).toBe("e2ee");
      const playback = decryptEnvelope(keys.receive, calledEnvelope.c, calledEnvelope.ct) as {
        t: string;
        message: ReadonlyArray<{ method?: string; id?: number }>;
      };
      expect(playback.t).toBe("plain");
      // The progress notification rides ahead of the tool result, in order.
      expect(playback.message.map((message) => message.method ?? message.id)).toEqual([
        "notifications/progress",
        2,
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
