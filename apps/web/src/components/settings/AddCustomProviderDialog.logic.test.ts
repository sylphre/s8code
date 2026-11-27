// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { describe, expect, it } from "vite-plus/test";
import { SecretProviderId, type SecretReference } from "@s8code/contracts";

import {
  buildCustomProviderInstance,
  buildKiloConfigContent,
  buildKiloImportInstance,
  compatibleModelsEndpoint,
  compatibleModelsHeaders,
  customApiKeyVariableName,
  customProviderDriver,
  customProviderHomePath,
  mergeModelIds,
  parseCustomProviderModels,
  parseKiloConfigContent,
  parseModelCatalogResponse,
  validateCustomProviderDraft,
  type CustomProviderDraft,
} from "./AddCustomProviderDialog.logic";

const draft = (overrides: Partial<CustomProviderDraft> = {}): CustomProviderDraft => ({
  displayName: "My relay",
  kind: "openai",
  baseUrl: "https://relay.example.test/v1",
  apiKey: "sk-dummy",
  modelsText: "dummy-1\ndummy-2",
  binaryPath: "",
  ...overrides,
});

describe("parseCustomProviderModels", () => {
  it("splits lines and commas, trims, and drops blanks and duplicates", () => {
    expect(parseCustomProviderModels(" dummy-1 \n, dummy-2\n\ndummy-1,dummy-3")).toEqual([
      "dummy-1",
      "dummy-2",
      "dummy-3",
    ]);
    expect(parseCustomProviderModels(" \n,")).toEqual([]);
  });
});

describe("mergeModelIds", () => {
  it("appends candidates the user has not listed, keeping their lines", () => {
    expect(mergeModelIds("mine-1\nmine-2", ["catalog-1", "mine-1", "catalog-2"])).toBe(
      "mine-1\nmine-2\ncatalog-1\ncatalog-2",
    );
    expect(mergeModelIds("", ["catalog-1"])).toBe("catalog-1");
    expect(mergeModelIds("mine-1", [])).toBe("mine-1");
  });
});

describe("compatibleModelsEndpoint", () => {
  it("appends the per-kind models path to the base URL", () => {
    expect(compatibleModelsEndpoint("openai", "https://relay.example.test/v1")).toBe(
      "https://relay.example.test/v1/models",
    );
    expect(compatibleModelsEndpoint("anthropic", "https://relay.example.test")).toBe(
      "https://relay.example.test/v1/models",
    );
    expect(compatibleModelsEndpoint("openai", "https://relay.example.test/")).toBe(
      "https://relay.example.test/models",
    );
  });

  it("rejects an unusable Base URL", () => {
    expect(compatibleModelsEndpoint("openai", "relay.example.test")).toBeUndefined();
    expect(compatibleModelsEndpoint("openai", "ftp://relay.example.test")).toBeUndefined();
  });
});

describe("compatibleModelsHeaders", () => {
  it("sends the per-kind auth headers for a literal key", () => {
    expect(compatibleModelsHeaders("openai", "sk-dummy")).toEqual({
      Authorization: "Bearer sk-dummy",
    });
    expect(compatibleModelsHeaders("anthropic", "sk-dummy")).toEqual({
      "x-api-key": "sk-dummy",
      "anthropic-version": "2023-06-01",
    });
  });

  it("sends no headers without a literal key", () => {
    expect(compatibleModelsHeaders("openai", null)).toEqual({});
    expect(compatibleModelsHeaders("anthropic", "")).toEqual({});
  });
});

describe("parseModelCatalogResponse", () => {
  it("reads OpenAI, Anthropic, and bare-array payloads", () => {
    expect(parseModelCatalogResponse({ data: [{ id: " dummy-1 " }, { id: "dummy-2" }] })).toEqual([
      "dummy-1",
      "dummy-2",
    ]);
    expect(parseModelCatalogResponse({ data: [{ id: "dummy-1", display_name: "Dummy" }] })).toEqual(
      ["dummy-1"],
    );
    expect(parseModelCatalogResponse(["dummy-1", { id: "dummy-2" }, { nope: true }, null])).toEqual(
      ["dummy-2"],
    );
  });

  it("returns nothing for payloads without model ids", () => {
    expect(parseModelCatalogResponse({ error: { message: "nope" } })).toEqual([]);
    expect(parseModelCatalogResponse(null)).toEqual([]);
  });
});

describe("customApiKeyVariableName", () => {
  it("folds the instance id into a valid variable name", () => {
    expect(customApiKeyVariableName("opencode_my-relay_1")).toBe(
      "S8_CUSTOM_OPENCODE_MY_RELAY_1_API_KEY",
    );
  });
});

