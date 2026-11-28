// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import type { ThreadId } from "@s8code/contracts";
import { scopeProjectRef, scopeThreadRef } from "@s8code/client-runtime/environment";
import { projectScriptCwd } from "@s8code/shared/projectScripts";
import { formatTokens } from "@s8code/shared/usageFormat";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  FileDiffIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useGT } from "gt-react";

import { buildThreadRouteParams } from "~/threadRoutes";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import {
  useAssistantMessageText,
  useProject,
  useThreadProjection,
  useTimelineVisibleTurnItems,
} from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import ChatMarkdown from "../ChatMarkdown";
import {
  closeModelCompare,
  fanoutCompareGroupsAtom,
  openCompareGroupIdAtom,
  type FanoutCompareGroup,
} from "./compareGroup";
import {
  compareColumnStatus,
  deriveCompareColumnEntries,
  summarizeCompareUsage,
  type CompareColumnEntry,
  type CompareColumnWorkKind,
} from "./compareGroup.logic";

/** Hosted once at the root, so the multiple-model send toast can open it from anywhere. */
export function ModelCompareDialogHost() {
  const groupId = useAtomValue(openCompareGroupIdAtom);
  const groups = useAtomValue(fanoutCompareGroupsAtom);
  const group =
    groupId === null ? null : (groups.find((entry) => entry.groupId === groupId) ?? null);
  return group === null ? null : <ModelCompareDialog group={group} />;
}

