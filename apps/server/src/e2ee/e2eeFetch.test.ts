// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

// @effect-diagnostics nodeBuiltinImport:off - The client stand-in needs node:crypto.
// @effect-diagnostics globalJsonInEffect:off - The envelope rides JSON-RPC bodies.
import * as NodeCrypto from "node:crypto";

import {
  E2EE_HTTP_ACCEPT_HEADER,
  E2EE_HTTP_HELLO_HEADER,
  E2EE_HTTP_KEY_ID_HEADER,
  type E2eeAccept,
} from "@s8code/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { aeadDecrypt, aeadEncrypt } from "./aead.ts";
import { makeE2eeFetch } from "./e2eeFetch.ts";

const TRANSCRIPT_LABEL = "s8-e2ee-1";
const HANDSHAKE_INFO = "s8-e2ee-1 hs";
const KEYS_INFO = "s8-e2ee-1 k";

const rawPublic = (keyObject: NodeCrypto.KeyObject): Buffer =>
  Buffer.from((keyObject.export({ format: "jwk" }) as NodeCrypto.JsonWebKey).x!, "base64url");

const x25519Peer = (privateKey: NodeCrypto.KeyObject, peerPublic: Uint8Array): Buffer =>
  Buffer.from(
    NodeCrypto.diffieHellman({
      privateKey,
      publicKey: NodeCrypto.createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: Buffer.from(peerPublic).toString("base64url") },
        format: "jwk",
      }),
    }),
  );

const hkdf = (ikm: Buffer, info: string, length: number): Buffer =>
  Buffer.from(
    NodeCrypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), length),
  );

/**
 * A genuine E2EE server stand-in on node:crypto: its own identity signs the
 * accept, and both sides derive the same session keys from the handshake.
 */
const makeServer = () => {
  const identity = NodeCrypto.generateKeyPairSync("ed25519");
  const identityPublic = rawPublic(identity.publicKey);
  const staticKeys = NodeCrypto.generateKeyPairSync("x25519");
  const staticPublic = rawPublic(staticKeys.publicKey);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(Buffer.concat([identityPublic, staticPublic]))
    .digest("base64url");
  const requests: Array<{ readonly headers: Record<string, string>; readonly body: string }> = [];
  let sendCounter = 0;
  let receiveCounter = 0;
  let keys: { readonly send: Buffer; readonly receive: Buffer } | undefined;
  const fetch = async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
    void url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = String(init?.body ?? "");
    requests.push({ headers, body });
    const helloHeader = headers[E2EE_HTTP_HELLO_HEADER];
    if (helloHeader !== undefined) {
      const clientEphemeral = Buffer.from(
        (JSON.parse(helloHeader) as { ce: string }).ce,
        "base64url",
      );
      const serverEphemeral = NodeCrypto.generateKeyPairSync("x25519");
      const serverEphemeralPublic = rawPublic(serverEphemeral.publicKey);
      const dh1 = x25519Peer(serverEphemeral.privateKey, clientEphemeral);
      const dh2 = x25519Peer(staticKeys.privateKey, clientEphemeral);
      const material = hkdf(Buffer.concat([dh1, dh2]), KEYS_INFO, 64);
      // The server sends under the first half and receives under the second.
      keys = { send: material.subarray(0, 32), receive: material.subarray(32) };
      const transcript = Buffer.concat([
        Buffer.from(TRANSCRIPT_LABEL, "utf8"),
        clientEphemeral,
        serverEphemeralPublic,
        staticPublic,
      ]);
      const accept: E2eeAccept = {
        t: "accept",
        v: 1,
        se: serverEphemeralPublic.toString("base64url"),
        ct: aeadEncrypt(
          hkdf(dh1, HANDSHAKE_INFO, 32),
          0,
          new TextEncoder().encode(
            JSON.stringify({
              sp: staticPublic.toString("base64url"),
              ep: identityPublic.toString("base64url"),
              sig: NodeCrypto.sign(null, transcript, identity.privateKey).toString("base64url"),
            }),
          ),
        ).toString("base64url"),
      };
      return new Response(null, {
        status: 204,
        headers: {
          [E2EE_HTTP_ACCEPT_HEADER]: JSON.stringify(accept),
          [E2EE_HTTP_KEY_ID_HEADER]: "key-1",
        },
      });
    }
    const envelope = JSON.parse(body) as { t: string; c: number; ct: string };
    expect(envelope.t).toBe("e2ee");
    expect(envelope.c).toBe(receiveCounter);
    receiveCounter += 1;
    const message = JSON.parse(
      aeadDecrypt(keys!.receive, envelope.c, Buffer.from(envelope.ct, "base64url")).toString(
        "utf8",
      ),
    ) as { id?: number; method?: string };
    // A tool call answers the way the middleware would: one envelope whose
    // message carries the whole SSE response, notification first.
    const reply =
      message.method === "tools/call"
        ? [
            { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t" } },
            { jsonrpc: "2.0", id: message.id, result: { ok: true } },
          ]
        : { answered: message };
    const frame = { t: "plain", message: reply };
    const response = {
      t: "e2ee",
      v: 1,
      c: sendCounter,
      ct: aeadEncrypt(
        keys!.send,
        sendCounter,
        new TextEncoder().encode(JSON.stringify(frame)),
      ).toString("base64url"),
    };
    sendCounter += 1;
    return Response.json(response);
  };
  return { fetch: fetch as typeof fetch, requests, fingerprint };
};

