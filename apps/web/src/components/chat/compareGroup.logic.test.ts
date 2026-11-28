// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ThreadId,
} from "@s8code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { fanoutCompareGroupsAtom, recordFanoutCompareGroup } from "./compareGroup";
import {
  compareColumnStatus,
  deriveCompareColumnEntries,
  summarizeCompareUsage,
} from "./compareGroup.logic";

const NOW = DateTime.makeUnsafe("2026-11-28T00:00:00.000Z");
const threadId = (suffix: string) => `thread-${suffix}` as never as ThreadId;

function run(status: OrchestrationV2Run["status"], ordinal: number): OrchestrationV2Run {
  return { id: `run-${ordinal}` as never, status, ordinal } as never;
}

function providerTurn(
  usage: OrchestrationV2ProviderTurn["turnTokenUsage"],
): OrchestrationV2ProviderTurn {
  return { id: `turn-${Math.random()}` as never, turnTokenUsage: usage } as never;
}

function projectedItem(
  item: OrchestrationV2ProjectedTurnItem["item"],
): OrchestrationV2ProjectedTurnItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId("a"),
    sourceItemId: item.id,
    item,
  };
}

function assistantItem(input: {
  readonly id: string;
  readonly text: string;
  readonly streaming?: boolean;
  readonly status?: OrchestrationV2ProjectedTurnItem["item"]["status"];
}): OrchestrationV2ProjectedTurnItem {
  return projectedItem({
    id: input.id as never,
    type: "assistant_message",
    threadId: threadId("a"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: input.status ?? "completed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    messageId: `message-${input.id}` as never,
    text: input.text,
    textOmitted: false as never,
    streaming: input.streaming ?? false,
  });
}

function errorItem(id: string, message: string): OrchestrationV2ProjectedTurnItem {
  return projectedItem({
    id: id as never,
    type: "error",
    threadId: threadId("a"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    failure: { class: "provider_error", message, code: null, retryable: null },
  });
}

function commandItem(id: string, input: string): OrchestrationV2ProjectedTurnItem {
  return projectedItem({
    id: id as never,
    type: "command_execution",
    threadId: threadId("a"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    input,
  });
}

describe("compareColumnStatus", () => {
  it("keeps a column running while any run is active", () => {
    expect(compareColumnStatus([run("completed", 1), run("running", 2)])).toBe("running");
  });

  it("fails a column only from its newest finished run", () => {
    expect(compareColumnStatus([run("completed", 1), run("failed", 2)])).toBe("failed");
    expect(compareColumnStatus([run("failed", 1), run("completed", 2)])).toBe("completed");
  });

  it("reads a thread with no runs as completed, not failed", () => {
    expect(compareColumnStatus([])).toBe("completed");
  });
});

describe("summarizeCompareUsage", () => {
  it("sums per-turn counts across the thread's turns", () => {
    expect(
      summarizeCompareUsage([
        providerTurn({
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 30,
          hasSubagents: false,
        }),
        providerTurn({
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 80,
          outputTokens: 70,
          reasoningTokens: 20,
          hasSubagents: true,
        }),
      ]),
    ).toEqual({ inputTokens: 200, outputTokens: 100, complete: true });
  });

  it("marks a summary incomplete while a turn reports partial counts", () => {
    expect(
      summarizeCompareUsage([
        providerTurn({
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 120,
          outputTokens: 30,
          hasSubagents: false,
        }),
        providerTurn({
          usageScope: "main_agent",
          usageStatus: "partial",
          inputTokens: 10,
          outputTokens: undefined,
          hasSubagents: false,
        }),
        providerTurn({ usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false }),
      ]),
    ).toEqual({ inputTokens: 130, outputTokens: 30, complete: false });
  });

  it("is null before any turn reports usage", () => {
    expect(summarizeCompareUsage([providerTurn(undefined)])).toBeNull();
    expect(summarizeCompareUsage([])).toBeNull();
  });
});

describe("deriveCompareColumnEntries", () => {
  it("assembles answers and errors in timeline order, folding work into rows", () => {
    const entries = deriveCompareColumnEntries([
      projectedItem({
        id: "user" as never,
        type: "user_message",
        threadId: threadId("a"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
        createdBy: "user",
        creationSource: "web",
        messageId: "message-user" as never,
        workflowScript: undefined,
        freshContext: undefined,
        inputIntent: "turn_start",
        text: "prompt",
        textOmitted: false as never,
        attachments: [],
      }),
      commandItem("cmd", "pnpm test\nverbose output"),
      assistantItem({ id: "a1", text: "answer" }),
      errorItem("err", "rate limited"),
    ]);
    expect(entries).toEqual([
      { kind: "work", itemId: "cmd", workKind: "command", label: "pnpm test", running: false },
      { kind: "assistant", itemId: "a1", streaming: false, interrupted: false, empty: false },
      {
        kind: "error",
        itemId: "err",
        failure: { class: "provider_error", message: "rate limited", code: null, retryable: null },
      },
    ]);
  });

  it("reads a finished empty message as the timeline's empty response", () => {
    const entries = deriveCompareColumnEntries([assistantItem({ id: "a1", text: "  " })]);
    expect(entries).toEqual([
      { kind: "assistant", itemId: "a1", streaming: false, interrupted: false, empty: true },
    ]);
  });

  it("keeps a streaming empty message out of the empty state", () => {
    const entries = deriveCompareColumnEntries([
      assistantItem({ id: "a1", text: "", streaming: true, status: "running" }),
    ]);
    expect(entries[0]).toEqual({
      kind: "assistant",
      itemId: "a1",
      streaming: true,
      interrupted: false,
      empty: false,
    });
  });

  it("skips reasoning items", () => {
    const entries = deriveCompareColumnEntries([
      projectedItem({
        id: "r1" as never,
        type: "reasoning",
        threadId: threadId("a"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
        text: "thinking",
        streaming: false,
      }),
      assistantItem({ id: "a1", text: "answer" }),
    ]);
    expect(entries.map((entry) => entry.itemId)).toEqual(["a1"]);
  });
});

describe("recordFanoutCompareGroup", () => {
  it("records a group of two or more threads in send order", () => {
    const group = {
      groupId: "group-1",
      environmentId: "env" as never,
      threadIds: [threadId("a"), threadId("b")],
      startedAt: 0,
    };
    expect(recordFanoutCompareGroup(group)).toEqual(group);
    expect(
      appAtomRegistry.get(fanoutCompareGroupsAtom).find((entry) => entry.groupId === "group-1"),
    ).toEqual(group);
  });

  it("keeps a single-model send out of the comparison groups", () => {
    expect(
      recordFanoutCompareGroup({
        groupId: "group-2",
        environmentId: "env" as never,
        threadIds: [],
        startedAt: 0,
      }),
    ).toBeNull();
    expect(
      recordFanoutCompareGroup({
        groupId: "group-2",
        environmentId: "env" as never,
        threadIds: [threadId("a")],
        startedAt: 0,
      }),
    ).toBeNull();
    expect(
      appAtomRegistry.get(fanoutCompareGroupsAtom).some((entry) => entry.groupId === "group-2"),
    ).toBe(false);
  });
});
