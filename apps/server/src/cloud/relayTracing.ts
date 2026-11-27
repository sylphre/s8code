import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@s8code/shared/observability";
import * as RelayTracing from "@s8code/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig = relayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const policy = yield* ManagedPolicy.ManagedPolicy;
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? tracingConfig : null,
        // Never the operator's own `service.instance.id`: it names their machine for their receiver.
        { ...resource, serviceInstanceId: processServiceInstanceId() },
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
