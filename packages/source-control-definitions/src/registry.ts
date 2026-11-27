import * as AzureDevOps from "@s8code/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@s8code/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@s8code/source-control-core/shared/definition";
import * as CursorOrigin from "@s8code/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@s8code/source-control-forgejo/shared/definition";
import * as GitCafe from "@s8code/source-control-gitcafe/shared/definition";
import * as GitHub from "@s8code/source-control-github/shared/definition";
import * as GitLab from "@s8code/source-control-gitlab/shared/definition";
import * as TanStackSource from "@s8code/source-control-tanstack-source/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@s8code/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first as the client default for unknown hosts. GitCafe, TanStack Source and Origin
 * claim URLs first: GitHub and Forgejo accept the same routes on any hostname. TanStack Source is a
 * private beta: every reader knows its URLs, and only a server with its flag on offers the forge.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    CursorOrigin.definition,
    GitLab.definition,
    GitCafe.definition,
    TanStackSource.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      GitCafe.definition.kind,
      TanStackSource.definition.kind,
      CursorOrigin.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      TanStackSource.definition.kind,
      CursorOrigin.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
