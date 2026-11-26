// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import type { E2eeHello } from "@s8code/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isSecretAlreadyExistsError } from "../auth/ServerSecretStore.ts";
import { loadOrCreateServerIdentity, type ServerIdentityKeys } from "./keys.ts";
import {
  E2eeHandshakeError,
  handshakeReplayMarkerName,
  serverAccept,
  type ServerHandshakeResult,
} from "./handshake.ts";

export interface ServerE2eeService {
  /** None when this server has no E2EE identity, so clients skip the handshake. */
  readonly fingerprint: Effect.Effect<Option.Option<string>>;
  readonly acceptHello: (
    hello: E2eeHello,
  ) => Effect.Effect<ServerHandshakeResult, E2eeHandshakeError>;
}

export class ServerE2ee extends Context.Reference<ServerE2eeService>("t3/e2ee/ServerE2ee", {
  defaultValue: () => ({
    fingerprint: Effect.succeedNone,
    acceptHello: () => Effect.die(new Error("Server E2EE is unavailable")),
  }),
}) {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity: ServerIdentityKeys = yield* loadOrCreateServerIdentity(secrets);
  return ServerE2ee.of({
    fingerprint: Effect.succeedSome(identity.fingerprint),
    acceptHello: Effect.fn("ServerE2ee.acceptHello")(function* (hello: E2eeHello) {
      yield* secrets
        .create(
          handshakeReplayMarkerName(Buffer.from(hello.ce, "base64url")),
          new TextEncoder().encode(`issuedAt=${DateTime.formatIso(yield* DateTime.now)}`),
        )
        .pipe(
          Effect.catchIf(isSecretAlreadyExistsError, () =>
            Effect.die(new Error("E2EE hello was replayed")),
          ),
          Effect.orDie,
        );
      return yield* Effect.try({
        try: () => serverAccept(identity, hello),
        catch: () => new E2eeHandshakeError({ detail: "handshake failed" }),
      });
    }),
  });
});

export const layer = Layer.effect(ServerE2ee, make).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
);
