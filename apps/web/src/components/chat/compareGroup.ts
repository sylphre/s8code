// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import type { EnvironmentId, ThreadId } from "@s8code/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type FanoutCompareGroup = {
  readonly groupId: string;
  readonly environmentId: EnvironmentId;
  /** Threads in send order, one per model that started. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly startedAt: number;
};

// Session state: a comparison lives while the tab that sent it does. After a
// reload the fanout threads keep working as separate background threads.
const MAX_COMPARE_GROUPS = 8;

export const fanoutCompareGroupsAtom = Atom.make<ReadonlyArray<FanoutCompareGroup>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:fanout-compare-groups"),
);

export function recordFanoutCompareGroup(group: FanoutCompareGroup): FanoutCompareGroup | null {
  if (group.threadIds.length < 2) return null;
  const next = [
    ...appAtomRegistry
      .get(fanoutCompareGroupsAtom)
      .filter((entry) => entry.groupId !== group.groupId),
    group,
  ];
  appAtomRegistry.set(
    fanoutCompareGroupsAtom,
    next.slice(Math.max(0, next.length - MAX_COMPARE_GROUPS)),
  );
  return group;
}

const openCompareGroupAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:open-compare-group"),
);

export function openModelCompare(groupId: string): void {
  appAtomRegistry.set(openCompareGroupAtom, groupId);
}

export function closeModelCompare(): void {
  appAtomRegistry.set(openCompareGroupAtom, null);
}

export const openCompareGroupIdAtom = openCompareGroupAtom;
