// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { buildKiloImportInstance } from "@s8code/shared/kiloImport";
import { ProviderInstanceId } from "@s8code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as HostProcess from "@s8code/shared/HostProcess";

import * as KiloConfigImport from "./KiloConfigImport.ts";
import * as ServerSettings from "../serverSettings.ts";

const kiloConfigText = `{
  // Kilo config
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.test",
        "apiKey": "sk-pasted",
      },
      "models": { "deepseek-chat": {}, "deepseek-reasoner": {} },
    },
    "plain": {
      "options": { "baseURL": "https://plain.test", "apiKey": "{env:PLAIN_KEY}" },
    },
    "keyless": {
      "options": { "baseURL": "https://keyless.test" },
    },
  },
  "agent": {
    "reviewer": { "prompt": "Review the diff.", "model": "deepseek/deepseek-reasoner" },
  },
}`;

const setup = (
  options: {
    readonly configDir?: string;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-import-" });
    const configDir = options.configDir ?? `${root}/config`;
    yield* fs.makeDirectory(configDir, { recursive: true });
    const services = KiloConfigImport.layer.pipe(
      Layer.provideMerge(ServerSettings.layerTest(options.settings)),
      Layer.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          Layer.succeed(HostProcess.Environment, {
            ...process.env,
            XDG_CONFIG_HOME: configDir,
          }),
          Layer.succeed(HostProcess.HomeDirectory, root),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const kilo = yield* KiloConfigImport.KiloConfigImport;
      const settings = yield* ServerSettings.ServerSettingsService;
      return { fs, root, configDir, kilo, settings };
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide(NodeFileSystem.layer));

const writeConfig = (fs: FileSystem.FileSystem, path: string, text: string) =>
  fs
    .makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(path, text)));

