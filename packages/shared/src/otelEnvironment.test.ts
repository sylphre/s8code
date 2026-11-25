import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OtlpResource from "effect/observability/OtlpResource";

import * as OtelEnvironment from "./otelEnvironment.ts";

const load = (env: Record<string, string>) =>
  OtelEnvironment.load.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const SPEC_OFF =
  "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway";
const T3_OFF =
  "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it";
const specIgnored = (value: string) =>
  `OTEL_SDK_DISABLED=${value} was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way`;

describe("OtelEnvironment", () => {
  it.effect.each([
    { name: "nothing set", env: {}, disabled: false, warnings: [] },
    { name: "spec true", env: { OTEL_SDK_DISABLED: "true" }, disabled: true, warnings: [SPEC_OFF] },
    {
      name: "spec 1",
      env: { OTEL_SDK_DISABLED: "1" },
      disabled: false,
      warnings: [specIgnored("1")],
    },
    { name: "t3 1", env: { T3CODE_OTEL_SDK_DISABLED: "1" }, disabled: true, warnings: [T3_OFF] },
    {
      name: "t3 false overrides spec true",
      env: { T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "true" },
      disabled: false,
      warnings: [],
    },
    {
      name: "unreadable t3 warns and falls through",
      env: { T3CODE_OTEL_SDK_DISABLED: "maybe", OTEL_SDK_DISABLED: "true" },
      disabled: true,
      warnings: ["T3CODE_OTEL_SDK_DISABLED=maybe is not a yes or a no and was ignored", SPEC_OFF],
    },
  ])("$name", ({ env, disabled, warnings }) =>
    Effect.gen(function* () {
      const resolved = yield* load(env);
      assert.strictEqual(resolved.disabled, disabled);
      assert.deepStrictEqual(resolved.warnings, warnings);
    }),
  );

  it.effect.each([
    {
      name: "a percent-encoded list",
      env: { OTEL_RESOURCE_ATTRIBUTES: "team=core,message=hello%20world" },
      resourceAttributes: { team: "core", message: "hello world" },
      warnings: [],
    },
    {
      name: "a list that does not decode",
      env: { OTEL_RESOURCE_ATTRIBUTES: "team=core,broken=%zz" },
      resourceAttributes: {},
      warnings: [
        "OTEL_RESOURCE_ATTRIBUTES is not a list of percent-encoded key=value pairs and was ignored",
      ],
    },
  ])("resource attributes: $name", ({ env, resourceAttributes, warnings }) =>
    Effect.gen(function* () {
      const resolved = yield* load(env);
      assert.deepStrictEqual(resolved.resourceAttributes, resourceAttributes);
      assert.deepStrictEqual(resolved.warnings, warnings);
    }),
  );

  describe("layerResourceAttributes", () => {
    it.effect.each([
      { name: "a list that does not decode", raw: "team=%zz", attributes: [] },
      { name: "encoded separators", raw: "a%2Cb=x%3Dy", attributes: ["a,b"] },
    ])("lets the exporters' own read succeed with $name", ({ raw, attributes }) =>
      Effect.gen(function* () {
        const layerEnv = ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { OTEL_RESOURCE_ATTRIBUTES: raw } }),
        );
        const otel = yield* OtelEnvironment.load.pipe(Effect.provide(layerEnv));
        const resource = yield* OtlpResource.fromConfig({ serviceName: "t3" }).pipe(
          Effect.provide(
            Layer.provide(
              OtelEnvironment.layerResourceAttributes(otel.resourceAttributes),
              layerEnv,
            ),
          ),
        );
        assert.deepStrictEqual(
          resource.attributes
            .map((attribute) => attribute.key)
            .filter((key) => !key.startsWith("telemetry.sdk.")),
          [...attributes, "service.name"],
        );
      }),
    );
  });
});

describe("isCiEnvironment", () => {
  it("treats a set CI variable as CI, except empty, false, and 0", () => {
    assert.isFalse(OtelEnvironment.isCiEnvironment({}));
    assert.isTrue(OtelEnvironment.isCiEnvironment({ CI: "1" }));
    assert.isTrue(OtelEnvironment.isCiEnvironment({ TF_BUILD: "True" }));
    assert.isTrue(OtelEnvironment.isCiEnvironment({ BITBUCKET_BUILD_NUMBER: "42" }));
    for (const value of ["", " ", "false", "FALSE", "0"]) {
      assert.isFalse(OtelEnvironment.isCiEnvironment({ CI: value }), `CI=${value}`);
    }
    assert.isTrue(OtelEnvironment.isCiEnvironment({ CI: "false", GITLAB_CI: "true" }));
  });
});

describe("isRelayTracingEnabled", () => {
  it("turns off for DO_NOT_TRACK, even when T3 telemetry is on", () => {
    assert.isFalse(OtelEnvironment.isRelayTracingEnabled({ DO_NOT_TRACK: "1" }));
    assert.isFalse(
      OtelEnvironment.isRelayTracingEnabled({
        DO_NOT_TRACK: "true",
        T3CODE_TELEMETRY_ENABLED: "1",
      }),
    );
    assert.isTrue(OtelEnvironment.isRelayTracingEnabled({ DO_NOT_TRACK: "0" }));
    assert.isTrue(OtelEnvironment.isRelayTracingEnabled({ DO_NOT_TRACK: "" }));
  });

  it("defaults on and respects the T3CODE SDK override of the standard kill switch", () => {
    assert.isTrue(OtelEnvironment.isRelayTracingEnabled({}));
    assert.isFalse(OtelEnvironment.isRelayTracingEnabled({ OTEL_SDK_DISABLED: "true" }));
    assert.isTrue(
      OtelEnvironment.isRelayTracingEnabled({
        OTEL_SDK_DISABLED: "true",
        T3CODE_OTEL_SDK_DISABLED: "false",
      }),
    );
    assert.isFalse(
      OtelEnvironment.isRelayTracingEnabled({
        OTEL_SDK_DISABLED: "false",
        T3CODE_OTEL_SDK_DISABLED: "true",
      }),
    );
  });
});
