// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { describe, expect, it } from "vite-plus/test";

import { buildKiloImportInstance, parseKiloConfig } from "./kiloImport.ts";

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

describe("parseKiloConfig", () => {
  it("reads providers with comments and trailing commas", () => {
    const result = parseKiloConfig(kiloConfigText);
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
  });

  it("locates a syntax error by line", () => {
    const result = parseKiloConfig('{\n  "provider": {\n    broken\n  }\n}');
    expect(result).toEqual({
      ok: false,
      problem: { reason: "syntax", line: 3, detail: "InvalidSymbol" },
    });
  });

  it("locates an entry problem by provider id and line", () => {
    const result = parseKiloConfig('{\n "provider": {\n  "broken": {\n   "name": "x"\n  }\n }\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toEqual({
      reason: "missing_base_url",
      id: "broken",
      line: 3,
    });
  });

  it("rejects a non-object and a config without providers", () => {
    expect(parseKiloConfig("[]")).toEqual({ ok: false, problem: { reason: "not_object" } });
    expect(parseKiloConfig('{ "agent": {} }')).toEqual({
      ok: false,
      problem: { reason: "no_provider_section" },
    });
  });
});

describe("buildKiloImportInstance", () => {
  it("moves a literal key into a sensitive variable and rewrites agent models", () => {
    const parsed = parseKiloConfig(kiloConfigText);
    if (!parsed.ok) throw new Error("fixture must parse");
    const [deepseek] = parsed.config.providers;
    const { instance, apiKeyValue } = buildKiloImportInstance({
      provider: deepseek!,
      instanceId: "opencode_deepseek",
      agentBlock: parsed.config.agentBlock,
      binaryPath: "",
    });
    expect(apiKeyValue).toBe("sk-pasted");
    const configContent = (instance.environment ?? [])[0]!;
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
    expect((instance.environment ?? [])[1]).toEqual({
      name: "S8_CUSTOM_OPENCODE_DEEPSEEK_API_KEY",
      value: "sk-pasted",
      sensitive: true,
    });
  });
});
