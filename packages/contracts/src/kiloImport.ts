// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** Per-provider facts of a kilo.jsonc on the server host; a key's presence only, never its value. */
export const KiloConfigProviderSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  baseURL: Schema.String,
  models: Schema.Array(Schema.String),
  hasApiKey: Schema.Boolean,
});
export type KiloConfigProviderSummary = typeof KiloConfigProviderSummary.Type;

export const KiloConfigSummary = Schema.Struct({
  path: Schema.String,
  providers: Schema.Array(KiloConfigProviderSummary),
  agentNames: Schema.Array(Schema.String),
});
export type KiloConfigSummary = typeof KiloConfigSummary.Type;

export const KiloConfigReadFailureReason = Schema.Literals([
  "not_found",
  "not_readable",
  "not_file",
  "empty",
  "parse_error",
  "not_object",
  "no_provider_section",
  "entry_not_object",
  "missing_base_url",
  "bad_base_url",
  "models_not_object",
  "provider_not_found",
]);
export type KiloConfigReadFailureReason = typeof KiloConfigReadFailureReason.Type;

/** Carries the resolved path and the line or provider id the failure names, for the UI to phrase. */
const KiloConfigReadFailureFields = {
  reason: KiloConfigReadFailureReason,
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  providerId: Schema.optionalKey(Schema.String),
};

export const KiloConfigReadFailure = Schema.Struct(KiloConfigReadFailureFields);
export type KiloConfigReadFailure = typeof KiloConfigReadFailure.Type;

export const ReadKiloConfigSummaryInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
});
export type ReadKiloConfigSummaryInput = typeof ReadKiloConfigSummaryInput.Type;

export const ReadKiloConfigSummaryResult = Schema.Union([
  Schema.TaggedStruct("Ok", { summary: KiloConfigSummary }),
  Schema.TaggedStruct("Failed", KiloConfigReadFailureFields),
]);
export type ReadKiloConfigSummaryResult = typeof ReadKiloConfigSummaryResult.Type;

export const ImportKiloProvidersInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  providerIds: Schema.Array(Schema.String),
});
export type ImportKiloProvidersInput = typeof ImportKiloProvidersInput.Type;

export const ImportKiloProvidersResult = Schema.Union([
  Schema.TaggedStruct("Ok", { instanceIds: Schema.Array(ProviderInstanceId) }),
  Schema.TaggedStruct("Failed", KiloConfigReadFailureFields),
]);
export type ImportKiloProvidersResult = typeof ImportKiloProvidersResult.Type;
