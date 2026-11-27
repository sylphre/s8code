// SPDX-License-Identifier: MIT
// Copyright (c) 2014-2026 Laurier Sylph.
import { thrownErrorMessage } from "@s8code/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@s8code/client-runtime/provider-instance-ids";
import { squashAtomCommandFailure } from "@s8code/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type SecretReference,
} from "@s8code/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import {
  buildCustomProviderInstance,
  customProviderDriver,
  validateCustomProviderDraft,
  type CustomProviderDraft,
  type CustomProviderKind,
} from "./AddCustomProviderDialog.logic";

/** Builds a Claude or Kilo (OpenCode-compatible) instance from one relay/endpoint form. */
export function AddCustomProviderDialog({
  environmentId,
  environmentLabel,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onCreated?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void;
}) {
  const gt = useGT();
  const formId = useId();
  const settings = useEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<CustomProviderKind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState<string | SecretReference>("");
  const [modelsText, setModelsText] = useState("");
  const [binaryPath, setBinaryPath] = useState("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const draft: CustomProviderDraft = {
    displayName,
    kind,
    baseUrl,
    apiKey,
    modelsText,
    binaryPath,
  };
  const driver = customProviderDriver(kind);
  // Reserved ids run before configuration, so the wizard keeps clear of them too.
  const existingIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(settings.providerInstances ?? {}),
  ]);
  const instanceId = deriveAvailableInstanceId(
    (candidate) => deriveInstanceId(driver, candidate),
    displayName,
    existingIds,
  );
  const validationError = validateCustomProviderDraft(draft);
  const showError = hasAttemptedSubmit && validationError !== null;

  const save = async () => {
    setHasAttemptedSubmit(true);
    if (isSaving || validationError !== null || instanceId.length === 0) return;
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setIsSaving(true);
    const brandedId = ProviderInstanceId.make(instanceId);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: buildCustomProviderInstance({ draft, instanceId }),
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: gt("Could not add provider instance"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The settings update failed."),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Provider instance added"),
      description: gt("{provider} instance ''{instanceId}'' was added.", {
        provider: gt("Custom provider"),
        instanceId,
      }),
    });
    onCreated?.(brandedId, driver);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Add a custom provider</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Point an Anthropic-compatible relay or an OpenAI-compatible endpoint on{" "}
              <Var>{environmentLabel}</Var>.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-name">
                <T>Name</T>
              </Label>
              <Input
                id="custom-provider-name"
                placeholder={gt("e.g. My relay")}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoFocus
              />
              {instanceId ? (
                <p className="text-2xs text-muted-foreground">
                  {gt("Instance ID {instanceId}", { instanceId })}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label>
                <T>Type</T>
              </Label>
              <ToggleGroup
                aria-label={gt("Type")}
                value={[kind]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "anthropic" || value === "openai") setKind(value);
                }}
              >
                <Toggle value="anthropic">
                  <T>Anthropic compatible</T>
                </Toggle>
                <Toggle value="openai">
                  <T>OpenAI compatible</T>
                </Toggle>
              </ToggleGroup>
              <p className="text-2xs text-muted-foreground">
                {kind === "anthropic" ? (
                  <T>Runs a Claude instance against the relay.</T>
                ) : (
                  <T>Runs the Kilo CLI against the endpoint.</T>
                )}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-base-url">
                <T>Base URL</T>
              </Label>
              <Input
                id="custom-provider-base-url"
                placeholder="https://relay.example.com"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-api-key">
                <T>API key</T>
              </Label>
              <SecretSourceInput
                id="custom-provider-api-key"
                aria-label={gt("API key")}
                value={apiKey}
                sources={secretSources}
                environmentId={environmentId}
                onChange={(event) => setApiKey(event.target.value)}
                onSecretChange={(secret) => setApiKey(secret ?? "")}
                placeholder={gt("Stored sensitive")}
              />
              <p className="text-2xs text-muted-foreground">
                <T>Saved as a sensitive variable and never shown again.</T>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-models">
                <T>Model IDs</T>
              </Label>
              <Textarea
                id="custom-provider-models"
                aria-label={gt("Model IDs")}
                rows={3}
                value={modelsText}
                onChange={(event) => setModelsText(event.target.value)}
                placeholder="my-model"
                spellCheck={false}
              />
              <p className="text-2xs text-muted-foreground">
                <T>One model ID per line.</T>
              </p>
            </div>
            {kind === "openai" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="custom-provider-binary-path">
                  <T>Kilo binary path</T>
                </Label>
                <Input
                  id="custom-provider-binary-path"
                  placeholder="kilo"
                  value={binaryPath}
                  onChange={(event) => setBinaryPath(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-2xs text-muted-foreground">
                  <T>Leave empty to use the kilo command on PATH.</T>
                </p>
              </div>
            ) : null}
            {showError ? <p className="text-2xs text-destructive">{validationError}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={!canManageProviders || isSaving}>
            {isSaving ? gt("Adding...") : gt("Add instance")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
