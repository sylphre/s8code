// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import {
  ChatAttachment,
  ChatAttachmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@s8code/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { markdownExportFileName, threadMarkdownExport } from "./threadMarkdownExport.ts";

const threadId = ThreadId.make("thread:export");
const noMeta = {
  provider: null,
  model: null,
  project: null,
  folder: null,
} as const;

let itemOrdinals = 0;
type TurnItemFixture = { readonly type: string } & Record<string, unknown>;
function projected(item: TurnItemFixture): OrchestrationV2ProjectedTurnItem {
  const ordinal = itemOrdinals++;
  const base = {
    id: TurnItemId.make(`item:${ordinal}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-28T09:00:00.000Z"),
  };
  return {
    position: ordinal,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: TurnItemId.make(`item:${ordinal}`),
    item: { ...base, ...item } as unknown as OrchestrationV2ProjectedTurnItem["item"],
  };
}

function userMessage(text: string, attachments: ChatAttachment[] = []) {
  return projected({
    type: "user_message",
    messageId: MessageId.make(`message:${itemOrdinals}`),
    freshContext: false,
    inputIntent: "turn_start",
    text,
    attachments,
  });
}

it("writes the title, meta bullets and alternating message sections", () => {
  const markdown = threadMarkdownExport(
    {
      title: "Fix the login bug",
      createdAt: "2026-11-28T09:00:00.000Z",
      provider: "Claude Code",
      model: "claude-sonnet-4-5",
      project: "S8 Code",
      folder: "/home/sylph/dev/s8",
    },
    [
      userMessage("Please fix the login bug."),
      projected({
        type: "assistant_message",
        messageId: MessageId.make("message:2"),
        text: "Fixed it.\n\nDetails below.",
        streaming: false,
      }),
    ],
  );
  expect(markdown).toBe(
    [
      "# Fix the login bug",
      "",
      "- Created: 2026-11-28T09:00:00.000Z",
      "- Provider: Claude Code",
      "- Model: claude-sonnet-4-5",
      "- Project: S8 Code",
      "- Folder: /home/sylph/dev/s8",
      "",
      "## User",
      "",
      "Please fix the login bug.",
      "",
      "## Assistant",
      "",
      "Fixed it.",
      "",
      "Details below.",
      "",
    ].join("\n"),
  );
});

it("leaves message bodies untouched, including code fences and heading-like lines", () => {
  const markdown = threadMarkdownExport(
    { title: "t", createdAt: "2026-11-28T09:00:00.000Z", ...noMeta },
    [
      userMessage("Look:\n\n```md\n## not a section\n```\n\ndone"),
      projected({
        type: "assistant_message",
        messageId: MessageId.make("message:2"),
        text: "Body with a\n```\nfence ``` inside\n```\nend",
        streaming: false,
      }),
    ],
  );
  expect(markdown).toContain("Look:\n\n```md\n## not a section\n```\n\ndone");
  expect(markdown).toContain("Body with a\n```\nfence ``` inside\n```\nend");
  expect(markdown).not.toContain("- Command");
});

it("summarizes tool executions as one-line bullets", () => {
  const markdown = threadMarkdownExport(
    { title: "t", createdAt: "2026-11-28T09:00:00.000Z", ...noMeta },
    [
      projected({
        type: "command_execution",
        input: "npm test\n--watch",
        output: "ok",
        exitCode: 0,
      }),
      projected({
        type: "command_execution",
        input: "npm run build",
        output: "error",
        outputIndicatesFailure: true,
      }),
      projected({ type: "command_execution", input: "sleep 5" }),
      projected({ type: "file_change", fileName: "src/a.ts", additions: 12, deletions: 3 }),
      projected({ type: "file_change", fileName: "src/b.ts" }),
      projected({ type: "file_search", pattern: "**/*.test.ts" }),
      projected({ type: "web_search", patterns: ["s8 code fork", "t3 code"] }),
      projected({ type: "dynamic_tool", toolName: "read_docs", input: { path: "x" } }),
      projected({ type: "dynamic_tool", toolName: null, input: {} }),
      projected({
        type: "subagent",
        subagentId: NodeId.make("node:1"),
        origin: "provider_native",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        childThreadId: null,
        prompt: "Write tests",
        result: "Done",
      }),
      projected({
        type: "subagent",
        subagentId: NodeId.make("node:2"),
        origin: "app_owned",
        driver: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        childThreadId: null,
        prompt: "Still going",
        result: null,
      }),
    ],
  );
  expect(markdown).toBe(
    [
      "# t",
      "",
      "- Created: 2026-11-28T09:00:00.000Z",
      "- Command `npm test --watch` succeeded",
      "- Command `npm run build` failed",
      "- Command `sleep 5`",
      "- Changed `src/a.ts` (+12 -3)",
      "- Changed `src/b.ts`",
      "- Searched files `**/*.test.ts`",
      '- Web search: "s8 code fork", "t3 code"',
      "- Tool `read_docs`",
      "- Tool call",
      "- Task `Write tests` completed",
      "- Task `Still going`",
      "",
    ].join("\n"),
  );
});

it("truncates long tool targets and keeps the summary on one line", () => {
  const markdown = threadMarkdownExport(
    { title: "t", createdAt: "2026-11-28T09:00:00.000Z", ...noMeta },
    [
      projected({
        type: "command_execution",
        input: `${"a".repeat(200)} && echo done`,
        exitCode: 0,
      }),
      projected({ type: "command_execution", input: "has `backticks` in it", exitCode: 0 }),
    ],
  );
  expect(markdown).toContain(`- Command \`${"a".repeat(120)}…\` succeeded`);
  expect(markdown).toContain("- Command `has 'backticks' in it` succeeded");
});

it("lists attachment file names only", () => {
  const markdown = threadMarkdownExport(
    { title: "t", createdAt: "2026-11-28T09:00:00.000Z", ...noMeta },
    [
      projected({
        type: "user_message",
        messageId: MessageId.make("message:1"),
        freshContext: false,
        inputIntent: "turn_start",
        text: "See attached",
        attachments: [
          {
            type: "file",
            id: ChatAttachmentId.make("a1"),
            name: "log.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
          {
            type: "image",
            id: ChatAttachmentId.make("a2"),
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ],
      }),
      projected({
        type: "assistant_message",
        messageId: MessageId.make("message:2"),
        text: "",
        streaming: false,
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make("a3"),
            name: "chart.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ],
      }),
    ],
  );
  expect(markdown).toContain("- Attachment: log.txt");
  expect(markdown).toContain("- Attachment: shot.png");
  expect(markdown).toContain("- Attachment: chart.png");
  expect(markdown).not.toContain("data:");
});

it("falls back to the meta block for an empty thread and omits absent meta", () => {
  const empty = threadMarkdownExport(
    { title: "Fresh thread", createdAt: "2026-11-28T09:00:00.000Z", ...noMeta },
    [],
  );
  expect(empty).toBe("# Fresh thread\n\n- Created: 2026-11-28T09:00:00.000Z\n");
});

it("sanitizes download file names like the context attachment does", () => {
  expect(markdownExportFileName("My thread: <final>?")).toBe("My thread_ _final__.md");
  expect(markdownExportFileName("日本語のスレッド")).toBe("日本語のスレッド.md");
  expect(markdownExportFileName("")).toBe("Thread.md");
  expect(markdownExportFileName("   ")).toBe("Thread.md");
  expect(markdownExportFileName("x".repeat(100))).toBe(`${"x".repeat(64)}.md`);
  expect(markdownExportFileName("👨‍👩‍👧".repeat(40)).endsWith(".md")).toBe(true);
});