describe("customProviderDriver and paths", () => {
  it("maps the kind to the composing driver", () => {
    expect(customProviderDriver("anthropic")).toBe("claudeAgent");
    expect(customProviderDriver("openai")).toBe("opencode");
  });

  it("keeps generated homes under the custom-providers root", () => {
    expect(customProviderHomePath("claudeAgent_myrelay")).toBe(
      "~/.t3/custom-providers/claudeAgent_myrelay/claude-home",
    );
  });
});

describe("validateCustomProviderDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateCustomProviderDraft(draft({ apiKey: "" }))).toBeNull();
  });

  it("requires a name, an http(s) base URL, and a model", () => {
    expect(validateCustomProviderDraft(draft({ displayName: " " }))).toBe("Name is required.");
    expect(validateCustomProviderDraft(draft({ baseUrl: "relay.example.test" }))).toBe(
      "Enter an http(s) Base URL.",
    );
    expect(validateCustomProviderDraft(draft({ baseUrl: "ftp://relay.example.test" }))).toBe(
      "Enter an http(s) Base URL.",
    );
    expect(validateCustomProviderDraft(draft({ modelsText: " \n," }))).toBe(
      "Add at least one model ID.",
    );
  });
});

describe("buildCustomProviderInstance", () => {
  it("composes an Anthropic-compatible Claude instance", () => {
    const instance = buildCustomProviderInstance({
      draft: draft({ kind: "anthropic" }),
      instanceId: "claudeAgent_myrelay",
    });
    expect(instance).toEqual({
      driver: "claudeAgent",
      enabled: true,
      displayName: "My relay",
      config: {
        homePath: "~/.t3/custom-providers/claudeAgent_myrelay/claude-home",
        customModels: ["dummy-1", "dummy-2"],
      },
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://relay.example.test/v1", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-dummy", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
    });
  });

  it("hands the Kilo engine a config JSON that carries no key value", () => {
    const instance = buildCustomProviderInstance({
      draft: draft(),
      instanceId: "opencode_myrelay",
    });
    expect(instance.driver).toBe("opencode");
    expect(instance.config).toEqual({
      binaryPath: "kilo",
      customModels: ["dummy-1", "dummy-2"],
    });
    const environment = instance.environment ?? [];
    expect(environment.map((variable) => variable.name)).toEqual([
      "KILO_CONFIG_CONTENT",
      "S8_CUSTOM_OPENCODE_MYRELAY_API_KEY",
    ]);
    const configContent = environment[0]!;
    expect(configContent.sensitive).toBe(false);
    expect(configContent.value).not.toContain("sk-dummy");
    expect(JSON.parse(configContent.value as string)).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: {
        "s8-opencode_myrelay": {
          npm: "@ai-sdk/openai-compatible",
          name: "My relay",
          options: {
            baseURL: "https://relay.example.test/v1",
            apiKey: "{env:S8_CUSTOM_OPENCODE_MYRELAY_API_KEY}",
          },
          models: { "dummy-1": { name: "dummy-1" }, "dummy-2": { name: "dummy-2" } },
        },
      },
    });
    const keyVariable = environment[1]!;
    expect(keyVariable).toEqual({
      name: "S8_CUSTOM_OPENCODE_MYRELAY_API_KEY",
      value: "sk-dummy",
      sensitive: true,
    });
    expect(environment.some((variable) => variable.name === "KILO_SERVER_PASSWORD")).toBe(false);
  });

  it("uses a typed binary path and omits the key variable when the key is blank", () => {
    const instance = buildCustomProviderInstance({
      draft: draft({ apiKey: " ", binaryPath: " /opt/bin/kilo " }),
      instanceId: "opencode_myrelay",
    });
    expect(instance.config).toMatchObject({ binaryPath: "/opt/bin/kilo" });
    expect((instance.environment ?? []).map((variable) => variable.name)).toEqual([
      "KILO_CONFIG_CONTENT",
    ]);
  });

  it("stores a secret provider reference as the key variable", () => {
    const reference: SecretReference = {
      provider: SecretProviderId.make("onepassword"),
      reference: "op://vault/item/field",
    };
    const instance = buildCustomProviderInstance({
      draft: draft({ apiKey: reference }),
      instanceId: "opencode_myrelay",
    });
    const environment = instance.environment ?? [];
    expect(environment[1]).toEqual({
      name: "S8_CUSTOM_OPENCODE_MYRELAY_API_KEY",
      value: reference,
      sensitive: true,
    });
  });
});

