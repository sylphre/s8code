import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

interface Flag {
  readonly value: boolean | undefined;
  readonly warning?: string;
}

const TrimmedLowercase = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.trim().pipe(
      SchemaTransformation.composeTransformation(SchemaTransformation.toLowerCase()),
    ),
  ),
);

const flag = (
  name: string,
  truthy: ReadonlyArray<string>,
  falsy: ReadonlyArray<string>,
  invalid: (value: string) => string,
) =>
  Config.schema(
    TrimmedLowercase.pipe(Schema.decodeTo(Schema.Literals([...truthy, ...falsy]))),
    name,
  ).pipe(
    Config.map((value): Flag => ({ value: truthy.includes(value) })),
    Config.orElse(() =>
      Config.String(name).pipe(
        Config.map((raw): Flag => {
          const value = raw.trim();
          return value === ""
            ? { value: undefined }
            : { value: undefined, warning: invalid(value) };
        }),
      ),
    ),
    Config.withDefault<Flag>({ value: undefined }),
  );

// `Config.Boolean`'s literals, which effect does not export on their own.
const T3CODE_TRUE = ["true", "yes", "on", "1", "y"];
const T3CODE_FALSE = ["false", "no", "off", "0", "n"];

const RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";

interface ResourceAttributes {
  readonly value: Readonly<Record<string, string>>;
  readonly warning?: string;
}

const resourceAttributes = Config.Record(
  Schema.StringFromUriComponent,
  Schema.StringFromUriComponent,
  RESOURCE_ATTRIBUTES,
).pipe(
  Config.map((value): ResourceAttributes => ({ value })),
  Config.orElse(() =>
    Config.String(RESOURCE_ATTRIBUTES).pipe(
      // The value is left out because attributes can carry credentials.
      Config.map((): ResourceAttributes => ({
        value: {},
        warning: `${RESOURCE_ATTRIBUTES} is not a list of percent-encoded key=value pairs and was ignored`,
      })),
    ),
  ),
  Config.withDefault<ResourceAttributes>({ value: {} }),
);

const sdkFlags = {
  t3: flag(
    "T3CODE_OTEL_SDK_DISABLED",
    T3CODE_TRUE,
    T3CODE_FALSE,
    (value) => `T3CODE_OTEL_SDK_DISABLED=${value} is not a yes or a no and was ignored`,
  ),
  // OTEL booleans are true only for case-insensitive true; warn on unrecognized values.
  spec: flag(
    "OTEL_SDK_DISABLED",
    ["true"],
    ["false"],
    (value) =>
      `OTEL_SDK_DISABLED=${value} was read as false; the OpenTelemetry specification recognizes only the string true, so use OTEL_SDK_DISABLED=true or T3CODE_OTEL_SDK_DISABLED to say it any other way`,
  ),
};

export const load: Effect.Effect<OtelEnvironment> = Config.all({
  ...sdkFlags,
  resource: resourceAttributes,
}).pipe(
  Effect.map(({ t3, spec, resource }) => {
    const disabled = t3.value ?? spec.value ?? false;
    const warnings = [t3.warning, spec.warning, resource.warning].filter(
      (warning) => warning !== undefined,
    );
    if (disabled) {
      warnings.push(
        t3.value
          ? "T3CODE_OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it"
          : "OTEL_SDK_DISABLED is set, so no telemetry is exported, whatever configured it; set T3CODE_OTEL_SDK_DISABLED=false to export anyway",
      );
    }
    return {
      disabled,
      warnings,
      resourceAttributes: resource.value,
    };
  }),
  Effect.orDie,
);

// Variables CI services set on their runners. `CI=false` or `CI=0` means not CI.
const CI_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "DRONE",
  "APPVEYOR",
] as const;

/** CI runs are not installs, so telemetry is off there by default. */
export const isCiEnvironment = (env: Readonly<Record<string, string | undefined>>) =>
  CI_VARIABLES.some((name) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "false" && value !== "0";
  });

export const isRelayTracingEnabled = (env: Readonly<Record<string, string | undefined>>) =>
  Config.all(sdkFlags).pipe(
    Effect.map(({ t3, spec }) => !(t3.value ?? spec.value ?? false)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    Effect.orDie,
    Effect.runSync,
  );

export interface OtelEnvironment {
  readonly disabled: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly resourceAttributes: Readonly<Record<string, string>>;
}

/** Give OTLP exporters the accepted resource attributes so their own decoding cannot fail. */
export const layerResourceAttributes = (attributes: Readonly<Record<string, string>>) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromEnv({
      env: {
        [RESOURCE_ATTRIBUTES]: Object.entries(attributes)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join(","),
      },
      preserveEmptyStrings: true,
    }),
    { asPrimary: true },
  );

export const none: OtelEnvironment = {
  disabled: false,
  warnings: [],
  resourceAttributes: {},
};
