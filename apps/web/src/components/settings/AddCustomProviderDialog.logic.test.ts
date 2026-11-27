// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { describe, expect, it } from "vite-plus/test";
import { SecretProviderId, type SecretReference } from "@s8code/contracts";

import {
  buildCustomProviderInstance,
  buildKiloConfigContent,
  customApiKeyVariableName,
  customProviderDriver,
  customProviderHomePath,
  parseCustomProviderModels,
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
