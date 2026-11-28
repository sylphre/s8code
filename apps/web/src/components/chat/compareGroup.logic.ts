// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
} from "@s8code/contracts";

type CompareColumnStatus = "running" | "completed" | "failed";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * One thread's standing in the comparison: any active run keeps the column
 * running; otherwise the newest run decides between failed and completed.
 */
export function compareColumnStatus(runs: ReadonlyArray<OrchestrationV2Run>): CompareColumnStatus {
  let newest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) return "running";
    if (newest === null || run.ordinal > newest.ordinal) newest = run;
  }
  return newest?.status === "failed" ? "failed" : "completed";
}

type CompareUsageSummary = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** False while a turn has not reported its final counts. */
  readonly complete: boolean;
};

/** Per-turn token counts summed across the thread's provider turns, in Usage page units. */
export function summarizeCompareUsage(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): CompareUsageSummary | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let reported = false;
  let complete = true;
  for (const turn of turns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined) continue;
    reported = true;
    if (usage.usageStatus !== "complete") complete = false;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
  }
  return reported ? { inputTokens, outputTokens, complete } : null;
}

export type CompareColumnWorkKind = "command" | "file" | "tool";

export type CompareColumnEntry =
  | {
      readonly kind: "assistant";
      readonly itemId: string;
      readonly streaming: boolean;
      readonly interrupted: boolean;
      /** A finished message with no text renders the timeline's "(empty response)". */
      readonly empty: boolean;
    }
  | {
      readonly kind: "error";
      readonly itemId: string;
      readonly failure: OrchestrationV2ProviderFailure;
    }
  | {
      readonly kind: "work";
      readonly itemId: string;
      readonly workKind: CompareColumnWorkKind;
      readonly label: string;
      readonly running: boolean;
    };

const COMMAND_LABEL_MAX_LENGTH = 80;

function workKind(item: OrchestrationV2ProjectedTurnItem["item"]): CompareColumnWorkKind {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "file";
    default:
      return "tool";
  }
}

function workLabel(item: OrchestrationV2ProjectedTurnItem["item"]): string {
  switch (item.type) {
    case "command_execution": {
      const line = (item.title ?? item.input).split("\n", 1)[0] ?? "";
      const label = line.trim().length > 0 ? line.trim() : "command";
      return label.length > COMMAND_LABEL_MAX_LENGTH
        ? `${label.slice(0, COMMAND_LABEL_MAX_LENGTH)}…`
        : label;
    }
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? "file search";
    case "web_search":
      return item.patterns?.[0] ?? "web search";
    default:
      return item.title ?? item.type;
  }
}

/**
 * What one comparison column shows, in timeline order: the model's answers and
 * why a turn stopped, with everything else folded into one-line work rows.
 */
export function deriveCompareColumnEntries(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<CompareColumnEntry> {
  const entries: CompareColumnEntry[] = [];
  for (const { item } of items) {
    if (item.type === "assistant_message") {
      entries.push({
        kind: "assistant",
        itemId: item.id,
        streaming: item.streaming,
        interrupted: item.status === "interrupted",
        empty: !item.streaming && item.status === "completed" && item.text.trim().length === 0,
      });
      continue;
    }
    if (item.type === "error") {
      entries.push({ kind: "error", itemId: item.id, failure: item.failure });
      continue;
    }
    if (item.type === "user_message" || item.type === "reasoning") continue;
    entries.push({
      kind: "work",
      itemId: item.id,
      workKind: workKind(item),
      label: workLabel(item),
      running: item.status === "running" || item.status === "pending" || item.status === "waiting",
    });
  }
  return entries;
}