describe("KiloConfigImport", () => {
  it.effect("summary answers presence only, never a key value", () =>
    Effect.gen(function* () {
      const { configDir, kilo, fs } = yield* setup();
      yield* writeConfig(fs, `${configDir}/kilo/kilo.jsonc`, kiloConfigText);

      const result = yield* kilo.summary({});
      assert.deepStrictEqual(result._tag, "Ok");
      if (result._tag !== "Ok") return;
      assert.deepStrictEqual(
        result.summary.providers.map((provider) => provider.id),
        ["deepseek", "plain", "keyless"],
      );
      assert.deepStrictEqual(
        result.summary.providers.map((provider) => provider.hasApiKey),
        [true, true, false],
      );
      assert.deepStrictEqual(result.summary.providers[0], {
        id: "deepseek",
        name: "DeepSeek",
        baseURL: "https://api.deepseek.test",
        models: ["deepseek-chat", "deepseek-reasoner"],
        hasApiKey: true,
      });
      assert.deepStrictEqual(result.summary.agentNames, ["reviewer"]);
      assert.deepStrictEqual(result.summary.path, `${configDir}/kilo/kilo.jsonc`);
      assert.notInclude(JSON.stringify(result), "sk-pasted");
    }).pipe(Effect.scoped),
  );

  it.effect("an import stores the same instance shape the paste import builds", () =>
    Effect.gen(function* () {
      const { configDir, kilo, fs, settings } = yield* setup();
      const configPath = `${configDir}/kilo/kilo.jsonc`;
      yield* writeConfig(fs, configPath, kiloConfigText);

      const parsed = buildKiloImportInstance({
        provider: {
          id: "deepseek",
          name: "DeepSeek",
          baseURL: "https://api.deepseek.test",
          models: ["deepseek-chat", "deepseek-reasoner"],
          block: {
            npm: "@ai-sdk/openai-compatible",
            name: "DeepSeek",
            options: { baseURL: "https://api.deepseek.test", apiKey: "sk-pasted" },
            models: { "deepseek-chat": {}, "deepseek-reasoner": {} },
          },
          literalApiKey: "sk-pasted",
        },
        instanceId: "opencode_deepseek",
        agentBlock: {
          reviewer: { prompt: "Review the diff.", model: "deepseek/deepseek-reasoner" },
        },
        binaryPath: "",
      });

      const result = yield* kilo.importProviders({ path: configPath, providerIds: ["deepseek"] });
      assert.deepStrictEqual(result._tag, "Ok");
      if (result._tag !== "Ok") return;
      assert.deepStrictEqual(result.instanceIds, [ProviderInstanceId.make("opencode_deepseek")]);

      const stored = (yield* settings.getSettings).providerInstances[
        "opencode_deepseek" as ProviderInstanceId
      ]!;
      assert.deepStrictEqual(stored, parsed.instance);
      const configContent = (stored.environment ?? [])[0]!;
      assert.deepStrictEqual(configContent.sensitive, false);
      // The key lives only in the sensitive variable; the generated config never names it.
      assert.notInclude(configContent.value as string, "sk-pasted");
      assert.deepStrictEqual(JSON.parse(configContent.value as string), {
        $schema: "https://opencode.ai/config.json",
        agent: {
          reviewer: {
            prompt: "Review the diff.",
            model: "s8-opencode_deepseek/deepseek-reasoner",
          },
        },
        provider: {
          "s8-opencode_deepseek": {
            npm: "@ai-sdk/openai-compatible",
            name: "DeepSeek",
            options: {
              baseURL: "https://api.deepseek.test",
              apiKey: "{env:S8_CUSTOM_OPENCODE_DEEPSEEK_API_KEY}",
            },
            models: { "deepseek-chat": {}, "deepseek-reasoner": {} },
          },
        },
      });
      assert.deepStrictEqual((stored.environment ?? [])[1], {
        name: "S8_CUSTOM_OPENCODE_DEEPSEEK_API_KEY",
        value: "sk-pasted",
        sensitive: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ids avoid the instances the settings already hold", () =>
    Effect.gen(function* () {
      const { configDir, kilo, fs } = yield* setup({
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("opencode_deepseek")]: { driver: "opencode", enabled: true },
          },
        },
      });
      const configPath = `${configDir}/kilo/kilo.jsonc`;
      yield* writeConfig(fs, configPath, kiloConfigText);
      const result = yield* kilo.importProviders({
        path: configPath,
        providerIds: ["deepseek", "plain"],
      });
      if (result._tag !== "Ok") return assert.fail("expected Ok");
      assert.deepStrictEqual(result.instanceIds, [
        ProviderInstanceId.make("opencode_deepseek_2"),
        ProviderInstanceId.make("opencode_plain"),
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("failures name the line or provider id and never a key value", () =>
    Effect.gen(function* () {
      const { configDir, kilo, fs } = yield* setup();
      const configPath = `${configDir}/kilo/kilo.jsonc`;
      yield* writeConfig(fs, configPath, '{\n  "provider": {\n    broken\n  }\n}');
      const broken = yield* kilo.summary({ path: configPath });
      assert.deepStrictEqual(broken._tag, "Failed");
      if (broken._tag !== "Failed") return;
      assert.deepStrictEqual(broken.reason, "parse_error");
      assert.deepStrictEqual(broken.line, 3);

      yield* fs.remove(configPath, { force: true });
      const missing = yield* kilo.summary({ path: configPath });
      assert.deepStrictEqual(missing._tag, "Failed");
      if (missing._tag !== "Failed") return;
      assert.deepStrictEqual(missing.reason, "not_found");

      yield* writeConfig(fs, configPath, kiloConfigText);
      const unknownProvider = yield* kilo.importProviders({
        path: configPath,
        providerIds: ["gone"],
      });
      assert.deepStrictEqual(unknownProvider._tag, "Failed");
      if (unknownProvider._tag !== "Failed") return;
      assert.deepStrictEqual(unknownProvider.reason, "provider_not_found");
      assert.deepStrictEqual(unknownProvider.providerId, "gone");
      assert.notInclude(JSON.stringify(unknownProvider), "sk-pasted");
    }).pipe(Effect.scoped),
  );

  it.effect("a path that is not a file and a tilde path both resolve on the host", () =>
    Effect.gen(function* () {
      const { root, kilo, fs } = yield* setup();
      const directory = yield* kilo.summary({ path: root });
      assert.deepStrictEqual(directory._tag, "Failed");
      if (directory._tag !== "Failed") return;
      assert.deepStrictEqual(directory.reason, "not_file");

      yield* writeConfig(fs, `${root}/.config/kilo/kilo.jsonc`, kiloConfigText);
      const tilted = yield* kilo.summary({ path: "~/.config/kilo/kilo.jsonc" });
      if (tilted._tag !== "Ok") return assert.fail("expected Ok");
      assert.deepStrictEqual(tilted.summary.path, `${root}/.config/kilo/kilo.jsonc`);
      assert.notInclude(JSON.stringify(tilted), "sk-pasted");
    }).pipe(Effect.scoped),
  );

  it.effect("an empty selection imports nothing", () =>
    Effect.gen(function* () {
      const { configDir, kilo, fs } = yield* setup();
      const configPath = `${configDir}/kilo/kilo.jsonc`;
      yield* writeConfig(fs, configPath, kiloConfigText);
      const result = yield* kilo.importProviders({ path: configPath, providerIds: [] });
      assert.deepStrictEqual(result, { _tag: "Ok", instanceIds: [] });
    }).pipe(Effect.scoped),
  );
});
