// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { desktopUpdateStateAtom } from "~/state/desktopUpdate";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Reports, once per launch, when the app restarted without the downloaded update applying. */
export function startDesktopUpdateLaunchNotice(): () => void {
  let notifiedNotAppliedVersion: string | null = null;
  return appAtomRegistry.subscribe(
    desktopUpdateStateAtom,
    (result) => {
      const notAppliedVersion =
        AsyncResult.getOrElse(result, () => null)?.notAppliedVersion ?? null;
      if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
      notifiedNotAppliedVersion = notAppliedVersion;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Update did not apply")),
          description: m(
            msg("S8 Code is still on {current}. Install {version} again from the update button.", {
              current: APP_VERSION,
              version: notAppliedVersion,
            }),
          ),
        }),
      );
    },
    { immediate: true },
  );
}
