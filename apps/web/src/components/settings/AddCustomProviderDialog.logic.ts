// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
} from "@s8code/contracts";
import {
  customApiKeyVariableName,
  parseKiloConfig,
  readRecord,
  type KiloConfigProblem,
  type ParsedKiloConfig,
} from "@s8code/shared/kiloImport";
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

/** Appends candidates a user has not listed yet, keeping the lines they typed where they are. */
export function mergeModelIds(existing: string, candidates: ReadonlyArray<string>): string {
  const present = new Set(parseCustomProviderModels(existing));
  const appended = candidates.filter(
    (model) => model.trim().length > 0 && !present.has(model.trim()),
  );
  return [...parseCustomProviderModels(existing), ...appended].join("\n");
}

/** The endpoint the wizard can ask a relay for model ids; undefined when the Base URL is unusable. */
export function compatibleModelsEndpoint(
  kind: CustomProviderKind,
  baseUrl: string,
): string | undefined {
  const endpoint = URL.parse(baseUrl.trim());
  if (endpoint === null || !/^https?:$/.test(endpoint.protocol)) return undefined;
  const path = kind === "anthropic" ? "v1/models" : "models";
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/${path}${endpoint.search}`;
}

// A secret provider reference cannot be read in the browser, so these requests go out without it.
export function compatibleModelsHeaders(
  kind: CustomProviderKind,
  apiKey: string | null,
): Record<string, string> {
  if (apiKey === null || apiKey.length === 0) return {};
  return kind === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

/** Reads OpenAI `{data:[{id}]}`, Anthropic `{data:[{id}]}` and bare-array responses. */
export function parseModelCatalogResponse(payload: unknown): ReadonlyArray<string> {
  const entries = readRecord(payload)?.data ?? payload;
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  for (const entry of entries) {
    const id = readRecord(entry)?.id;
    if (typeof id === "string" && id.trim().length > 0 && !ids.includes(id.trim())) {
      ids.push(id.trim());
    }
  }
  return ids;
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

export type { ParsedKiloConfig, ParsedKiloProvider } from "@s8code/shared/kiloImport";
export { buildKiloImportInstance, customApiKeyVariableName } from "@s8code/shared/kiloImport";

export type KiloImportParseResult =
  | { readonly ok: true; readonly config: ParsedKiloConfig }
  | { readonly ok: false; readonly error: string };

const kiloProblemMessage = (problem: KiloConfigProblem, resolve: MessageResolver): string => {
  switch (problem.reason) {
    case "syntax":
      return resolve(
        msg("Line {line}: {error} in the pasted config.", {
          line: problem.line,
          error: problem.detail,
        }),
      );
    case "empty":
      return resolve(msg("Paste the contents of kilo.jsonc."));
    case "not_object":
      return resolve(msg("The pasted config must be a JSON object."));
    case "no_provider_section":
      return resolve(msg('The pasted config has no "provider" section to import.'));
    case "entry_not_object":
      return resolve(
        msg('Line {line}: provider "{id}" must be an object.', {
          line: problem.line,
          id: problem.id,
        }),
      );
    case "missing_base_url":
      return resolve(
        msg('Line {line}: provider "{id}" needs a "baseURL" in its "options".', {
          line: problem.line,
          id: problem.id,
        }),
      );
    case "bad_base_url":
      return resolve(
        msg('Line {line}: provider "{id}" has a URL in "options.baseURL" that is not http(s).', {
          line: problem.line,
          id: problem.id,
        }),
      );
    case "models_not_object":
      return resolve(
        msg('Line {line}: provider "{id}" has a "models" section that is not an object.', {
          line: problem.line,
          id: problem.id,
        }),
      );
  }
};

/** Client-side read of a pasted kilo.jsonc, with the problem phrased for this dialog. */
export function parseKiloConfigContent(
  text: string,
  resolve: MessageResolver = m,
): KiloImportParseResult {
  const result = parseKiloConfig(text);
  if (result.ok) return result;
  return { ok: false, error: kiloProblemMessage(result.problem, resolve) };
}