/** Mocks the host fetch for one test, restored when the test's scope closes. */
const mockFetch = (
  implementation: (url: string | Request | URL, init?: RequestInit) => Promise<Response>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(implementation);
      return mocked;
    }),
    (mocked) =>
      Effect.sync(() => {
        mocked.mockRestore();
      }),
  );

describe("makeE2eeFetch", () => {
  it.effect("stays plaintext when the server answers the hello without an accept header", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly headers: Record<string, string>; readonly body: string }> =
        [];
      yield* mockFetch(async (url, init) => {
        void url;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, name) => {
          headers[name] = value;
        });
        requests.push({ headers, body: String(init?.body ?? "") });
        if (headers[E2EE_HTTP_HELLO_HEADER] !== undefined)
          return new Response(null, { status: 204 });
        return Response.json({ answered: JSON.parse(String(init?.body ?? "{}")) });
      });
      const e2ee = makeE2eeFetch({ endpoint: "http://127.0.0.1:1/mcp", headers: () => ({}) });
      const result = yield* e2ee.post({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(result.status).toBe(200);
      expect((result.message as { answered: unknown }).answered).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      // The hello ran once, and the message went out as JSON-RPC, not an envelope.
      expect(requests).toHaveLength(2);
      expect(requests[0]!.headers[E2EE_HTTP_HELLO_HEADER]).toBeTruthy();
      expect(requests[1]!.body).toContain('"jsonrpc"');
      expect(requests[1]!.headers[E2EE_HTTP_KEY_ID_HEADER]).toBeUndefined();
    }),
  );

  it.effect("envelopes every message once the server accepts the handshake", () =>
    Effect.gen(function* () {
      const server = makeServer();
      yield* mockFetch(server.fetch);
      const e2ee = makeE2eeFetch({
        endpoint: "http://127.0.0.1:1/mcp",
        headers: () => ({ authorization: "Bearer t" }),
        pinnedFingerprint: server.fingerprint,
      });
      const first = yield* e2ee.post({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(first.status).toBe(200);
      expect((first.message as { answered: { method: string } }).answered.method).toBe(
        "initialize",
      );
      const second = yield* e2ee.post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect((second.message as { answered: { method: string } }).answered.method).toBe(
        "tools/list",
      );
      // Every POST after the hello is an envelope under the server's key id.
      const posts = server.requests.slice(1);
      expect(posts).toHaveLength(2);
      for (const post of posts) {
        expect(post.headers[E2EE_HTTP_KEY_ID_HEADER]).toBe("key-1");
        expect(JSON.parse(post.body).t).toBe("e2ee");
        expect(post.body).not.toContain('"jsonrpc"');
        expect(post.headers.authorization).toBe("Bearer t");
      }
    }),
  );

  it.effect("hands an SSE tool response back as ordered messages", () =>
    Effect.gen(function* () {
      const server = makeServer();
      yield* mockFetch(server.fetch);
      const e2ee = makeE2eeFetch({
        endpoint: "http://127.0.0.1:1/mcp",
        headers: () => ({}),
        pinnedFingerprint: server.fingerprint,
      });
      yield* e2ee.post({ jsonrpc: "2.0", id: 1, method: "initialize" });
      const called = yield* e2ee.post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "emit_progress", arguments: {} },
      });
      // The SSE body rides one envelope; the notification stays ahead of the result.
      expect(Array.isArray(called.message)).toBe(true);
      expect(
        (called.message as ReadonlyArray<{ method?: string; id?: number }>).map(
          (message) => message.method ?? message.id,
        ),
      ).toEqual(["notifications/progress", 2]);
    }),
  );

  it.effect("refuses a server whose fingerprint misses the pin", () =>
    Effect.gen(function* () {
      const server = makeServer();
      yield* mockFetch(server.fetch);
      const e2ee = makeE2eeFetch({
        endpoint: "http://127.0.0.1:1/mcp",
        headers: () => ({}),
        pinnedFingerprint: "not-the-server",
      });
      const failure = yield* Effect.flip(
        e2ee.post({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      );
      expect(failure.message).toContain("fingerprint");
    }),
  );
});
