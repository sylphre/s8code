import type { PullRequestChangeBreakdown } from "@s8code/contracts";
import { summarizeChangedFiles } from "@s8code/shared/changedFileKind";
import type { ProviderFileStats } from "@s8code/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}
