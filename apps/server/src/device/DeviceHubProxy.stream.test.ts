import { expect, it } from "@effect/vitest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeNet from "node:net";
// The client stand-in runs the handshake and frames on node:crypto.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
} from "@s8code/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerE2ee from "../e2ee/layer.ts";
import { aeadDecrypt } from "../e2ee/aead.ts";
import { decodeE2eeFrame } from "@s8code/contracts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

it.effect("preserves binary input and admission frames through the real socket proxy", () =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of server.clients) client.terminate();
              server.close(() => resolve());
            }),
        ),
    );
    if (!hub.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    const upstreamClosed = Promise.withResolvers<void>();
    hub.on("connection", (socket) => {
      socket.once("close", upstreamClosed.resolve);
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const invalidated = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: () => Deferred.await(invalidated),
          }),
        ),
        Layer.provide(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationOperateScope],
              }),
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Layer.provide(
          Layer.succeed(DeviceService.DeviceService, {
            currentReadiness: () =>
              Effect.succeed({
                hostId: LOCAL_DEVICE_HOST_ID,
                hub: { origin: `http://127.0.0.1:${address.port}` },
              }),
          } as DeviceService.DeviceService["Service"]),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const frames: number[][] = [];
    const received = Promise.withResolvers<void>();
    client.addEventListener("error", () => received.reject(new Error("Proxy failed")));
    client.addEventListener("message", ({ data }) => {
      frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
      if (frames.length === 1) {
        client.send(Uint8Array.of(0x03, 1));
        client.send(Uint8Array.of(0x03, 2));
      } else if (frames.length === 3) received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    expect(frames).toEqual([[0x83], [0x03, 1], [0x03, 2]]);

    const closed = new Promise<void>((resolve) =>
      client.addEventListener("close", () => resolve(), { once: true }),
    );
    yield* Deferred.succeed(invalidated, undefined);
    yield* Effect.promise(() => Promise.all([closed, upstreamClosed.promise]));
  }),
);

// The client stand-in drives the node:crypto handshake and AES frames itself.
const e2eeEncrypt = (key: Buffer, counter: number, plaintext: Uint8Array): Buffer => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(counterBytes);
  return Buffer.concat([
    counterBytes,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
};

it.effect("the E2EE device socket round-trips binary frames with no plaintext on the wire", () =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of server.clients) client.terminate();
              server.close(() => resolve());
            }),
        ),
    );
    if (!hub.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    // The upstream hub echoes one frame back, so both directions carry the probe.
    const upstreamSaw: Buffer[] = [];
    hub.on("connection", (socket) => {
      socket.on("message", (data) => {
        upstreamSaw.push(Buffer.from(data as Uint8Array));
        socket.send(data, { binary: true });
      });
    });
    const invalidated = yield* Deferred.make<void>();
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: () => Deferred.await(invalidated),
          }),
        ),
        Layer.provide(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationOperateScope],
              }),
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Layer.provide(
          Layer.succeed(DeviceService.DeviceService, {
            currentReadiness: () =>
              Effect.succeed({
                hostId: LOCAL_DEVICE_HOST_ID,
                hub: { origin: `http://127.0.0.1:${address.port}` },
              }),
          } as DeviceService.DeviceService["Service"]),
        ),
        Layer.provide(ServerE2ee.layer),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-hub-e2ee-test-" }),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test&e2ee=1`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const wireFrames: Uint8Array[] = [];
    const accepted = Promise.withResolvers<string>();
    const roundTripped = Promise.withResolvers<void>();
    client.addEventListener("message", ({ data }) => {
      if (typeof data === "string") {
        accepted.resolve(data);
        return;
      }
      wireFrames.push(new Uint8Array(data));
      roundTripped.resolve();
    });
    client.addEventListener("error", () => accepted.reject(new Error("socket error")));
    const hello = NodeCrypto.generateKeyPairSync("x25519");
    const helloHeadline = JSON.stringify({
      t: "hello",
      v: 1,
      ce: Buffer.from(
        (hello.publicKey.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!,
        "base64url",
      ).toString("base64url"),
    });
    client.addEventListener("open", () => client.send(helloHeadline), { once: true });
    const accept = JSON.parse(yield* Effect.promise(() => accepted.promise)) as {
      se: string;
      ct: string;
    };
    // Derive the session keys the way the client protocol does, from the accept.
    const dh1 = NodeCrypto.diffieHellman({
      privateKey: hello.privateKey,
      publicKey: NodeCrypto.createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: accept.se },
        format: "jwk",
      }),
    });
    const handshakeKey = Buffer.from(
      NodeCrypto.hkdfSync("sha256", dh1, Buffer.alloc(0), Buffer.from("s8-e2ee-1 hs"), 32),
    );
    const counter0 = Buffer.alloc(8);
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      handshakeKey,
      Buffer.concat([Buffer.alloc(4), counter0]),
    );
    decipher.setAAD(counter0);
    decipher.setAuthTag(Buffer.from(Buffer.from(accept.ct, "base64url").subarray(-16)));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(accept.ct, "base64url").subarray(0, -16)),
        decipher.final(),
      ]).toString("utf8"),
    ) as { sp: string };
    const dh2 = NodeCrypto.diffieHellman({
      privateKey: hello.privateKey,
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
    const sendKey = material.subarray(32);
    const receiveKey = material.subarray(0, 32);

    const probe = Buffer.from([0x03, 0x01, 0x7f, 0xaa, 0x55]);
    client.send(e2eeEncrypt(sendKey, 0, probe));
    yield* Effect.promise(() => roundTripped.promise);

    // The upstream only ever saw the decrypted probe, and the client's inbound
    // frame is an AEAD envelope, never the probe's plaintext bytes.
    expect(upstreamSaw).toHaveLength(1);
    expect(Array.from(upstreamSaw[0]!)).toEqual([...probe]);
    const frame = wireFrames[wireFrames.length - 1]!;
    expect(Array.from(frame)).not.toContain(0xaa);
    const { counter, ciphertext } = decodeE2eeFrame(frame);
    expect(counter).toBe(0);
    expect(Array.from(aeadDecrypt(receiveKey, counter, ciphertext))).toEqual([...probe]);
  }),
);

it.live("closes an upstream socket that is still connecting without an unhandled error", () =>
  Effect.gen(function* () {
    const dialed = Promise.withResolvers<NodeNet.Socket>();
    // Accepts the connection and never answers the WebSocket handshake.
    const hub = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer((socket) => dialed.resolve(socket));
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    // Handshake headers, as Simlock's routes send, select the `ws` package over the global WebSocket.
    const upstream = yield* Socket.makeWebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: { authorization: "Bearer test" },
    }).pipe(Effect.provide(DeviceHubProxy.upstreamWebSocketConstructor));
    const reading = yield* Effect.forkChild(
      Effect.scoped(Effect.flatMap(upstream.reader, ({ pull }) => pull)),
    );
    const connection = yield* Effect.promise(() => dialed.promise);
    const abandoned = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    connection.resume();
    yield* Fiber.interrupt(reading);
    yield* Effect.promise(() => abandoned);
  }),
);
