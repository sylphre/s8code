import { thrownErrorMessage } from "@s8code/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { settlePromise, squashAtomCommandFailure } from "@s8code/client-runtime/state/runtime";
import type { DesktopUpdateChannel } from "@s8code/contracts";
import { acceptsTrackSwitchRelease, desktopUpdateChannelOf } from "@s8code/shared/cliRelease";
import { isMacPlatform } from "@s8code/shared/keybindings";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { isElectron } from "~/env";
import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { npmReleaseAtom, npmReleaseFailureMessage } from "~/state/npmRelease";
import { downloadLocalUpdate, installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import {
  channelSwitchLabel,
  localSwitchBlockReason,
  localUpdaterStaysPut,
  nothingToMove,
  prepareLocalTrackSwitch,
  type ChannelSwitchRelease,
} from "./updateTrackSwitch.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Servers this desktop app runs; they update with it. */
function isHostedByThisApp(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
) {
  return (
    isElectron &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target))
  );
}

/** Moves this app to `channel`; the machines it hosts restart with it. */
export function UpdateTrackSwitchDialog({
  channel,
  onClose,
}: {
  readonly channel: DesktopUpdateChannel;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  // npm dist-tags match the desktop channel names.
  const release = useAtomValue(npmReleaseAtom(channel));
  if (AsyncResult.isSuccess(release) && release.value !== null) {
    return <SwitchPlan release={{ channel, ...release.value }} onClose={onClose} />;
  }
  const label = channelSwitchLabel(channel, m);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>
              Switch to <Var>{label}</Var>
            </T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {AsyncResult.isFailure(release)
              ? npmReleaseFailureMessage(release.cause, m)
              : AsyncResult.isSuccess(release)
                ? gt(
                    "Could not find the latest {label} release in this environment's npm registry.",
                    {
                      label,
                    },
                  )
                : gt("Checking releases…")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SwitchPlan({
  release,
  onClose,
}: {
  readonly release: ChannelSwitchRelease;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const updateState = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const crossesLocal = desktopUpdateChannelOf(APP_VERSION) !== release.channel;
  const updatesOff = localUpdaterStaysPut(updateState, release.channel);
  // After a partial switch this app may already be on the track; then only remotes move.
  const switchesLocal = crossesLocal && !updatesOff;
  const [checking, setChecking] = useState(false);
  const label = channelSwitchLabel(release.channel, m);
  const idle = nothingToMove(
    {
      label,
      channel: release.channel,
      savedChannel: updateState?.channel ?? null,
      switchesLocal,
      crossesLocal,
    },
    m,
  );
  // This app's reinstall restarts every server it hosts, so each of their databases must allow it.
  const localBlocked = localSwitchBlockReason(
    APP_VERSION,
    release,
    environments.filter(isHostedByThisApp).map((environment) => ({
      connected: environment.connection.phase === "connected",
      databaseMigration: environment.serverConfig?.environment.databaseMigration,
    })),
    window.desktopBridge?.getLocalEnvironmentBootstraps().length ?? 0,
    !isLocalEnvironmentDisabled(),
    m,
  );

  const run = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Stay open while the feed is checked; the switch's own progress takes over after.
    setChecking(true);
    const fail = (description: string) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not switch to {label}", { label }),
          description,
        }),
      );
    const prepared = await prepareLocalTrackSwitch(bridge, {
      channel: release.channel,
      version: release.version,
      reinstall: switchesLocal,
    });
    onClose();
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const { local } = prepared;
    if (local === null) return;
    const result = await settlePromise(async () => {
      if (local.status === "available") {
        const downloaded = await downloadLocalUpdate(bridge, {
          notifyDownloaded: false,
          reportError: (title, description) => fail(`${title}: ${description}`),
        });
        if (!downloaded) return;
      }
      // Install only a build the database check covers, pinned so nothing replaces it.
      const { downloadedVersion } = await bridge.getUpdateState();
      if (
        downloadedVersion === null ||
        !acceptsTrackSwitchRelease(downloadedVersion, release.channel, release.version)
      ) {
        throw new Error(
          downloadedVersion === null
            ? gt("This app downloaded nothing, not {version} or newer.", {
                version: release.version,
              })
            : gt("This app downloaded {downloaded}, not {version} or newer.", {
                downloaded: downloadedVersion,
                version: release.version,
              }),
        );
      }
      await installLocalUpdate(
        bridge,
        (title, description) => fail(`${title}: ${description}`),
        downloadedVersion,
      );
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("An unexpected error occurred."),
      );
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !checking && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{gt("Switch to {label}?", { label })}</AlertDialogTitle>
          <AlertDialogDescription>
            S8 Code <span className="font-mono text-xs">{release.version}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-4">
          {idle.note !== null ? <p className="text-muted-foreground text-sm">{idle.note}</p> : null}
          {updatesOff ? (
            <p className="text-muted-foreground text-sm">
              {gt("This app's updates are off here, so reinstall it yourself to switch.")}
            </p>
          ) : null}
          {switchesLocal && isMacPlatform(navigator.platform) ? (
            <p className="text-muted-foreground text-sm">
              {gt("If S8 Code does not reopen after it restarts, open it again.")}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          {switchesLocal && localBlocked !== null ? (
            <p className="self-center text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
              {localBlocked}
            </p>
          ) : null}
          <AlertDialogClose render={<Button variant="outline" disabled={checking} />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            disabled={(switchesLocal && localBlocked !== null) || checking}
            onClick={() => void run()}
          >
            {checking ? gt("Checking…") : gt("Switch to {label}", { label })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
