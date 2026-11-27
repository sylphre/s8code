// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
} from "@s8code/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export type CustomProviderKind = "anthropic" | "openai";

const ANTHROPIC_COMPAT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENAI_COMPAT_DRIVER = ProviderDriverKind.make("opencode");

export const customProviderDriver = (kind: CustomProviderKind): ProviderDriverKind =>
  kind === "anthropic" ? ANTHROPIC_COMPAT_DRIVER : OPENAI_COMPAT_DRIVER;

export const CUSTOM_PROVIDER_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  ANTHROPIC_COMPAT_DRIVER,
  OPENAI_COMPAT_DRIVER,
];

// The OpenCode settings schema decodes an omitted binaryPath as "opencode", so a Kilo
// instance must name the kilo binary itself.
const KILO_DEFAULT_BINARY_PATH = "kilo";

// A `~` homePath expands on the server, so the path also holds for remote environments.
const CUSTOM_PROVIDER_HOME_ROOT = "~/.t3/custom-providers";

export interface CustomProviderDraft {
  readonly displayName: string;
  readonly kind: CustomProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string | SecretReference;
  readonly modelsText: string;
  readonly binaryPath: string;
}

export function parseCustomProviderModels(text: string): ReadonlyArray<string> {
  const models: string[] = [];
  for (const token of text.split(/[\n,]/)) {
    const model = token.trim();
    if (model.length > 0 && !models.includes(model)) models.push(model);
  }
  return models;
}

/** One name shared by the key variable and the config JSON's `{env:}` reference. */
export function customApiKeyVariableName(instanceId: string): string {
  return `S8_CUSTOM_${instanceId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export const customProviderHomePath = (instanceId: string): string =>
  `${CUSTOM_PROVIDER_HOME_ROOT}/${instanceId}/claude-home`;

export function validateCustomProviderDraft(
  draft: CustomProviderDraft,
  resolve: MessageResolver = m,
): string | null {
  if (draft.displayName.trim().length === 0) return resolve(msg("Name is required."));
  const endpoint = URL.parse(draft.baseUrl.trim());
  if (endpoint === null || !/^https?:$/.test(endpoint.protocol)) {
    return resolve(msg("Enter an http(s) Base URL."));
  }
  if (parseCustomProviderModels(draft.modelsText).length === 0) {
    return resolve(msg("Add at least one model ID."));
  }
  return null;
}

export function buildKiloConfigContent(input: {
  readonly instanceId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly models: ReadonlyArray<string>;
  readonly apiKeyVariableName: string;
}): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [`s8-${input.instanceId}`]: {
        npm: "@ai-sdk/openai-compatible",
        name: input.displayName.trim(),
        options: {
          baseURL: input.baseUrl.trim(),
          apiKey: `{env:${input.apiKeyVariableName}}`,
        },
        models: Object.fromEntries(input.models.map((model) => [model, { name: model }])),
      },
    },
  });
}

const apiKeyVariable = (
  name: string,
  value: string | SecretReference,
): ProviderInstanceEnvironmentVariable | undefined =>
  typeof value === "string" && value.trim().length === 0
    ? undefined
    : {
        name,
        value: typeof value === "string" ? value.trim() : value,
        sensitive: true,
      };

export function buildCustomProviderInstance(input: {
  readonly draft: CustomProviderDraft;
  readonly instanceId: string;
}): ProviderInstanceConfig {
  const { draft, instanceId } = input;
  const displayName = draft.displayName.trim();
  const models = parseCustomProviderModels(draft.modelsText);
  if (draft.kind === "anthropic") {
    const authVariable = apiKeyVariable("ANTHROPIC_AUTH_TOKEN", draft.apiKey);
    return {
      driver: ANTHROPIC_COMPAT_DRIVER,
      enabled: true,
      ...(displayName ? { displayName } : {}),
      config: {
        homePath: customProviderHomePath(instanceId),
        customModels: models,
      },
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: draft.baseUrl.trim(), sensitive: false },
        ...(authVariable ? [authVariable] : []),
        // An explicit empty key keeps an inherited one from reaching the relay.
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
    };
  }
  const apiKeyVariableName = customApiKeyVariableName(instanceId);
  const keyVariable = apiKeyVariable(apiKeyVariableName, draft.apiKey);
  return {
    driver: OPENAI_COMPAT_DRIVER,
    enabled: true,
    ...(displayName ? { displayName } : {}),
    config: {
      binaryPath: draft.binaryPath.trim() || KILO_DEFAULT_BINARY_PATH,
      customModels: models,
    },
    environment: [
      {
        name: "KILO_CONFIG_CONTENT",
        value: buildKiloConfigContent({
          instanceId,
          displayName,
          baseUrl: draft.baseUrl,
          models,
          apiKeyVariableName,
        }),
        sensitive: false,
      },
      ...(keyVariable ? [keyVariable] : []),
    ],
  };
}
