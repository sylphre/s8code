import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@s8code/client-runtime/state/models";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}
