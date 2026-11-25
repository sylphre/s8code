import { thrownErrorMessage } from "@s8code/client-runtime/errors";
import type { DesktopBridge, DesktopUpdateChannel, DesktopUpdateState } from "@s8code/contracts";
import { acceptsTrackSwitchRelease, desktopUpdateChannelOf } from "@s8code/shared/cliRelease";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

type TrackSwitchBridge = Pick<DesktopBridge, "setUpdateChannel">;

/** Saves the track, then, when this app must reinstall, finds a build the database check covers.
 * The saved track is the user's intent and stays even when no such build is ready yet: a track
 * saved toward Stable never offers an older build outside a guarded switch, and "Switch them"
 * retries. Saving when nothing reinstalls lets picking the old track undo a partial switch. */
export async function prepareLocalTrackSwitch(
  bridge: TrackSwitchBridge,
  input: {
    readonly channel: DesktopUpdateChannel;
    readonly version: string;
    readonly reinstall: boolean;
  },
): Promise<
  | { readonly ok: true; readonly local: DesktopUpdateState | null }
  | { readonly ok: false; readonly message: string }
> {
  let local: DesktopUpdateState;
  try {
    // A build on another track re-checks the feed, older releases allowed down to the checked one.
    local = await bridge.setUpdateChannel(
      input.channel,
      input.reinstall ? input.version : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : m(msg("The update track did not change.")),
    };
  }
  if (!input.reinstall) return { ok: true, local: null };
  const found = local.downloadedVersion ?? local.availableVersion;
  if (
    (local.status === "available" || local.status === "downloaded") &&
    found !== null &&
    acceptsTrackSwitchRelease(found, input.channel, input.version)
  ) {
    return { ok: true, local };
  }
  return {
    ok: false,
    message:
      found !== null
        ? m(
            msg(
              "This app found {found}, which is older than {version}. Try again in a few minutes.",
              { found, version: input.version },
            ),
          )
        : (local.message ??
          m(msg("This app found no build of {version} to install.", { version: input.version }))),
  };
}

/** The latest release on the track a switch moves this app to, as npm reports it. */
export interface ChannelSwitchRelease {
  readonly channel: DesktopUpdateChannel;
  readonly version: string;
  readonly databaseMigration: number | undefined;
}

/** Components pass `useMessages()` so labels follow a language switch. */
export const channelSwitchLabel = (channel: DesktopUpdateChannel, resolve: MessageResolver = m) =>
  channel === "nightly"
    ? resolve(msg("Nightly", { $context: "release track" }))
    : resolve(msg("Stable", { $context: "release track" }));

/** Stable and Nightly each build their own commits, so either can hold migrations the other lacks.
 * Crossing tracks needs proof that the target release knows every migration the database holds. */
const crossesTrack = (fromVersion: string, release: ChannelSwitchRelease) =>
  desktopUpdateChannelOf(fromVersion) !== release.channel;

type ChannelSwitchBlock = "server-predates-checks" | "release-predates-checks" | "unsupported";

function channelSwitchBlock(
  fromVersion: string,
  release: ChannelSwitchRelease,
  currentMigration: number | undefined,
): ChannelSwitchBlock | null {
  if (!crossesTrack(fromVersion, release)) return null;
  // Servers and releases from before this check report no migration number.
  if (currentMigration === undefined) return "server-predates-checks";
  if (release.databaseMigration === undefined) return "release-predates-checks";
  return currentMigration > release.databaseMigration ? "unsupported" : null;
}

function localChannelSwitchBlockReason(
  fromVersion: string,
  release: ChannelSwitchRelease,
  block: ChannelSwitchBlock,
  resolve: MessageResolver,
): string {
  const from = channelSwitchLabel(desktopUpdateChannelOf(fromVersion), resolve);
  const to = channelSwitchLabel(release.channel, resolve);
  const version = release.version;
  switch (block) {
    case "server-predates-checks":
      return resolve(
        msg(
          "This app cannot switch: its server predates database checks; update it on {from} first.",
          { from },
        ),
      );
    case "release-predates-checks":
      return resolve(
        msg(
          "This app cannot switch: {version} predates database checks; wait for a newer {to} release.",
          { version, to },
        ),
      );
    case "unsupported":
      return resolve(
        msg(
          "This app cannot switch: its database has changes {version} does not support yet; stay on {from} until {to} has them.",
          { version, from, to },
        ),
      );
  }
}

/** This app's reinstall restarts every server it hosts, so each of their databases must allow the
 * switch. `backendCount` is the desktop's own inventory: a backend still starting has no client
 * entry yet. A cached config can outlive its connection, so only a connected server's head counts.
 * With Local environment off this app runs no server, so its reinstall restarts none. */
export function localSwitchBlockReason(
  appVersion: string,
  release: ChannelSwitchRelease,
  hosted: ReadonlyArray<{
    readonly connected: boolean;
    readonly databaseMigration: number | undefined;
  }>,
  backendCount: number,
  localEnvironmentEnabled: boolean,
  resolve: MessageResolver = m,
): string | null {
  if (!localEnvironmentEnabled || !crossesTrack(appVersion, release)) return null;
  if (
    hosted.length === 0 ||
    hosted.length < backendCount ||
    hosted.some((server) => !server.connected)
  ) {
    return resolve(
      msg(
        "This app cannot switch: its server is not connected, so its database cannot be checked.",
      ),
    );
  }
  const block = hosted
    .map((server) => channelSwitchBlock(appVersion, release, server.databaseMigration))
    .find((reason): reason is ChannelSwitchBlock => reason !== null);
  return block === undefined
    ? null
    : localChannelSwitchBlockReason(appVersion, release, block, resolve);
}

/** When no machine moves, confirming only saves the track; when that track is already saved too,
 * confirming would do nothing. */
export function nothingToMove(
  input: {
    readonly label: string;
    readonly channel: DesktopUpdateChannel;
    // Null until the desktop reports it; an unknown track may still need saving.
    readonly savedChannel: DesktopUpdateChannel | null;
    readonly switchesLocal: boolean;
    readonly crossesLocal: boolean;
  },
  resolve: MessageResolver = m,
): { readonly note: string | null; readonly disabledReason: string | null } {
  if (input.switchesLocal) {
    return { note: null, disabledReason: null };
  }
  const allOnTrack = !input.crossesLocal;
  if (input.savedChannel === input.channel) {
    return {
      note: null,
      disabledReason: allOnTrack
        ? resolve(msg("This app is already on {label}.", { label: input.label }))
        : resolve(msg("This app cannot switch to {label} now.", { label: input.label })),
    };
  }
  return {
    note: allOnTrack
      ? resolve(
          msg("This app is already on {label}. This only saves the track.", {
            label: input.label,
          }),
        )
      : resolve(
          msg("This app cannot switch to {label} now. This only saves the track.", {
            label: input.label,
          }),
        ),
    disabledReason: null,
  };
}

/**
 * Whether this app stays put while connected machines move: its updater is off, as for a .deb
 * install or without a feed. Off only because a policy rules out its nightly channel, it moves.
 */
export function localUpdaterStaysPut(
  state: Pick<DesktopUpdateState, "enabled" | "channelBlockedByPolicy"> | null | undefined,
  target: DesktopUpdateChannel,
): boolean {
  return (
    state?.enabled === false && !(target === "latest" && state.channelBlockedByPolicy === true)
  );
}
