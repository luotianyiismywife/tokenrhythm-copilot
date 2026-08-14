import * as vscode from "vscode";
import { TokenRhythmChatModelProvider } from "./provider";
import { initStatusBar } from "./statusBar";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import type { ModelPreset } from "./types";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { syncModelsOnStartup } from "./modelSync";
import {
    addApiKey,
    addApiKeys,
    getApiKeyMode,
    getApiKeyStore,
    getKeyDisplayStatus,
    getPrimaryApiKey,
    getTransientExhaustedInfo,
    maskApiKey,
    maskCookie,
    removeApiKey,
    resetExhaustedKeys,
    setActiveKey,
    setKeyCookie,
    updateApiKey,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "./keyManager";
import { testKeyAvailability, getBalanceCached, getBalanceCheckIntervalSec, getMinBalanceCny } from "./balanceCheck";
import { getVisionSupportedModelIds } from "./apiModelList";

// ---- Walkthrough / Welcome constants ----

/** memento key tracking whether the welcome walkthrough has been shown. */
const WELCOME_SHOWN_KEY = "tokenrhythm.welcomeShown";

/** Walkthrough contribution ID (publisher.extension#walkthroughId). */
const WALKTHROUGH_ID = "luotianyiismywife.tokenrhythm-copilot-provider#tokenRhythmGettingStarted";

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    // Initialize TokenizerManager with extension path
    TokenizerManager.initialize(context.extensionPath);

    const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
    const provider = new TokenRhythmChatModelProvider(context.secrets, tokenCountStatusBarItem);

    // Register the TokenRhythm provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("tokenrhythm", provider);

    // Refresh the model list dynamically when the API mode (or auto model
    // discovery) setting changes — the provider fires
    // onDidChangeLanguageModelChatInformation so VS Code re-invokes
    // provideLanguageModelChatInformation and updates the picker without reload.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("tokenrhythm.apiMode") || e.affectsConfiguration("tokenrhythm.enableAutoModelDiscovery")) {
                provider.notifyModelListChanged();
            }
        })
    );

    // Management command to configure API key (legacy single-key flow,
    // writes into the new multi-key store as a single-element list)
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.setApiKey", async () => {
            const store = await getApiKeyStore(context.secrets);
            const existing = store.keys.length > 0 ? store.keys[store.activeIndex]?.value : undefined;
            const apiKey = await vscode.window.showInputBox({
                title: l10n("TokenRhythm Provider API Key"),
                prompt: existing ? l10n("Update your TokenRhythm API key") : l10n("Enter your TokenRhythm API key"),
                ignoreFocusOut: true,
                password: true,
                value: existing ?? "",
            });
            if (apiKey === undefined) {
                return; // user canceled
            }
            if (!apiKey.trim()) {
                // Clear all keys
                await context.secrets.store("tokenrhythm.apiKeys", JSON.stringify({ keys: [], activeIndex: 0 }));
                await context.secrets.delete("tokenrhythm.apiKey");
                vscode.window.showInformationMessage(l10n("TokenRhythm API key cleared."));
                return;
            }
            const trimmed = apiKey.trim();
            if (existing && existing === trimmed) {
                vscode.window.showInformationMessage(l10n("TokenRhythm API key saved."));
                return;
            }
            const added = await addApiKey(context.secrets, { value: trimmed, available: null });
            if (!added && store.keys.length > 0) {
                // Same value already exists — treat as "set active" to it
                const idx = store.keys.findIndex((k) => k.value === trimmed);
                if (idx >= 0) {
                    await setActiveKey(context.secrets, idx);
                }
            }
            vscode.window.showInformationMessage(l10n("TokenRhythm API key saved."));
        })
    );

    // Multi-key management command: QuickPick to add/delete keys, set current,
    // bind cookies, reset exhausted states, and manually test availability.
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.manageApiKeys", async () => {
            await showApiKeyManager(context);
        })
    );

    // Vision proxy model picker: dynamically loads vision-capable models from
    // /v1/models (supports_vision=true) so the user can pick instead of typing
    // the model ID by hand. Falls back to manual input when the API is unavailable.
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.setVisionProxyModel", async () => {
            const config = vscode.workspace.getConfiguration();
            const current = config.get<string>("tokenrhythm.visionProxyModel", "kimi-k2.6");
            const primary = await getPrimaryApiKey(context.secrets);
            const visionIds = primary ? await getVisionSupportedModelIds(primary.value) : new Set<string>();

            // Capability descriptions matching the settings-page enum descriptions.
            const VISION_MODEL_DESC: Record<string, string> = {
                "kimi-k2.5": l10n("Kimi K2.5 — vision-capable"),
                "kimi-k2.6": l10n("Kimi K2.6 — vision-capable (default)"),
                "kimi-k2.7-code": l10n("Kimi K2.7 Code — vision-capable, no temperature/top_p"),
                "qwen3.8-max": l10n("Qwen3.8 Max — text + image input, 1M context"),
                "seed-2.1-turbo": l10n("Seed 2.1 Turbo — vision-capable"),
                "seed-2.1-pro": l10n("Seed 2.1 Pro — vision-capable"),
            };

            interface VisionPick extends vscode.QuickPickItem {
                modelId?: string;
            }
            const items: VisionPick[] = [];
            if (visionIds.size > 0) {
                items.push(
                    ...[...visionIds].sort().map((id) => ({
                        label: id,
                        description: [
                            VISION_MODEL_DESC[id] ?? undefined,
                            id === current ? `$(check) ${l10n("Current")}` : undefined,
                        ].filter(Boolean).join("  ·  "),
                        modelId: id,
                    }))
                );
                items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            }
            items.push({
                label: `$(pencil) ${l10n("Custom (manual input)")}`,
                description: current,
            });

            const picked = await vscode.window.showQuickPick(items, {
                title: l10n("Select Vision Proxy Model"),
                placeHolder: current,
                ignoreFocusOut: true,
            });
            if (!picked) {
                return;
            }
            let newModel = picked.modelId;
            if (!newModel) {
                // Custom: prompt for manual input
                const entered = await vscode.window.showInputBox({
                    title: l10n("Select Vision Proxy Model"),
                    prompt: l10n("Enter the vision model ID"),
                    value: current,
                    ignoreFocusOut: true,
                });
                if (entered === undefined || !entered.trim()) {
                    return;
                }
                newModel = entered.trim();
            }
            await config.update("tokenrhythm.visionProxyModel", newModel, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                l10nFormat("Vision proxy model set to {0}", newModel)
            );
        })
    );

    // Command to open the TokenRhythm website to get an API key
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.getApiKey", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://tokenrhythm.studio/register"));
        })
    );

    // Command to open extension settings
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:luotianyiismywife.tokenrhythm-copilot-provider");
        })
    );

    // Register the generateGitCommitMessage command handler
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.generateGitCommitMessage", async (scm) => {
            generateCommitMsg(context.secrets, scm);
        }),
        vscode.commands.registerCommand("tokenrhythm.abortGitCommitMessage", () => {
            abortCommitGeneration();
        })
    );

    // Register the setModelPreset command: user can select a preset via QuickPick
    context.subscriptions.push(
        vscode.commands.registerCommand("tokenrhythm.setModelPreset", async () => {
            const config = vscode.workspace.getConfiguration();
            const presets = config.get<ModelPreset[]>("tokenrhythm.modelPresets", []);
            const currentPresetId = config.get<string>("tokenrhythm.modelPreset", "custom");
            const currentTemp = config.get<number | null>("tokenrhythm.temperature", null);
            const currentTopP = config.get<number | null>("tokenrhythm.top_p", null);

            interface PresetQuickPickItem extends vscode.QuickPickItem {
                presetId?: string;
            }

            // Mark the currently active preset with " (当前)"
            const presetItems: PresetQuickPickItem[] = presets.map((p) => ({
                label: `${l10n(p.label)} (${p.temperature})${p.id === currentPresetId ? l10n(" (current)") : ""}`,
                presetId: p.id,
            }));

            // Mark custom option with current values if active
            const isCustomActive = currentPresetId === "custom";
            const customLabel = "$(pencil) " + l10n("Custom (manual input)")
                + (isCustomActive
                    ? ` ${l10nFormat("(current, temperature: {0}, top_p: {1})", String(currentTemp ?? "—"), String(currentTopP ?? "—"))}`
                    : "");

            const customItem: PresetQuickPickItem = {
                label: customLabel,
            };

            const items: PresetQuickPickItem[] = [
                ...presetItems,
                { label: "", kind: vscode.QuickPickItemKind.Separator },
                customItem,
            ];

            const title = l10n("Set Model Preset");

            const picked = await vscode.window.showQuickPick(items, {
                title,
                placeHolder: l10n("Select a preset"),
                ignoreFocusOut: true,
            });

            if (!picked) {
                return;
            }

            const presetId = picked.presetId;

            if (presetId) {
                // User selected a named preset
                const matchedPreset = presets.find((p) => p.id === presetId);
                if (matchedPreset) {
                    await config.update("tokenrhythm.modelPreset", matchedPreset.id, vscode.ConfigurationTarget.Global);
                    await config.update("tokenrhythm.temperature", matchedPreset.temperature, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        l10nFormat("Set to temperature: {0} ({1})", String(matchedPreset.temperature), l10n(matchedPreset.label))
                    );
                }
            } else {
                // User chose "Custom (manual input)"
                const currentVal = currentTemp !== null && currentTopP !== null
                    ? `${currentTemp},${currentTopP}`
                    : "";
                const inputValue = await vscode.window.showInputBox({
                    title: l10n("Enter custom temperature"),
                    prompt: l10n("Enter a single number for temperature only (<=2), or two comma-separated numbers for temperature and top_p (temp<=2, top_p<=1), e.g.: 0.7 or 0.7,0.95"),
                    value: currentVal,
                    validateInput: (val: string) => {
                        const trimmed = val.trim();
                        if (!trimmed) {
                            return l10n("Please enter at least temperature value");
                        }
                        const parts = trimmed.split(",");
                        if (parts.length > 2) {
                            return l10n("Please enter at most two numbers separated by a comma");
                        }
                        const temp = parseFloat(parts[0].trim());
                        if (isNaN(temp) || temp < 0 || temp > 2) {
                            return l10n("Temperature must be between 0.0 and 2.0");
                        }
                        if (parts.length === 2) {
                            const topP = parseFloat(parts[1].trim());
                            if (isNaN(topP) || topP < 0 || topP > 1) {
                                return l10n("top_p must be between 0.0 and 1.0");
                            }
                        }
                        return null;
                    },
                    ignoreFocusOut: true,
                });
                if (inputValue !== undefined) {
                    const trimmed = inputValue.trim();
                    const parts = trimmed.split(",");
                    const tempNum = parseFloat(parts[0].trim());
                    await config.update("tokenrhythm.modelPreset", "custom", vscode.ConfigurationTarget.Global);
                    await config.update("tokenrhythm.temperature", tempNum, vscode.ConfigurationTarget.Global);
                    if (parts.length === 2) {
                        const topPNum = parseFloat(parts[1].trim());
                        await config.update("tokenrhythm.top_p", topPNum, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temp: {0}, top_p: {1} (custom)", String(tempNum), String(topPNum))
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temperature: {0} (custom)", String(tempNum))
                        );
                    }
                }
            }
        })
    );

    // Show welcome walkthrough on first install (when no API key is configured)
    showWelcomeIfNeeded(context);

    // Startup model sync — checks for new TokenRhythm models at most once per
    // day and logs a single line to the "TokenRhythm" Output channel.
    // Fire-and-forget: never blocks activation, all errors are handled internally.
    syncModelsOnStartup(context);

    // Dispose logger on deactivate
    context.subscriptions.push({
        dispose: () => logger.dispose(),
    });
}

