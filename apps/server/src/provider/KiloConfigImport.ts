// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import {
  ImportKiloProvidersInput,
  ImportKiloProvidersResult,
  ReadKiloConfigSummaryInput,
  ReadKiloConfigSummaryResult,
  ProviderInstanceId,
  ServerSettingsError,
  type KiloConfigReadFailure,
  type KiloConfigSummary,
} from "@s8code/contracts";
import {
  buildKiloImportInstance,
  parseKiloConfig,
  readRecord,
  type KiloConfigProblem,
  type ParsedKiloConfig,
} from "@s8code/shared/kiloImport";
import * as HostProcess from "@s8code/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";

// Mirrors the wizard's instance id derivation (client-runtime providerInstanceIds), so a file
// import lands on the same ids a paste import of the same provider would.
const availableInstanceId = (label: string, existing: ReadonlySet<string>): ProviderInstanceId => {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const base = slug ? `opencode_${slug}` : "opencode_provider";
  if (!existing.has(base)) return ProviderInstanceId.make(base);
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return ProviderInstanceId.make(candidate);
  }
};

const problemFailure = (problem: KiloConfigProblem, path: string): KiloConfigReadFailure => {
  switch (problem.reason) {
    case "syntax":
      return {
        reason: "parse_error",
        message: `Line ${problem.line}: ${problem.detail}.`,
        path,
        line: problem.line,
      };
    case "empty":
      return { reason: "empty", message: "The file holds no JSON.", path };
    case "not_object":
      return { reason: "not_object", message: "The config must be a JSON object.", path };
    case "no_provider_section":
      return {
        reason: "no_provider_section",
        message: 'The config has no "provider" section to import.',
        path,
      };
    default:
      return {
        reason: problem.reason,
        message: `Provider "${problem.id}" is not importable at line ${problem.line}.`,
        path,
        line: problem.line,
        providerId: problem.id,
      };
  }
};

const summaryOf = (path: string, config: ParsedKiloConfig): KiloConfigSummary => ({
  path,
  providers: config.providers.map((provider) => {
    const apiKey = readRecord(provider.block.options)?.apiKey;
    return {
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      models: [...provider.models],
      hasApiKey: typeof apiKey === "string" && apiKey.trim().length > 0,
    };
  }),
  agentNames: [...config.agentNames],
});

export class KiloConfigImport extends Context.Service<
  KiloConfigImport,
  {
    /** Reads the summary of a kilo.jsonc on this host; a key's presence only, never its value. */
    readonly summary: (
      input: ReadKiloConfigSummaryInput,
    ) => Effect.Effect<ReadKiloConfigSummaryResult>;
    readonly importProviders: (
      input: ImportKiloProvidersInput,
    ) => Effect.Effect<ImportKiloProvidersResult, ServerSettingsError>;
  }
>()("t3/provider/KiloConfigImport") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // References resolve where they run, so capture the server host's env and home once here.
  const hostEnv = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;

  const defaultConfigPath = () => {
    const xdgConfigHome = hostEnv.XDG_CONFIG_HOME?.trim();
    return path.join(
      xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, ".config"),
      "kilo",
      "kilo.jsonc",
    );
  };

  const resolvePath = (raw: string | undefined) => {
    const trimmed = raw?.trim() ?? "";
    if (trimmed.length === 0) return defaultConfigPath();
    // A `~` prefix names the server host's home, where the file is read.
    if (trimmed === "~" || trimmed.startsWith("~/")) {
      return path.join(home, trimmed.slice(1));
    }
    return path.resolve(trimmed);
  };

  type Read =
    | { readonly _tag: "Ok"; readonly config: ParsedKiloConfig; readonly path: string }
    | { readonly _tag: "Failed"; readonly failure: KiloConfigReadFailure };

  const readConfig = Effect.fn("KiloConfigImport.readConfig")(function* (raw: string | undefined) {
    const resolved = resolvePath(raw);
    const stat = yield* Effect.option(fs.stat(resolved));
    if (Option.isNone(stat)) {
      const notFound: Read = {
        _tag: "Failed",
        failure: { reason: "not_found", message: "No file was found.", path: resolved },
      };
      return notFound;
    }
    if (stat.value.type !== "File") {
      const notFile: Read = {
        _tag: "Failed",
        failure: { reason: "not_file", message: "The path is not a file.", path: resolved },
      };
      return notFile;
    }
    const contents = yield* fs.readFileString(resolved).pipe(
      Effect.map((text) => ({ ok: true as const, text })),
      Effect.mapError((): KiloConfigReadFailure => ({
        reason: "not_readable",
        message: "The file could not be read.",
        path: resolved,
      })),
      Effect.catch((failure) => Effect.succeed({ ok: false as const, failure })),
    );
    if (!contents.ok) {
      const unreadable: Read = { _tag: "Failed", failure: contents.failure };
      return unreadable;
    }
    const parsed = parseKiloConfig(contents.text);
    if (!parsed.ok) {
      const invalid: Read = { _tag: "Failed", failure: problemFailure(parsed.problem, resolved) };
      return invalid;
    }
    const ok: Read = { _tag: "Ok", config: parsed.config, path: resolved };
    return ok;
  });

  const summary = Effect.fn("KiloConfigImport.summary")(function* (
    input: ReadKiloConfigSummaryInput,
  ) {
    const read = yield* readConfig(input.path);
    if (read._tag === "Failed") {
      const failed: ReadKiloConfigSummaryResult = { _tag: "Failed", ...read.failure };
      return failed;
    }
    const ok: ReadKiloConfigSummaryResult = {
      _tag: "Ok",
      summary: summaryOf(read.path, read.config),
    };
    return ok;
  });

  const importProviders = Effect.fn("KiloConfigImport.importProviders")(function* (
    input: ImportKiloProvidersInput,
  ) {
    const read = yield* readConfig(input.path);
    if (read._tag === "Failed") {
      const failed: ImportKiloProvidersResult = { _tag: "Failed", ...read.failure };
      return failed;
    }
    const selected = new Set(input.providerIds);
    const parseable = new Set(read.config.providers.map((provider) => provider.id));
    const missing = [...selected].filter((id) => !parseable.has(id));
    if (missing.length > 0) {
      const providerId = missing[0]!;
      const unknownProvider: ImportKiloProvidersResult = {
        _tag: "Failed",
        reason: "provider_not_found",
        message: `The file has no provider "${providerId}". Read it again.`,
        path: read.path,
        providerId,
      };
      return unknownProvider;
    }
    const claimed = new Set(Object.keys((yield* serverSettings.getSettings).providerInstances));
    const instanceIds: ProviderInstanceId[] = [];
    for (const provider of read.config.providers) {
      if (!selected.has(provider.id)) continue;
      const instanceId = availableInstanceId(provider.id, claimed);
      const { instance } = buildKiloImportInstance({
        provider,
        instanceId,
        agentBlock: read.config.agentBlock,
        binaryPath: "",
      });
      yield* serverSettings.updateProviderInstance({
        operation: "create",
        instanceId,
        instance,
      });
      claimed.add(instanceId);
      instanceIds.push(instanceId);
    }
    const ok: ImportKiloProvidersResult = { _tag: "Ok", instanceIds };
    return ok;
  });

  return KiloConfigImport.of({ summary, importProviders });
});

export const layer = Layer.effect(KiloConfigImport, make);
