// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
} from "@s8code/contracts";
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";
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

export interface ParsedKiloProvider {
  readonly id: string;
  readonly name: string;
  readonly baseURL: string;
  readonly models: ReadonlyArray<string>;
  readonly block: Record<string, unknown>;
  readonly literalApiKey: string | null;
}

export interface ParsedKiloConfig {
  readonly providers: ReadonlyArray<ParsedKiloProvider>;
  readonly agentNames: ReadonlyArray<string>;
  readonly agentBlock: Record<string, unknown> | undefined;
}

export type KiloImportParseResult =
  | { readonly ok: true; readonly config: ParsedKiloConfig }
  | { readonly ok: false; readonly error: string };

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const lineAtOffset = (text: string, offset: number): number =>
  text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n").length;

const ENV_KEY_REFERENCE = /^\{env:.+\}$/;

const kiloEntryLine = (text: string, tree: Node | undefined, id: string): number => {
  const node = tree ? findNodeAtLocation(tree, ["provider", id]) : undefined;
  return node ? lineAtOffset(text, node.offset) : 1;
};

const kiloProviderEntryProblem = (
  text: string,
  tree: Node | undefined,
  id: string,
  value: unknown,
  resolve: MessageResolver,
): string | null => {
  const line = kiloEntryLine(text, tree, id);
  const block = readRecord(value);
  if (!block) {
    return resolve(msg('Line {line}: provider "{id}" must be an object.', { line, id }));
  }
  const options = readRecord(block.options);
  const baseURL = options?.baseURL;
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    return resolve(
      msg('Line {line}: provider "{id}" needs a "baseURL" in its "options".', { line, id }),
    );
  }
  const endpoint = URL.parse(baseURL.trim());
  if (endpoint === null || !/^https?:$/.test(endpoint.protocol)) {
    return resolve(
      msg('Line {line}: provider "{id}" has a URL in "options.baseURL" that is not http(s).', {
        line,
        id,
      }),
    );
  }
  if (block.models !== undefined && readRecord(block.models) === undefined) {
    return resolve(
      msg('Line {line}: provider "{id}" has a "models" section that is not an object.', {
        line,
        id,
      }),
    );
  }
  return null;
};

/** Client-side JSONC read of a pasted kilo.jsonc (or opencode config), comments and trailing commas allowed. */
export function parseKiloConfigContent(
  text: string,
  resolve: MessageResolver = m,
): KiloImportParseResult {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      ok: false,
      error: resolve(
        msg("Line {line}: {error} in the pasted config.", {
          line: lineAtOffset(text, first.offset),
          error: printParseErrorCode(first.error),
        }),
      ),
    };
  }
  if (tree === undefined) {
    return { ok: false, error: resolve(msg("Paste the contents of kilo.jsonc.")) };
  }
  const root = readRecord(getNodeValue(tree));
  if (!root) {
    return {
      ok: false,
      error: resolve(msg("The pasted config must be a JSON object.")),
    };
  }
  const agentBlock = readRecord(root.agent);
  const providerSection = readRecord(root.provider);
  if (!providerSection) {
    return {
      ok: false,
      error: resolve(msg('The pasted config has no "provider" section to import.')),
    };
  }
  const providers: ParsedKiloProvider[] = [];
  for (const [id, value] of Object.entries(providerSection)) {
    const problem = kiloProviderEntryProblem(text, tree, id, value, resolve);
    if (problem !== null) return { ok: false, error: problem };
    const block = readRecord(value)!;
    const options = readRecord(block.options)!;
    const baseURL = (options.baseURL as string).trim();
    const models = block.models
      ? Object.keys(block.models).filter((model) => model.trim().length > 0)
      : [];
    const rawApiKey = options.apiKey;
    const literalApiKey =
      typeof rawApiKey === "string" && !ENV_KEY_REFERENCE.test(rawApiKey.trim()) ? rawApiKey : null;
    const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : id;
    providers.push({ id, name, baseURL, models, block, literalApiKey });
  }
  return { ok: true, config: { providers, agentNames: Object.keys(agentBlock ?? {}), agentBlock } };
}

/** The spawned kilo serve only reads the pasted provider under its renamed key, so agent bindings follow. */
const rewriteKiloAgentModels = (
  agentBlock: Record<string, unknown>,
  fromProviderId: string,
  toProviderId: string,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(agentBlock).map(([name, definition]) => {
      const record = readRecord(definition);
      if (!record || typeof record.model !== "string") return [name, definition];
      return [
        name,
        record.model.startsWith(`${fromProviderId}/`)
          ? { ...record, model: `${toProviderId}${record.model.slice(fromProviderId.length)}` }
          : record,
      ];
    }),
  );

export function buildKiloImportInstance(input: {
  readonly provider: ParsedKiloProvider;
  readonly instanceId: string;
  readonly agentBlock: Record<string, unknown> | undefined;
  readonly binaryPath: string;
}): { readonly instance: ProviderInstanceConfig; readonly apiKeyValue: string | null } {
  const { provider, instanceId } = input;
  const options = { ...readRecord(provider.block.options) };
  const apiKeyValue = provider.literalApiKey?.trim() ?? null;
  if (apiKeyValue) {
    options.apiKey = `{env:${customApiKeyVariableName(instanceId)}}`;
  }
  const content = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(input.agentBlock
      ? {
          agent: rewriteKiloAgentModels(input.agentBlock, provider.id, `s8-${instanceId}`),
        }
      : {}),
    provider: {
      [`s8-${instanceId}`]: {
        ...provider.block,
        npm: "@ai-sdk/openai-compatible",
        options,
      },
    },
  });
  return {
    apiKeyValue,
    instance: {
      driver: OPENAI_COMPAT_DRIVER,
      enabled: true,
      displayName: provider.name,
      config: {
        binaryPath: input.binaryPath.trim() || KILO_DEFAULT_BINARY_PATH,
        customModels: provider.models,
      },
      environment: [
        { name: "KILO_CONFIG_CONTENT", value: content, sensitive: false },
        ...(apiKeyValue
          ? [
              {
                name: customApiKeyVariableName(instanceId),
                value: apiKeyValue,
                sensitive: true,
              },
            ]
          : []),
      ],
    },
  };
}
