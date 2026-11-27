// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { ProviderDriverKind, type ProviderInstanceConfig } from "@s8code/contracts";
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

const OPENAI_COMPAT_DRIVER = ProviderDriverKind.make("opencode");

// The OpenCode settings schema decodes an omitted binaryPath as "opencode", so a Kilo
// instance must name the kilo binary itself.
const KILO_DEFAULT_BINARY_PATH = "kilo";

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

/** What keeps a kilo.jsonc from importing; lines and ids let each caller phrase its own message. */
export type KiloConfigProblem =
  | { readonly reason: "empty" }
  | { readonly reason: "syntax"; readonly line: number; readonly detail: string }
  | { readonly reason: "not_object" }
  | { readonly reason: "no_provider_section" }
  | { readonly reason: "entry_not_object"; readonly id: string; readonly line: number }
  | { readonly reason: "missing_base_url"; readonly id: string; readonly line: number }
  | { readonly reason: "bad_base_url"; readonly id: string; readonly line: number }
  | { readonly reason: "models_not_object"; readonly id: string; readonly line: number };

export type ParsedKiloConfigResult =
  | { readonly ok: true; readonly config: ParsedKiloConfig }
  | { readonly ok: false; readonly problem: KiloConfigProblem };

export const readRecord = (value: unknown): Record<string, unknown> | undefined =>
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
): KiloConfigProblem | null => {
  const line = kiloEntryLine(text, tree, id);
  const block = readRecord(value);
  if (!block) {
    return { reason: "entry_not_object", id, line };
  }
  const options = readRecord(block.options);
  const baseURL = options?.baseURL;
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    return { reason: "missing_base_url", id, line };
  }
  const endpoint = URL.parse(baseURL.trim());
  if (endpoint === null || !/^https?:$/.test(endpoint.protocol)) {
    return { reason: "bad_base_url", id, line };
  }
  if (block.models !== undefined && readRecord(block.models) === undefined) {
    return { reason: "models_not_object", id, line };
  }
  return null;
};

/** Parses a kilo.jsonc (or opencode config) text, comments and trailing commas allowed. */
export function parseKiloConfig(text: string): ParsedKiloConfigResult {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      ok: false,
      problem: {
        reason: "syntax",
        line: lineAtOffset(text, first.offset),
        detail: printParseErrorCode(first.error),
      },
    };
  }
  if (tree === undefined) {
    return { ok: false, problem: { reason: "empty" } };
  }
  const root = readRecord(getNodeValue(tree));
  if (!root) {
    return { ok: false, problem: { reason: "not_object" } };
  }
  const agentBlock = readRecord(root.agent);
  const providerSection = readRecord(root.provider);
  if (!providerSection) {
    return { ok: false, problem: { reason: "no_provider_section" } };
  }
  const providers: ParsedKiloProvider[] = [];
  for (const [id, value] of Object.entries(providerSection)) {
    const problem = kiloProviderEntryProblem(text, tree, id, value);
    if (problem !== null) return { ok: false, problem };
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

/** One name shared by the key variable and the config JSON's `{env:}` reference. */
export function customApiKeyVariableName(instanceId: string): string {
  return `S8_CUSTOM_${instanceId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
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
