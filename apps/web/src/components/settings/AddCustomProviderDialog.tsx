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
  type KiloConfigSummary,
  type ProviderDriverKind,
  type SecretReference,
} from "@s8code/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

import {
  useEnvironmentSettings,
  useKiloImportFileReadMutation,
  useKiloImportProvidersMutation,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  buildKiloImportInstance,
  compatibleModelsEndpoint,
  compatibleModelsHeaders,
  customProviderDriver,
  kiloFileFailureMessage,
  mergeModelIds,
  parseKiloConfigContent,
  parseModelCatalogResponse,
  validateCustomProviderDraft,
  type CustomProviderDraft,
  type CustomProviderKind,
} from "./AddCustomProviderDialog.logic";

// The kilo.jsonc location on the server host; a `~` there expands to the host's home.
const KILO_DEFAULT_CONFIG_PATH = "~/.config/kilo/kilo.jsonc";

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

  const readKiloConfigFile = useKiloImportFileReadMutation(environmentId);
  const importKiloProviders = useKiloImportProvidersMutation(environmentId);

  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<CustomProviderKind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState<string | SecretReference>("");
  const [modelsText, setModelsText] = useState("");
  const [binaryPath, setBinaryPath] = useState("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [source, setSource] = useState<"manual" | "kiloImport" | "kiloFile">("manual");
  const [kiloConfigText, setKiloConfigText] = useState("");
  const [kiloFilePath, setKiloFilePath] = useState(KILO_DEFAULT_CONFIG_PATH);
  const [kiloSummary, setKiloSummary] = useState<KiloConfigSummary | null>(null);
  const [kiloFileError, setKiloFileError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [selectedKiloProviderIds, setSelectedKiloProviderIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [relayProbe, setRelayProbe] = useState<{
    kind: "fetch" | "test";
    status: "loading" | "ok" | "error";
    message: string;
  } | null>(null);

  const kiloParse =
    source === "kiloImport" && kiloConfigText.trim().length > 0
      ? parseKiloConfigContent(kiloConfigText)
      : null;

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
  const manualValidationError = validateCustomProviderDraft(draft);
  const validationError = source === "manual" ? manualValidationError : null;
  const kiloImportReady = kiloParse !== null && kiloParse.ok && selectedKiloProviderIds.size > 0;
  const kiloFileReady = kiloSummary !== null && selectedKiloProviderIds.size > 0;
  const showError = hasAttemptedSubmit && validationError !== null;
  const showKiloSelectionError =
    hasAttemptedSubmit &&
    (source === "kiloImport" ? !kiloImportReady : source === "kiloFile" ? !kiloFileReady : false);
  const kiloDriver = customProviderDriver("openai");

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

  // A secret provider reference holds no literal here, so the probe then runs without a key.
  const relayApiKey = typeof apiKey === "string" ? apiKey.trim() : null;

  const runModelsRequest = async (mode: "fetch" | "test") => {
    setRelayProbe({ kind: mode, status: "loading", message: "" });
    const url = compatibleModelsEndpoint(kind, baseUrl);
    if (!url) {
      setRelayProbe({
        kind: mode,
        status: "error",
        message: gt("Enter an http(s) Base URL first."),
      });
      return;
    }
    try {
      const response = await fetch(url, { headers: compatibleModelsHeaders(kind, relayApiKey) });
      if (!response.ok) {
        const authRejected =
          mode === "test" && (response.status === 401 || response.status === 403);
        setRelayProbe({
          kind: mode,
          status: "error",
          message: authRejected
            ? gt("Reached {url}, but the API key was rejected (HTTP {status}).", {
                url,
                status: response.status,
              })
            : gt("HTTP {status} from {url}.", { url, status: response.status }),
        });
        return;
      }
      const payload = await response.json().catch(() => null);
      if (mode === "test") {
        setRelayProbe({
          kind: mode,
          status: "ok",
          message: gt("Reached {url}. Authentication ok.", { url }),
        });
        return;
      }
      const modelIds = parseModelCatalogResponse(payload);
      if (modelIds.length === 0) {
        setRelayProbe({
          kind: mode,
          status: "error",
          message: gt("The response had no model IDs."),
        });
        return;
      }
      setModelsText((existing) => mergeModelIds(existing, modelIds));
      setRelayProbe({
        kind: mode,
        status: "ok",
        message: gt("Found {count} models.", { count: modelIds.length }),
      });
    } catch {
      setRelayProbe({
        kind: mode,
        status: "error",
        message: gt("Could not reach {url} from the browser.", { url }),
      });
    }
  };

  const saveKiloImport = async () => {
    setHasAttemptedSubmit(true);
    if (isSaving || !kiloParse || !kiloParse.ok || selectedKiloProviderIds.size === 0) return;
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setIsSaving(true);
    const claimedIds = new Set(existingIds);
    let firstCreated: ProviderInstanceId | null = null;
    let createdCount = 0;
    for (const provider of kiloParse.config.providers) {
      if (!selectedKiloProviderIds.has(provider.id)) continue;
      const providerInstanceId = deriveAvailableInstanceId(
        (candidate) => deriveInstanceId(kiloDriver, candidate) || `${kiloDriver}_provider`,
        provider.id,
        claimedIds,
      );
      const { instance } = buildKiloImportInstance({
        provider,
        instanceId: providerInstanceId,
        agentBlock: kiloParse.config.agentBlock,
        binaryPath,
      });
      const brandedId = ProviderInstanceId.make(providerInstanceId);
      const result = await persistProviderInstance({
        operation: "create",
        instanceId: brandedId,
        instance,
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setIsSaving(false);
        toastManager.add({
          type: "error",
          title: gt("Could not add provider instance"),
          description: gt("The import stopped at ''{provider}''. {message}", {
            provider: provider.name,
            message:
              error instanceof Error
                ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
                : gt("The settings update failed."),
          }),
        });
        return;
      }
      claimedIds.add(instanceId);
      createdCount += 1;
      firstCreated = firstCreated ?? brandedId;
    }
    setIsSaving(false);
    toastManager.add({
      type: "success",
      title: gt("Provider instance added"),
      description: gt("Imported {count} provider instance(s) from Kilo Code.", {
        count: createdCount,
      }),
    });
    if (firstCreated) onCreated?.(firstCreated, kiloDriver);
  };

  const readKiloConfig = async () => {
    if (isReading) return;
    setIsReading(true);
    setKiloFileError(null);
    const response = await readKiloConfigFile(kiloFilePath);
    setIsReading(false);
    if (response._tag !== "Success") {
      setKiloFileError(gt("Could not reach the server"));
      return;
    }
    if (response.value._tag === "Failed") {
      setKiloSummary(null);
      setSelectedKiloProviderIds(new Set());
      setKiloFileError(kiloFileFailureMessage(response.value));
      return;
    }
    setKiloSummary(response.value.summary);
    setKiloFilePath(response.value.summary.path);
    setSelectedKiloProviderIds(new Set());
    setHasAttemptedSubmit(false);
  };

  // The import composes the instances on the server, so no key value ever reaches this dialog.
  const saveKiloFileImport = async () => {
    setHasAttemptedSubmit(true);
    if (isSaving || kiloSummary === null || selectedKiloProviderIds.size === 0) return;
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setIsSaving(true);
    const response = await importKiloProviders(kiloSummary.path, binaryPath, [
      ...selectedKiloProviderIds,
    ]);
    if (response._tag !== "Success") {
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: gt("Could not add provider instance"),
        description: gt("The settings update failed."),
      });
      return;
    }
    if (response.value._tag === "Failed") {
      setIsSaving(false);
      setKiloFileError(kiloFileFailureMessage(response.value));
      return;
    }
    setIsSaving(false);
    toastManager.add({
      type: "success",
      title: gt("Provider instance added"),
      description: gt("Imported {count} provider instance(s) from Kilo Code.", {
        count: response.value.instanceIds.length,
      }),
    });
    if (response.value.authStatus !== "ok") {
      toastManager.add({
        type: "warning",
        title: gt("Kilo auth.json could not be read"),
        description: gt("The imported providers have no API key."),
      });
    }
    onCreated?.(response.value.instanceIds[0]!, kiloDriver);
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
              void (source === "kiloImport"
                ? saveKiloImport()
                : source === "kiloFile"
                  ? saveKiloFileImport()
                  : save());
            }}
          >
            <div className="grid gap-1.5">
              <Label>
                <T>Source</T>
              </Label>
              <ToggleGroup
                aria-label={gt("Source")}
                className="flex-wrap"
                value={[source]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "manual" || value === "kiloImport" || value === "kiloFile") {
                    setSource(value);
                    setHasAttemptedSubmit(false);
                    setKiloFileError(null);
                  }
                }}
              >
                <Toggle value="manual">
                  <T>Enter manually</T>
                </Toggle>
                <Toggle value="kiloImport">
                  <T>Import from Kilo Code</T>
                </Toggle>
                <Toggle value="kiloFile">
                  <T>
                    Read a file on <Var>{environmentLabel}</Var>
                  </T>
                </Toggle>
              </ToggleGroup>
            </div>
            {source === "kiloFile" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="custom-provider-kilo-file-path">
                    <T>kilo.jsonc path</T>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="custom-provider-kilo-file-path"
                      aria-label={gt("kilo.jsonc path")}
                      value={kiloFilePath}
                      onChange={(event) => {
                        setKiloFilePath(event.target.value);
                        setKiloSummary(null);
                        setSelectedKiloProviderIds(new Set());
                        setKiloFileError(null);
                        setHasAttemptedSubmit(false);
                      }}
                      placeholder={KILO_DEFAULT_CONFIG_PATH}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canManageProviders || isSaving || isReading}
                      onClick={() => void readKiloConfig()}
                    >
                      {isReading
                        ? gt("Reading...")
                        : gt("Read file", {
                            $context: "button, reads the Kilo config file from the server host",
                          })}
                    </Button>
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    <T>
                      Read from the machine that runs <Var>{environmentLabel}</Var>. The default
                      path is <Var>{KILO_DEFAULT_CONFIG_PATH}</Var>.
                    </T>
                  </p>
                </div>
                {kiloFileError ? (
                  <p className="text-2xs text-destructive" role="alert">
                    {kiloFileError}
                  </p>
                ) : null}
                {kiloSummary ? (
                  <div className="grid gap-1.5">
                    <Label>
                      <T>Providers</T>
                    </Label>
                    <div className="grid gap-1">
                      {kiloSummary.providers.map((provider) => (
                        <label
                          key={provider.id}
                          className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            aria-label={gt("Import provider {provider}", {
                              provider: provider.name,
                            })}
                            checked={selectedKiloProviderIds.has(provider.id)}
                            onCheckedChange={(checked) => {
                              setSelectedKiloProviderIds((existing) => {
                                const next = new Set(existing);
                                if (checked) {
                                  next.add(provider.id);
                                } else {
                                  next.delete(provider.id);
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {provider.name}
                          </span>
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {provider.baseURL}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {gt("{count} models", { count: provider.models.length })}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {provider.hasApiKey ? gt("API key set") : gt("No API key")}
                          </span>
                        </label>
                      ))}
                    </div>
                    {kiloSummary.agentNames.length > 0 ? (
                      <p className="text-2xs text-muted-foreground">
                        {gt("Agents in this config: {agents}", {
                          agents: kiloSummary.agentNames.join(", "),
                        })}
                      </p>
                    ) : null}
                    {kiloSummary.authStatus !== "ok" ? (
                      <p className="text-2xs text-destructive" role="alert">
                        {kiloSummary.authStatus === "missing"
                          ? gt(
                              "No auth.json was found on the host. Imported providers get no API key.",
                            )
                          : gt(
                              "auth.json on the host could not be read. Imported providers get no API key.",
                            )}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {showKiloSelectionError ? (
                  <p className="text-2xs text-destructive">
                    {kiloSummary === null
                      ? gt("Read the config file first.")
                      : gt("Select at least one provider.")}
                  </p>
                ) : null}
              </>
            ) : source === "kiloImport" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="custom-provider-kilo-config">
                    <T>kilo.jsonc content</T>
                  </Label>
                  <Textarea
                    id="custom-provider-kilo-config"
                    aria-label={gt("kilo.jsonc content")}
                    rows={8}
                    value={kiloConfigText}
                    onChange={(event) => {
                      setKiloConfigText(event.target.value);
                      setSelectedKiloProviderIds(new Set());
                      setHasAttemptedSubmit(false);
                    }}
                    placeholder={gt('{ "provider": { ... } }')}
                    spellCheck={false}
                  />
                  <p className="text-2xs text-muted-foreground">
                    <T>
                      Paste the contents of kilo.jsonc. Comments and trailing commas are allowed.
                    </T>
                  </p>
                </div>
                {kiloParse && !kiloParse.ok ? (
                  <p className="text-2xs text-destructive" role="alert">
                    {kiloParse.error}
                  </p>
                ) : null}
                {kiloParse?.ok ? (
                  <div className="grid gap-1.5">
                    <Label>
                      <T>Providers</T>
                    </Label>
                    <div className="grid gap-1">
                      {kiloParse.config.providers.map((provider) => (
                        <label
                          key={provider.id}
                          className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            aria-label={gt("Import provider {provider}", {
                              provider: provider.name,
                            })}
                            checked={selectedKiloProviderIds.has(provider.id)}
                            onCheckedChange={(checked) => {
                              setSelectedKiloProviderIds((existing) => {
                                const next = new Set(existing);
                                if (checked) {
                                  next.add(provider.id);
                                } else {
                                  next.delete(provider.id);
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {provider.name}
                          </span>
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {provider.baseURL}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {gt("{count} models", { count: provider.models.length })}
                          </span>
                        </label>
                      ))}
                    </div>
                    {kiloParse.config.agentNames.length > 0 ? (
                      <p className="text-2xs text-muted-foreground">
                        {gt("Agents in this config: {agents}", {
                          agents: kiloParse.config.agentNames.join(", "),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {showKiloSelectionError ? (
                  <p className="text-2xs text-destructive">
                    {kiloParse === null
                      ? gt("Paste the contents of kilo.jsonc.")
                      : kiloParse.ok
                        ? gt("Select at least one provider.")
                        : kiloParse.error}
                  </p>
                ) : null}
              </>
            ) : (
              <>
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
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="custom-provider-base-url">
                      <T>Base URL</T>
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isSaving || relayProbe?.status === "loading"}
                      onClick={() => void runModelsRequest("test")}
                    >
                      <T>Connection test</T>
                    </Button>
                  </div>
                  <Input
                    id="custom-provider-base-url"
                    placeholder="https://relay.example.com"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {relayProbe?.kind === "test" ? (
                    <p
                      className={
                        relayProbe.status === "ok"
                          ? "text-2xs text-muted-foreground"
                          : "text-2xs text-destructive"
                      }
                    >
                      {relayProbe.status === "loading" ? gt("Testing...") : relayProbe.message}
                    </p>
                  ) : null}
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
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="custom-provider-models">
                      <T>Model IDs</T>
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isSaving || relayProbe?.status === "loading"}
                      onClick={() => void runModelsRequest("fetch")}
                    >
                      <T>Fetch models</T>
                    </Button>
                  </div>
                  <Textarea
                    id="custom-provider-models"
                    aria-label={gt("Model IDs")}
                    rows={3}
                    value={modelsText}
                    onChange={(event) => setModelsText(event.target.value)}
                    placeholder="my-model"
                    spellCheck={false}
                  />
                  {relayProbe?.kind === "fetch" ? (
                    <p
                      className={
                        relayProbe.status === "ok"
                          ? "text-2xs text-muted-foreground"
                          : "text-2xs text-destructive"
                      }
                    >
                      {relayProbe.status === "loading" ? gt("Fetching...") : relayProbe.message}
                    </p>
                  ) : null}
                  <p className="text-2xs text-muted-foreground">
                    <T>One model ID per line.</T>
                  </p>
                </div>
              </>
            )}
            {source !== "manual" ? (
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