function ModelCompareDialog({ group }: { readonly group: FanoutCompareGroup }) {
  const close = () => closeModelCompare();
  const navigate = useNavigate();
  const gt = useGT();
  const continueInThread = (threadId: ThreadId) => {
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(group.environmentId, threadId)),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-h-[80dvh] max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            <ModelCompareTitle group={group} />
          </DialogTitle>
          <DialogDescription>
            {gt("Compare each model's answer, then continue in one thread.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className="grid gap-px overflow-hidden rounded-lg border border-border bg-border"
            style={{ gridTemplateColumns: `repeat(${group.threadIds.length}, minmax(0, 1fr))` }}
          >
            {group.threadIds.map((threadId) => (
              <CompareColumn
                key={threadId}
                environmentId={group.environmentId}
                threadId={threadId}
                onContinue={continueInThread}
              />
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ModelCompareTitle({ group }: { readonly group: FanoutCompareGroup }) {
  const gt = useGT();
  const firstThreadId = group.threadIds[0];
  const firstThread = useThreadProjection(
    firstThreadId === undefined ? null : scopeThreadRef(group.environmentId, firstThreadId),
  );
  const title = firstThread?.projection.thread.title;
  return title ?? <>{gt("Model comparison")}</>;
}

type CompareColumnProps = {
  readonly environmentId: FanoutCompareGroup["environmentId"];
  readonly threadId: ThreadId;
  readonly onContinue: (threadId: ThreadId) => void;
};

function CompareColumn({ environmentId, threadId, onContinue }: CompareColumnProps) {
  const gt = useGT();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadProjection(threadRef);
  const items = useTimelineVisibleTurnItems(threadRef);
  const providersByEnvironment = useEnvironmentProviders();
  const projection = thread?.projection ?? null;
  const entries = deriveCompareColumnEntries(items);
  const status = compareColumnStatus(projection?.runs ?? []);
  const usage = projection === null ? null : summarizeCompareUsage(projection.providerTurns);
  const projectId = projection?.thread.projectId ?? null;
  const project = useProject(projectId === null ? null : scopeProjectRef(environmentId, projectId));
  const cwd =
    project === null || projection === null
      ? undefined
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: projection.thread.worktreePath,
        });

  const providerEntry = projection
    ? deriveProviderInstanceEntries(providersByEnvironment.get(environmentId) ?? []).find(
        (entry) => entry.instanceId === projection.thread.modelSelection.instanceId,
      )
    : undefined;
  const modelLabel =
    providerEntry?.models.find((model) => model.slug === projection?.thread.modelSelection.model)
      ?.name ?? projection?.thread.modelSelection.model;

  return (
    <div className="flex min-w-0 flex-col bg-background">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-2.5">
        <ColumnStatusIcon status={status} />
        <span className="min-w-0 truncate text-sm font-medium">{modelLabel}</span>
        {usage !== null && (usage.inputTokens > 0 || usage.outputTokens > 0) ? (
          <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
            {gt("In {in} · Out {out}", {
              in: formatTokens(usage.inputTokens),
              out: formatTokens(usage.outputTokens),
            })}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3" data-thread-find-text="true">
        {entries.length === 0 ? (
          status === "running" ? (
            <p className="text-muted-foreground text-sm">{gt("Waiting for a response")}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{gt("(empty response)")}</p>
          )
        ) : (
          entries.map((entry) => {
            if (entry.kind === "assistant") {
              const row = items.find((row) => row.item.id === entry.itemId);
              return (
                <CompareAssistantEntry
                  key={entry.itemId}
                  environmentId={environmentId}
                  threadId={threadId}
                  entry={entry}
                  cwd={cwd}
                  text={row?.item.type === "assistant_message" ? row.item.text : ""}
                />
              );
            }
            if (entry.kind === "error")
              return <CompareErrorEntry key={entry.itemId} entry={entry} />;
            return <CompareWorkEntry key={entry.itemId} entry={entry} />;
          })
        )}
      </div>
      <div className="border-t px-4 py-2.5">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={status === "running" || projection === null}
          onClick={() => onContinue(threadId)}
        >
          {gt("Continue here")}
        </Button>
      </div>
    </div>
  );
}

function ColumnStatusIcon({ status }: { readonly status: ReturnType<typeof compareColumnStatus> }) {
  if (status === "running") return <Spinner className="size-3.5" />;
  return status === "failed" ? (
    <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
  ) : (
    <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
  );
}

function CompareAssistantEntry({
  environmentId,
  threadId,
  entry,
  cwd,
  text,
}: {
  readonly environmentId: FanoutCompareGroup["environmentId"];
  readonly threadId: ThreadId;
  readonly entry: Extract<CompareColumnEntry, { readonly kind: "assistant" }>;
  readonly cwd: string | undefined;
  readonly text: string;
}) {
  const gt = useGT();
  const liveText = useAssistantMessageText(
    entry.streaming ? scopeThreadRef(environmentId, threadId) : null,
    entry.itemId,
  );
  const messageText = (liveText ?? text) || (entry.streaming ? "" : gt("(empty response)"));
  return (
    <div className="min-w-0">
      <ChatMarkdown
        text={messageText}
        cwd={cwd}
        isStreaming={entry.streaming}
        streamingId={entry.itemId}
      />
      {entry.interrupted ? (
        <p className="mt-1.5 text-muted-foreground text-xs">{gt("Interrupted")}</p>
      ) : null}
    </div>
  );
}

function CompareErrorEntry({
  entry,
}: {
  readonly entry: Extract<CompareColumnEntry, { readonly kind: "error" }>;
}) {
  return (
    <div className="flex items-start gap-1.5 text-destructive text-xs">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 break-words">{entry.failure.message}</p>
    </div>
  );
}

const WORK_ICON_BY_KIND: Record<CompareColumnWorkKind, typeof TerminalIcon> = {
  command: TerminalIcon,
  file: FileDiffIcon,
  tool: WrenchIcon,
};

function CompareWorkEntry({
  entry,
}: {
  readonly entry: Extract<CompareColumnEntry, { readonly kind: "work" }>;
}) {
  const Icon = WORK_ICON_BY_KIND[entry.workKind];
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{entry.label}</span>
      {entry.running ? <Spinner className="ms-auto size-3 shrink-0" /> : null}
    </div>
  );
}