/**
 * API Key 管理 QuickPick。
 * 支持：添加 / 删除 / 设为当前使用 / 重置失效状态 / 绑定或清除 cookie / 检测可用性。
 * 所有 key 与 cookie 均以脱敏形式展示。
 */
async function showApiKeyManager(context: vscode.ExtensionContext): Promise<void> {
    const secrets = context.secrets;

    const render = async (): Promise<vscode.QuickPickItem[] | undefined> => {
        const store = await getApiKeyStore(secrets);
        // "Set as Current" / ★ Current marker only make sense in single mode;
        // in rotation mode they are hidden entirely.
        const isSingleMode = getApiKeyMode() === "single";
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        if (store.keys.length === 0) {
            items.push({ label: l10n("No API keys configured"), kind: vscode.QuickPickItemKind.Separator });
        } else {
            // Fetch balances for cookie-bound keys (TTL-cached; query failure → undefined).
            // The balance is shown per key so users can see which keys are low on funds
            // and understand why rotation skips them.
            const balances = await Promise.all(
                store.keys.map((entry) =>
                    entry.cookie
                        ? getBalanceCached(entry.cookie, getBalanceCheckIntervalSec())
                        : Promise.resolve(undefined)
                )
            );
            store.keys.forEach((entry, i) => {
                const status = getKeyDisplayStatus(entry);
                const transient = getTransientExhaustedInfo(entry.value);
                let statusIcon = "$(question)";
                let statusText = l10n("Not checked");
                if (status === "available") {
                    statusIcon = "$(check)";
                    statusText = l10n("Available");
                } else if (status === "unavailable") {
                    statusIcon = "$(error)";
                    statusText = l10n("Unavailable");
                } else if (status === "cooldown" && transient) {
                    statusIcon = "$(clock)";
                    statusText = l10nFormat("Cooldown ({0}s)", String(transient.remainingSec));
                }
                const isActive = isSingleMode && i === store.activeIndex;
                // Balance display: only meaningful when a cookie is bound. Balance ≤
                // minBalanceCny is shown with an error icon — such keys are skipped in
                // rotation mode (proactive pre-check). Query failure → "Balance unknown".
                const balance = entry.cookie ? balances[i] : undefined;
                const balanceText = balance !== undefined && typeof balance === "number"
                    ? `${balance > getMinBalanceCny() ? "$(coin)" : "$(error)"} ¥${balance.toFixed(2)}`
                    : entry.cookie
                        ? `$(warning) ${l10n("Balance unknown")}`
                        : "";
                const detail = [
                    `${statusIcon} ${statusText}`,
                    balanceText,
                    isActive ? `$(star) ${l10n("Current")}` : "",
                    entry.cookie ? `$(key) ${l10n("Cookie bound")}` : `$(key) ${l10n("Cookie not bound")}`,
                ]
                    .filter(Boolean)
                    .join("  ·  ");
                items.push({
                    label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                    description: detail,
                    action: "select",
                    index: i,
                });
            });
        }

        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(plus) ${l10n("Add API Key")}`, action: "add" });
        items.push({ label: `$(import) ${l10n("Import API Keys (batch)")}`, action: "import" });
        if (store.keys.length > 0) {
            items.push({ label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" });
            // "Set as Current" only matters in single mode — hide it entirely in rotation mode.
            if (isSingleMode) {
                items.push({ label: `$(star) ${l10n("Set as Current")}`, action: "setActive" });
            }
            items.push({ label: `$(edit) ${l10n("Edit API Key")}`, action: "edit" });
            items.push({ label: `$(refresh) ${l10n("Reset Exhausted States")}`, action: "reset" });
            items.push({ label: `$(beaker) ${l10n("Check Availability")}`, action: "check" });
            items.push({ label: `$(link) ${l10n("Bind/Update Cookie")}`, action: "bindCookie" });
            items.push({ label: `$(unlink) ${l10n("Clear Cookie")}`, action: "clearCookie" });
        }
        return items;
    };

    // ---- Add key flow ----
    const addKeyFlow = async (): Promise<boolean> => {
        const keyValue = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter your TokenRhythm API key"),
            ignoreFocusOut: true,
            password: true,
        });
        if (keyValue === undefined || !keyValue.trim()) {
            return false;
        }
        const trimmed = keyValue.trim();
        const label = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter an optional label for this key"),
            ignoreFocusOut: true,
        });
        const cookie = await vscode.window.showInputBox({
            title: l10n("Add API Key"),
            prompt: l10n("Enter the tr_session cookie for this key (optional)"),
            ignoreFocusOut: true,
            password: true,
        });
        const added = await addApiKey(secrets, {
            value: trimmed,
            label: label?.trim() || undefined,
            cookie: cookie?.trim() || undefined,
            available: null,
        });
        if (!added) {
            vscode.window.showWarningMessage(l10n("API key already exists"));
            return false;
        }
        vscode.window.showInformationMessage(l10n("API key added"));
        return true;
    };

    // ---- Batch import flow: QuickPick list of (cookie/key/label) triples ----
    const batchImportFlow = async (): Promise<void> => {
        interface ImportTriple {
            value: string;
            cookie?: string;
            label?: string;
        }
        const pending: ImportTriple[] = [];

        // Render current pending list + actions
        const renderImport = (): vscode.QuickPickItem[] => {
            const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];
            if (pending.length === 0) {
                items.push({ label: l10n("No entries yet — click below to add a triple"), kind: vscode.QuickPickItemKind.Separator });
            } else {
                pending.forEach((t, i) => {
                    items.push({
                        label: `${maskApiKey(t.value)}${t.label ? ` (${t.label})` : ""}`,
                        description: t.cookie ? `$(key) ${maskCookie(t.cookie)}` : l10n("Cookie not bound"),
                        action: "remove",
                        index: i,
                    });
                });
            }
            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: `$(plus) ${l10n("Add a triple (cookie/key/label)")}`, action: "addTriple" });
            if (pending.length > 0) {
                items.push({ label: `$(check) ${l10n("Finish import")}`, action: "finish" });
                items.push({ label: `$(trash) ${l10n("Remove entry")}`, action: "remove" });
            }
            items.push({ label: `$(arrow-left) ${l10n("Cancel import")}`, action: "cancel" });
            return items;
        };

        while (true) {
            const picked = await vscode.window.showQuickPick(renderImport(), {
                title: l10n("Import API Keys (batch)"),
                placeHolder: l10n("Add triples, then finish import"),
                ignoreFocusOut: true,
            });
            if (!picked) {
                return; // canceled
            }
            const action = (picked as { action?: string }).action;
            const index = (picked as { index?: number }).index;

            if (action === "addTriple") {
                // Input key
                const key = await vscode.window.showInputBox({
                    title: l10n("Add a triple (cookie/key/label)"),
                    prompt: l10n("Enter the API key"),
                    ignoreFocusOut: true,
                    password: true,
                });
                if (key === undefined || !key.trim()) {
                    continue;
                }
                // Input cookie (optional)
                const cookie = await vscode.window.showInputBox({
                    title: l10n("Add a triple (cookie/key/label)"),
                    prompt: l10n("Enter the tr_session cookie (optional)"),
                    ignoreFocusOut: true,
                    password: true,
                });
                if (cookie === undefined) {
                    continue;
                }
                // Input label (optional)
                const label = await vscode.window.showInputBox({
                    title: l10n("Add a triple (cookie/key/label)"),
                    prompt: l10n("Enter an optional label (optional)"),
                    ignoreFocusOut: true,
                });
                if (label === undefined) {
                    continue;
                }
                pending.push({
                    value: key.trim(),
                    cookie: cookie.trim() || undefined,
                    label: label.trim() || undefined,
                });
            } else if (action === "remove" && typeof index === "number") {
                pending.splice(index, 1);
            } else if (action === "finish") {
                if (pending.length === 0) {
                    return;
                }
                const { added, updated } = await addApiKeys(secrets, pending);
                if (added > 0 || updated > 0) {
                    vscode.window.showInformationMessage(
                        l10nFormat("Imported {0} API keys ({1} cookies updated)", String(added), String(updated))
                    );
                } else {
                    vscode.window.showInformationMessage(l10n("No changes (keys already exist with same cookies)"));
                }
                return;
            } else if (action === "cancel") {
                return;
            }
        }
    };

    // ---- Select a key (for delete/setActive/check/bind/clear) ----
    const pickKey = async (title: string): Promise<{ index: number; entry: ApiKeyEntry } | undefined> => {
        const store = await getApiKeyStore(secrets);
        if (store.keys.length === 0) {
            vscode.window.showInformationMessage(l10n("No API keys configured"));
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            store.keys.map((entry, i) => ({
                label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                description: entry.cookie ? `$(key) ${maskCookie(entry.cookie)}` : undefined,
                index: i,
                entry,
            })),
            { title, ignoreFocusOut: true }
        );
        if (!picked) {
            return undefined;
        }
        return { index: picked.index as number, entry: picked.entry as ApiKeyEntry };
    };

    // ---- Check availability flow (single key) ----
    const checkAvailabilityFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: l10n("Checking availability...") },
            async () => {
                const result = await testKeyAvailability(entry);
                if (result.ok === true) {
                    await updateKeyAvailability(secrets, entry.value, true);
                    vscode.window.showInformationMessage(l10n("Key is available"));
                } else if (result.ok === false) {
                    await updateKeyAvailability(secrets, entry.value, false);
                    if (result.reason === "balance") {
                        vscode.window.showWarningMessage(
                            l10nFormat("Key balance is insufficient (≤ {0} CNY)", String(getMinBalanceCny()))
                        );
                    } else {
                        vscode.window.showWarningMessage(l10n("Key is invalid (401)"));
                    }
                } else {
                    vscode.window.showWarningMessage(l10n("Unable to determine availability, please retry later"));
                }
            }
        );
    };

    // ---- Check availability menu (sub-menu with "Check All" option) ----
    const showCheckMenu = async (): Promise<void> => {
        while (true) {
            const store = await getApiKeyStore(secrets);
            const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

            // Fetch balances for cookie-bound keys (TTL-cached) so the sub-menu
            // shows each key's current balance alongside its availability status.
            const balances = await Promise.all(
                store.keys.map((entry) =>
                    entry.cookie
                        ? getBalanceCached(entry.cookie, getBalanceCheckIntervalSec())
                        : Promise.resolve(undefined)
                )
            );

            // List all keys with their current status
            store.keys.forEach((entry, i) => {
                const status = getKeyDisplayStatus(entry);
                let statusText = l10n("Not checked");
                if (status === "available") statusText = `$(check) ${l10n("Available")}`;
                else if (status === "unavailable") statusText = `$(error) ${l10n("Unavailable")}`;
                else if (status === "cooldown") statusText = `$(clock) ${l10n("Cooldown")}`;
                const balance = entry.cookie ? balances[i] : undefined;
                const balanceText = balance !== undefined && typeof balance === "number"
                    ? `${balance > getMinBalanceCny() ? "$(coin)" : "$(error)"} ¥${balance.toFixed(2)}`
                    : entry.cookie
                        ? `$(warning) ${l10n("Balance unknown")}`
                        : "";
                const statusLine = statusText + (balanceText ? `  ·  ${balanceText}` : "");
                items.push({
                    label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
                    description: statusLine,
                    action: "checkOne",
                    index: i,
                });
            });

            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: `$(beaker) ${l10n("Check All Availability")}`, action: "checkAll" });
            items.push({ label: `$(arrow-left) ${l10n("Back")}`, action: "back" });

            const picked = await vscode.window.showQuickPick(items, {
                title: l10n("Check Availability"),
                placeHolder: l10n("Select a key to check, or check all"),
                ignoreFocusOut: true,
            });
            if (!picked) {
                return;
            }
            const action = (picked as { action?: string }).action;
            const index = (picked as { index?: number }).index;

            if (action === "checkOne" && typeof index === "number") {
                await checkAvailabilityFlow(index);
                // Refresh the menu after checking
                continue;
            } else if (action === "checkAll") {
                await checkAllAvailabilityFlow();
                continue;
            } else {
                return; // back or cancel
            }
        }
    };

    // ---- Check availability flow (ALL keys) ----
    const checkAllAvailabilityFlow = async (): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        if (store.keys.length === 0) {
            vscode.window.showInformationMessage(l10n("No API keys configured"));
            return;
        }
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: l10n("Checking availability of all keys..."),
                cancellable: false,
            },
            async (progress) => {
                let available = 0;
                let unavailable = 0;
                let unknown = 0;
                for (let i = 0; i < store.keys.length; i++) {
                    const entry = store.keys[i];
                    if (progress) {
                        progress.report({ message: l10nFormat("Checking {0}/{1}: {2}", String(i + 1), String(store.keys.length), maskApiKey(entry.value)) });
                    }
                    const result = await testKeyAvailability(entry);
                    if (result.ok === true) {
                        await updateKeyAvailability(secrets, entry.value, true);
                        available++;
                    } else if (result.ok === false) {
                        await updateKeyAvailability(secrets, entry.value, false);
                        unavailable++;
                    } else {
                        unknown++;
                    }
                }
                vscode.window.showInformationMessage(
                    l10nFormat("Availability check done: {0} available, {1} unavailable, {2} unknown", String(available), String(unavailable), String(unknown))
                );
            }
        );
    };

    // ---- Cookie binding flow ----
    const bindCookieFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }
        const cookie = await vscode.window.showInputBox({
            title: l10n("Bind/Update Cookie"),
            prompt: l10n("Enter the tr_session cookie value for this key"),
            ignoreFocusOut: true,
            password: true,
            value: entry.cookie ?? "",
        });
        if (cookie === undefined) {
            return;
        }
        await setKeyCookie(secrets, index, cookie.trim() || undefined);
        vscode.window.showInformationMessage(cookie.trim() ? l10n("Cookie updated") : l10n("Cookie cleared"));
    };

    // ---- Edit API key flow (value / cookie / label) ----
    const editKeyFlow = async (index: number): Promise<void> => {
        const store = await getApiKeyStore(secrets);
        const entry = store.keys[index];
        if (!entry) {
            return;
        }

        // 1. Key value (editable; conflicts checked on save)
        const newValue = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the API key value (leave unchanged to keep)"),
            ignoreFocusOut: true,
            password: true,
            value: entry.value,
        });
        if (newValue === undefined) {
            return;
        }

        // 2. Cookie
        const newCookie = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the tr_session cookie (empty to clear)"),
            ignoreFocusOut: true,
            password: true,
            value: entry.cookie ?? "",
        });
        if (newCookie === undefined) {
            return;
        }

        // 3. Label
        const newLabel = await vscode.window.showInputBox({
            title: l10n("Edit API Key"),
            prompt: l10n("Edit the label (empty to clear)"),
            ignoreFocusOut: true,
            value: entry.label ?? "",
        });
        if (newLabel === undefined) {
            return;
        }

        const result = await updateApiKey(secrets, index, {
            value: newValue.trim(),
            cookie: newCookie.trim(),
            label: newLabel.trim(),
        });
        if (result.ok) {
            vscode.window.showInformationMessage(l10n("API key updated"));
        } else if (result.conflict) {
            vscode.window.showWarningMessage(l10n("API key value conflicts with another existing key"));
        } else {
            vscode.window.showWarningMessage(l10n("Failed to update API key"));
        }
    };

    // ---- Main loop ----
    while (true) {
        const items = await render();
        if (!items) {
            return;
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: l10n("Select an API key to manage"),
            placeHolder: l10n("Select an API key to manage"),
            ignoreFocusOut: true,
        });
        if (!picked) {
            return; // canceled
        }
        const pickedAction = (picked as { action?: string }).action;
        if (!pickedAction) {
            return; // selected nothing actionable
        }

        switch (pickedAction) {
            case "add": {
                await addKeyFlow();
                break;
            }
            case "import": {
                await batchImportFlow();
                break;
            }
            case "delete": {
                const keyPick = await pickKey(l10n("Delete API Key"));
                if (!keyPick) {
                    break;
                }
                const confirm = await vscode.window.showWarningMessage(
                    l10nFormat("Confirm delete API key {0}?", maskApiKey(keyPick.entry.value)),
                    { modal: true },
                    l10n("Delete API Key")
                );
                if (confirm === l10n("Delete API Key")) {
                    await removeApiKey(secrets, keyPick.index);
                    vscode.window.showInformationMessage(l10n("API key deleted"));
                }
                break;
            }
            case "setActive": {
                // "Set as Current" only takes effect in single mode; in rotation
                // mode the active index is ignored (round-robin cursor is used).
                if (getApiKeyMode() !== "single") {
                    vscode.window.showInformationMessage(l10n("Set as Current is only valid in single mode (apiKeyMode=single)"));
                    break;
                }
                const keyPick = await pickKey(l10n("Set as Current"));
                if (!keyPick) {
                    break;
                }
                await setActiveKey(secrets, keyPick.index);
                vscode.window.showInformationMessage(l10n("Set as current API key"));
                break;
            }
            case "edit": {
                const keyPick = await pickKey(l10n("Edit API Key"));
                if (!keyPick) {
                    break;
                }
                await editKeyFlow(keyPick.index);
                break;
            }
            case "reset": {
                await resetExhaustedKeys(secrets, true);
                vscode.window.showInformationMessage(l10n("Reset exhausted key states"));
                break;
            }
            case "check": {
                await showCheckMenu();
                break;
            }
            case "bindCookie": {
                const keyPick = await pickKey(l10n("Bind/Update Cookie"));
                if (!keyPick) {
                    break;
                }
                await bindCookieFlow(keyPick.index);
                break;
            }
            case "clearCookie": {
                const keyPick = await pickKey(l10n("Clear Cookie"));
                if (!keyPick) {
                    break;
                }
                await setKeyCookie(secrets, keyPick.index, undefined);
                vscode.window.showInformationMessage(l10n("Cookie cleared"));
                break;
            }
            default:
                return;
        }
    }
}

/**
 * Show the welcome walkthrough on first activation if no API key is configured.
 * Once shown (or if a key already exists) the flag is persisted so it won't
 * reappear after subsequent reloads.
 */async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    try {
        if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
            return;
        }
        const store = await getApiKeyStore(context.secrets);
        if (store.keys.length > 0) {
            // API key already set — no need to show welcome
            await context.globalState.update(WELCOME_SHOWN_KEY, true);
            return;
        }
        await vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH_ID, false);
        await context.globalState.update(WELCOME_SHOWN_KEY, true);
    } catch (error) {
        logger.warn("Failed to show welcome walkthrough", { error: String(error) });
    }
}

export function deactivate() { }
