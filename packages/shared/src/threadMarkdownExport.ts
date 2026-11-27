// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.

import type { ChatAttachment, OrchestrationV2ProjectedTurnItem } from "@s8code/contracts";

import { splitsSurrogatePair } from "./assistantCitations.ts";

export interface ThreadMarkdownExportMeta {
  readonly title: string;
  /** ISO 8601, already formatted by the caller. */
  readonly createdAt: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly project: string | null;
  readonly folder: string | null;
}

/** One-line tool summaries keep the target readable without embedding arguments or diffs. */
const TOOL_SUMMARY_MAX_CHARS = 120;

function truncateSummary(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length <= TOOL_SUMMARY_MAX_CHARS) return line;
  return `${line.slice(
    0,
    splitsSurrogatePair(line, TOOL_SUMMARY_MAX_CHARS)
      ? TOOL_SUMMARY_MAX_CHARS - 1
      : TOOL_SUMMARY_MAX_CHARS,
  )}…`;
}

function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function commandStatus(item: {
  readonly output?: string | undefined;
  readonly outputOmitted?: boolean | undefined;
  readonly outputIndicatesFailure?: boolean | undefined;
  readonly exitCode?: number | undefined;
}): string {
  const failed =
    item.outputIndicatesFailure === true || (item.exitCode !== undefined && item.exitCode !== 0);
  if (failed) return item.exitCode === undefined ? "failed" : `failed (exit ${item.exitCode})`;
  return item.exitCode !== undefined || item.output !== undefined || item.outputOmitted === true
    ? "succeeded"
    : "";
}

function attachmentLines(attachments: ReadonlyArray<ChatAttachment> | undefined): string[] {
  return (attachments ?? []).map((attachment) => `- Attachment: ${attachment.name}`);
}

function toolLines(item: OrchestrationV2ProjectedTurnItem["item"]): string[] {
  switch (item.type) {
    case "command_execution": {
      const status = commandStatus(item);
      const command = truncateSummary(item.input);
      if (!command) return [];
      return [`- Command ${inlineCode(command)}${status ? ` ${status}` : ""}`];
    }
    case "file_change": {
      const counts =
        item.additions === undefined && item.deletions === undefined
          ? ""
          : ` (+${item.additions ?? 0} -${item.deletions ?? 0})`;
      return [`- Changed ${inlineCode(truncateSummary(item.fileName))}${counts}`];
    }
    case "file_search":
      return [
        item.pattern
          ? `- Searched files ${inlineCode(truncateSummary(item.pattern))}`
          : "- Searched files",
      ];
    case "web_search": {
      const queries = (item.patterns ?? []).map((pattern) => `"${truncateSummary(pattern)}"`);
      return [queries.length > 0 ? `- Web search: ${queries.join(", ")}` : "- Web search"];
    }
    case "dynamic_tool":
      return [item.toolName ? `- Tool ${inlineCode(item.toolName)}` : "- Tool call"];
    case "subagent": {
      const prompt = truncateSummary(item.prompt);
      return [
        prompt
          ? `- Task ${inlineCode(prompt)}${item.result === null ? "" : " completed"}`
          : "- Task",
      ];
    }
    default:
      return [];
  }
}

function messageSection(
  heading: "User" | "Assistant",
  text: string,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): string[] {
  const lines = [`## ${heading}`, ""];
  if (text.length > 0) lines.push(text);
  lines.push(...attachmentLines(attachments));
  return lines;
}

/**
 * The thread as a standalone Markdown document: the title and where it ran, then the
 * conversation with one-line tool summaries. Message bodies pass through verbatim, and
 * reasoning is not exported.
 */
export function threadMarkdownExport(
  meta: ThreadMarkdownExportMeta,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): string {
  const metaLines = [
    `- Created: ${meta.createdAt}`,
    ...(meta.provider ? [`- Provider: ${meta.provider}`] : []),
    ...(meta.model ? [`- Model: ${meta.model}`] : []),
    ...(meta.project ? [`- Project: ${meta.project}`] : []),
    ...(meta.folder ? [`- Folder: ${meta.folder}`] : []),
  ];
  const lines: Array<string> = [`# ${meta.title}`, "", ...metaLines];
  for (const row of items) {
    const item = row.item;
    switch (item.type) {
      case "user_message":
        lines.push("", ...messageSection("User", item.text, item.attachments));
        break;
      case "assistant_message":
        lines.push("", ...messageSection("Assistant", item.text, item.attachments));
        break;
      default:
        lines.push(...toolLines(item));
        break;
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The thread title as `<title>.md`, with filename-unsafe characters replaced. */
export function markdownExportFileName(title: string): string {
  const sanitized = title.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const truncated = sanitized.slice(0, splitsSurrogatePair(sanitized, 64) ? 63 : 64).trim();
  return `${truncated || "Thread"}.md`;
}