describe("buildKiloConfigContent", () => {
  it("trims the display name and base URL", () => {
    const content = buildKiloConfigContent({
      instanceId: "opencode_myrelay",
      displayName: " My relay ",
      baseUrl: " https://relay.example.test/v1 ",
      models: ["dummy-1"],
      apiKeyVariableName: "S8_CUSTOM_DUMMY_API_KEY",
    });
    const parsed = JSON.parse(content) as {
      provider: Record<string, { name: string; options: { baseURL: string } }>;
    };
    expect(parsed.provider["s8-opencode_myrelay"]!.name).toBe("My relay");
    expect(parsed.provider["s8-opencode_myrelay"]!.options.baseURL).toBe(
      "https://relay.example.test/v1",
    );
  });
});

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
  },
  "agent": {
    "reviewer": { "prompt": "Review the diff.", "model": "deepseek/deepseek-reasoner" },
  },
}`;

describe("parseKiloConfigContent", () => {
  it("reads providers with comments and trailing commas, keeping model keys", () => {
    const result = parseKiloConfigContent(kiloConfigText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers.map((provider) => provider.id)).toEqual(["deepseek", "plain"]);
    expect(result.config.providers[0]).toMatchObject({
      name: "DeepSeek",
      baseURL: "https://api.deepseek.test",
      models: ["deepseek-chat", "deepseek-reasoner"],
      literalApiKey: "sk-pasted",
    });
    expect(result.config.providers[1]!.literalApiKey).toBeNull();
    expect(result.config.agentNames).toEqual(["reviewer"]);
    expect(result.config.agentBlock).toEqual({
      reviewer: { prompt: "Review the diff.", model: "deepseek/deepseek-reasoner" },
    });
  });

  it("reports the line of a syntax error", () => {
    const result = parseKiloConfigContent('{\n  "provider": {\n    broken\n  }\n}');
    expect(result).toEqual({
      ok: false,
      error: "Line 3: InvalidSymbol in the pasted config.",
    });
  });

  it("reports the provider id when an entry has no baseURL", () => {
    const result = parseKiloConfigContent('{ "provider": { "broken": { "name": "x" } } }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('provider "broken"');
    expect(result.error).toContain('"baseURL"');
  });

  it("rejects a non-object and a config without providers", () => {
    expect(parseKiloConfigContent("[]").ok).toBe(false);
    expect(parseKiloConfigContent('{ "agent": {} }').ok).toBe(false);
  });
});

describe("buildKiloImportInstance", () => {
  const parsed = parseKiloConfigContent(kiloConfigText);
  if (!parsed.ok) throw new Error("fixture must parse");
  const [deepseek, plain] = parsed.config.providers;

  it("renames the provider block and moves a literal key into a sensitive variable", () => {
    const { instance, apiKeyValue } = buildKiloImportInstance({
      provider: deepseek!,
      instanceId: "opencode_deepseek",
      agentBlock: parsed.config.agentBlock,
      binaryPath: "",
    });
    expect(instance.displayName).toBe("DeepSeek");
    expect(instance.config).toEqual({
      binaryPath: "kilo",
      customModels: ["deepseek-chat", "deepseek-reasoner"],
    });
    const environment = instance.environment ?? [];
    expect(environment.map((variable) => variable.name)).toEqual([
      "KILO_CONFIG_CONTENT",
      "S8_CUSTOM_OPENCODE_DEEPSEEK_API_KEY",
    ]);
    expect(apiKeyValue).toBe("sk-pasted");
    const configContent = environment[0]!;
    expect(configContent.sensitive).toBe(false);
    expect(configContent.value).not.toContain("sk-pasted");
    expect(JSON.parse(configContent.value as string)).toEqual({
      $schema: "https://opencode.ai/config.json",
      agent: {
        reviewer: { prompt: "Review the diff.", model: "s8-opencode_deepseek/deepseek-reasoner" },
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
    expect(environment[1]).toEqual({
      name: "S8_CUSTOM_OPENCODE_DEEPSEEK_API_KEY",
      value: "sk-pasted",
      sensitive: true,
    });
  });

  it("keeps an {env:} key reference and copies the agents into the engine config", () => {
    const { instance, apiKeyValue } = buildKiloImportInstance({
      provider: plain!,
      instanceId: "opencode_plain",
      agentBlock: parsed.config.agentBlock,
      binaryPath: "/opt/bin/kilo",
    });
    expect(apiKeyValue).toBeNull();
    const configContent = (instance.environment ?? [])[0]!;
    const parsedContent = JSON.parse(configContent.value as string) as {
      provider: Record<string, { options: { apiKey: string } }>;
      agent: Record<string, { model?: string }>;
    };
    expect(parsedContent.provider["s8-opencode_plain"]!.options.apiKey).toBe("{env:PLAIN_KEY}");
    expect(parsedContent.agent.reviewer!.model).toBe("deepseek/deepseek-reasoner");
    expect((instance.environment ?? []).map((variable) => variable.name)).toEqual([
      "KILO_CONFIG_CONTENT",
    ]);
  });
});
