// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import type {
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
} from "@s8code/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export interface ProviderTurnOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduled: boolean;
  readonly subagent: boolean;
}

export type ProviderTurnSegment =
  | OrchestrationV2RunAttempt["reason"]
  | "continuation"
  | "native_child";

export interface ProviderTurnAnalyticsContext {
  readonly runId?: RunId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly origin?: ProviderTurnOrigin;
  readonly segment?: ProviderTurnSegment;
  readonly restartContinuation?: boolean;
}

export interface ProviderTurnReport {
  readonly driver: string;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}

export interface RunSettledReport {
  readonly runId: RunId;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly completedAt: DateTime.Utc;
  readonly childrenRunning: boolean;
}

// Kept so upstream call sites still line up; nothing is recorded or sent.
export class ProviderTurnEvents extends Context.Reference<{
  readonly runStarted: (input: {
    readonly runId: RunId;
    readonly driver: string;
    readonly context: ProviderTurnAnalyticsContext;
  }) => Effect.Effect<void>;
  readonly turnCompleted: (report: ProviderTurnReport) => Effect.Effect<void>;
  readonly runSettled: (report: RunSettledReport) => Effect.Effect<void>;
}>("t3/providerTurnEvents", {
  defaultValue: () => ({
    runStarted: () => Effect.void,
    turnCompleted: () => Effect.void,
    runSettled: () => Effect.void,
  }),
}) {}
