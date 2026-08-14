import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff, getRecentCommits } from "./gitUtils";
import { OpenaiApi } from "../openai/openaiApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { ResponsesApi } from "../responses/responsesApi";
import { getBuiltInModelConfig } from "../models";
import { getResponsesSupportedModelIds, getAnthropicSupportedModelIds } from "../apiModelList";
import { logger } from "../logger";
import { l10n, l10nFormat } from "../localize";
import type { TokenRhythmModelItem } from "../types";
import {
    addApiKey,
    getApiKeyMode,
    getApiKeyStore,
    getKeyRotationReason,
    getSingleKeyFallback,
    getTransientRetryTimes,
    hasTransientExhaustedKey,
    isKeyRotationError,
    isTransientExhaustedReason,
    isTransientRetryError,
    markApiKeyExhausted,
    maskApiKey,
    pickNextApiKey,
    type ApiKeyEntry,
} from "../keyManager";
import { getBalanceCheckEnabled, checkKeyBalance } from "../balanceCheck";
import { buildAllKeysUnavailableDetail, REASON_TEXT, tryTransientRetryRound } from "../provider";

/**
 * Git commit message generator module.
 */

let commitGenerationAbortController: AbortController | undefined;

const DEFAULT_PROMPT = {
    system:
        "You are a helpful assistant that generates concise, informative git commit messages based on git diffs.\n\nGuidelines:\n- By default, use conventional commit format: <type>(<scope>): <description>\n- If reference commits are provided below, match their style and language instead\n- Keep the subject line under 72 characters\n- Use the imperative mood (\"add\" not \"added\" / \"adds\")\n- CRITICAL: Output ONLY the commit message itself — no preamble, no introduction, no explanations, no backticks\n- If the diff is large, focus on the most important changes",
    user: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}",
    styleReference: "\n\nRecent commit messages in this repository (match their style):\n{{RECENT_COMMITS}}",
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
    try {
        const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
        if (!gitExtension) {
            throw new Error(l10n("Git extension not found"));
        }

        const git = gitExtension.getAPI(1);
        if (git.repositories.length === 0) {
            throw new Error(l10n("No Git repositories available"));
        }

        if (scm) {
            const repository = git.getRepository(scm.rootUri);

            if (!repository) {
                throw new Error(l10n("Repository not found for provided SCM"));
            }

            await generateCommitMsgForRepository(secrets, repository);
            return;
        }

        await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${l10n("[Commit Generation Failed]")} ${errorMessage}`);
    }
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: any[]) {
    const reposWithChanges = await filterForReposWithChanges(repos);

    if (reposWithChanges.length === 0) {
        vscode.window.showInformationMessage(l10n("No changes found in any workspace repositories."));
        return;
    }

    if (reposWithChanges.length === 1) {
        const repo = reposWithChanges[0];
        await generateCommitMsgForRepository(secrets, repo);
        return;
    }

    const selection = await promptRepoSelection(reposWithChanges);

    if (!selection) {
        return;
    }

    if (selection.repo === null) {
        for (const repo of reposWithChanges) {
            try {
                await generateCommitMsgForRepository(secrets, repo);
            } catch (error) {
                console.error(`Failed to generate commit message for ${repo.rootUri.fsPath}:`, error);
            }
        }
    } else {
        await generateCommitMsgForRepository(secrets, selection.repo);
    }
}

async function filterForReposWithChanges(repos: any[]) {
    const reposWithChanges = [];

    for (const repo of repos) {
        try {
            const gitDiff = await getGitDiff(repo.rootUri.fsPath);
            if (gitDiff) {
                reposWithChanges.push(repo);
            }
        } catch {
            // Skip repositories with errors
        }
    }
    return reposWithChanges;
}

async function promptRepoSelection(repos: any[]) {
    const repoItems = repos.map((repo) => ({
        label: repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath,
        description: repo.rootUri.fsPath,
        repo: repo,
    }));

    repoItems.unshift({
        label: "$(git-commit) Generate for all repositories with changes",
        description: `Generate commit messages for ${repos.length} repositories`,
        repo: null as any,
    });

    return await vscode.window.showQuickPick(repoItems, {
        placeHolder: "Select repository for commit message generation",
    });
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: any) {
    const inputBox = repository.inputBox;
    const repoPath = repository.rootUri.fsPath;
    const gitDiff = await getGitDiff(repoPath);

    if (!gitDiff) {
        throw new Error(`No changes in repository ${repoPath.split(path.sep).pop() || "repository"} for commit message`);
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.SourceControl,
            title: `Generating commit message for ${repoPath.split(path.sep).pop() || "repository"}...`,
            cancellable: true,
        },
        (_, token) => {
            token.onCancellationRequested(() => {
                commitGenerationAbortController?.abort();
            });
            return performCommitMsgGeneration(secrets, gitDiff, inputBox, repoPath);
        }
    );
}

async function ensureApiKeyEntry(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length > 0) {
        return store.keys[store.activeIndex] ?? store.keys[0];
    }

    const entered = await vscode.window.showInputBox({
        title: l10n("TokenRhythm Provider API Key"),
        prompt: l10n("Enter your TokenRhythm API key"),
        ignoreFocusOut: true,
        password: true,
    });
    if (entered && entered.trim()) {
        const added = await addApiKey(secrets, { value: entered.trim(), available: null });
        if (added) {
            const updated = await getApiKeyStore(secrets);
            return updated.keys[0];
        }
    }
    return undefined;
}

async function performCommitMsgGeneration(secrets: vscode.SecretStorage, gitDiff: string, inputBox: any, repoPath?: string) {
    const startTime = Date.now();
    let modelId: string | undefined;
    try {
        vscode.commands.executeCommand("setContext", "tokenrhythm.isGeneratingCommit", true);
        const config = vscode.workspace.getConfiguration();

        const customSystemPrompt = config.get<string>("tokenrhythm.commitMessagePrompt", "");
        let systemPrompt = customSystemPrompt || DEFAULT_PROMPT.system;

        // Fetch recent commits for style reference
        const recentCommitsCount = config.get<number>("tokenrhythm.recentCommitsCount", 10);
        const includeCommitDiff = config.get<boolean>("tokenrhythm.commitIncludeCommitDiff", false);
        if (recentCommitsCount > 0 && repoPath) {
            const recentCommits = await getRecentCommits(repoPath, recentCommitsCount, { includeDiff: includeCommitDiff });
            if (recentCommits) {
                const styleRef = includeCommitDiff
                    ? "\n\nRecent commit messages and their changes in this repository (match their style):\n{{RECENT_COMMITS}}"
                    : DEFAULT_PROMPT.styleReference;
                systemPrompt += styleRef.replace("{{RECENT_COMMITS}}", recentCommits);
            }
        }

        const prompts: string[] = [];

        // Attach AGENTS.md and README.md context
        const attachContextFiles = config.get<boolean>("tokenrhythm.commitAttachContextFiles", true);
        if (attachContextFiles && repoPath) {
            const contextFiles = ["AGENTS.md", "README.md"];
            for (const fileName of contextFiles) {
                const filePath = path.join(repoPath, fileName);
                try {
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath, "utf-8").trim();
                        if (content) {
                            const truncated = content.length > 8000
                                ? content.substring(0, 8000) + "\n\n[Content truncated due to size]"
                                : content;
                            prompts.push(`[File: ${fileName}]\n${truncated}`);
                        }
                    }
                } catch {
                    // Skip files that can't be read
                }
            }
        }

        const currentInput = inputBox.value?.trim() || "";
        if (currentInput) {
            prompts.push(DEFAULT_PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
        }

        const truncatedDiff =
            gitDiff.length > 5000 ? gitDiff.substring(0, 5000) + "\n\n[Diff truncated due to size]" : gitDiff;
        prompts.push(truncatedDiff);
        const prompt = prompts.join("\n\n");

        // Use model from config or default to deepseek-v4-flash
        const commitModelId = config.get<string>("tokenrhythm.commitModel", "deepseek-v4-flash");
        // Fetch full model config (apiMode, max_completion_tokens, extra, etc.)
        const selectedModel: TokenRhythmModelItem = getBuiltInModelConfig(commitModelId) ?? { id: commitModelId, owned_by: "tokenrhythm" };
        // Commit messages are simple tasks — disable thinking to speed up generation.
        selectedModel.enable_thinking = false;
        selectedModel.reasoning_effort = "high";
        // Cap max_completion_tokens to avoid proxy 500 errors with oversized values
        if (selectedModel.max_completion_tokens && selectedModel.max_completion_tokens > 8192) {
            selectedModel.max_completion_tokens = 8192;
        }
        modelId = selectedModel.id;
        logger.info("commit.start", { modelId });

        const primaryEntry = await ensureApiKeyEntry(secrets);
        if (!primaryEntry) {
            throw new Error(l10n("TokenRhythm API key not found"));
        }

        const baseUrl = selectedModel.baseUrl || "https://tokenrhythm.studio/v1/";
        if (!baseUrl || !baseUrl.startsWith("http")) {
            throw new Error(l10n("Invalid base URL configuration."));
        }

        // Apply language instruction: auto mode lets the model infer from style reference
        const commitLanguage = config.get<string>("tokenrhythm.commitLanguage", "auto");
        if (commitLanguage !== "auto") {
            systemPrompt += ` Generate commit message in ${commitLanguage}.`;
        }

        const messages = [{ role: "user", content: prompt }];

        // Use the appropriate API based on model config, overridable by user setting.
        // In auto mode, protocol capability is detected dynamically from /v1/models
        // (supports_responses / supports_anthropic) — no model IDs are hardcoded.
        // Priority in auto mode:
        //   1. enableResponsesApi (default false) + model supports_responses=true → responses
        //   2. enableAnthropicApi (default false) + model supports_anthropic=true → anthropic
        //   3. otherwise → openai
        const apiModeSetting = config.get<string>("tokenrhythm.apiMode", "auto");
        const enableResponsesApi = config.get<boolean>("tokenrhythm.enableResponsesApi", false);
        const enableAnthropicApi = config.get<boolean>("tokenrhythm.enableAnthropicApi", false);
        let apiMode: string;
        if (apiModeSetting === "openai" || apiModeSetting === "anthropic" || apiModeSetting === "responses") {
            apiMode = apiModeSetting;
        } else {
            const responsesModelIds = await getResponsesSupportedModelIds(primaryEntry.value);
            const anthropicModelIds = await getAnthropicSupportedModelIds(primaryEntry.value);
            if (enableResponsesApi && responsesModelIds.has(commitModelId)) {
                apiMode = "responses";
            } else if (enableAnthropicApi && anthropicModelIds.has(commitModelId)) {
                apiMode = "anthropic";
            } else {
                apiMode = "openai";
            }
        }
        // Reflect the effective apiMode on the model so createMessage() builds
        // the correct headers (x-api-key for anthropic, Bearer for openai/responses).
        selectedModel.apiMode = apiMode;

        // ── Multi-API-Key rotation loop for commit generation ──────────────────
        const apiKeyMode = getApiKeyMode();
        const singleFallback = getSingleKeyFallback();
        let usedFallbackKey = false; // single mode fell back to rotation
        let response = "";
        // Track per-key failure reasons so the "all keys exhausted" error can
        // show which key failed and why (masked), and distinguish transient
        // failures (429/503 — retry later) from permanent ones (402/401 — check).
        const failedKeys = new Map<string, string>();
        const totalKeys = (await getApiKeyStore(secrets)).keys.length;
        // Transient (429/503) whole-round auto-retry: when every key is busy or
        // rate-limited, wait with backoff and retry the whole round instead of
        // failing immediately (platform congestion usually clears within seconds).
        const maxTransientRetries = getTransientRetryTimes();
        let transientRetryCount = 0;

        while (true) {
            // If every key has failed at least one round, stop trying.
            if (totalKeys > 0 && failedKeys.size >= totalKeys) {
                const detail = [...failedKeys.entries()]
                    .map(([key, reason]) => `${maskApiKey(key)}: ${l10n(REASON_TEXT[reason] ?? reason)}`)
                    .join("; ");
                const hasTransient = [...failedKeys.values()].some((r) => r === "rate_limited" || r === "server_error");
                // Platform busy / rate-limited: back off and retry the whole
                // round automatically instead of failing immediately.
                if (hasTransient && (await tryTransientRetryRound(secrets, transientRetryCount, maxTransientRetries))) {
                    transientRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                logger.warn("commit.key.allUnavailable", { detail });
                if (hasTransient) {
                    throw new Error(l10nFormat("All API keys are temporarily unavailable ({0}). Please retry later.", detail));
                }
                throw new Error(l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability.", detail));
            }

            let entry = await pickNextApiKey(secrets, apiKeyMode);
            if (!entry) {
                if (apiKeyMode === "single" && singleFallback === "switch" && !usedFallbackKey) {
                    usedFallbackKey = true;
                    entry = await pickNextApiKey(secrets, "rotation");
                }
                if (!entry) {
                    // Every key is excluded (persisted unavailable / cooldown /
                    // insufficient balance). If any key is merely in transient
                    // cooldown (429/503), back off and retry the whole round.
                    if (
                        (await hasTransientExhaustedKey(secrets)) &&
                        (await tryTransientRetryRound(secrets, transientRetryCount, maxTransientRetries))
                    ) {
                        transientRetryCount++;
                        failedKeys.clear();
                        continue;
                    }
                    // Show why each key can't be used.
                    const detail = await buildAllKeysUnavailableDetail(secrets);
                    logger.warn("commit.key.allUnavailable", { detail });
                    throw new Error(
                        l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability.", detail)
                    );
                }
            }

            // Proactive balance pre-check (cookie-bound keys only).
            // Balance ≤ minBalanceCny (default 0) → skip this key and try the next.
            if (getBalanceCheckEnabled() && entry.cookie) {
                const check = await checkKeyBalance(entry.cookie);
                if (!check.sufficient) {
                    failedKeys.set(entry.value, "balance");
                    await markApiKeyExhausted(secrets, entry.value, "balance");
                    logger.warn("commit.key.rotation", {
                        key: entry.value.slice(0, 6) + "****",
                        reason: "balance_check",
                        balance: check.balance,
                    });
                    continue; // try next key
                }
            }

            const apiInstance = apiMode === "anthropic"
                ? new AnthropicApi(modelId)
                : apiMode === "responses"
                    ? new ResponsesApi(modelId)
                    : new OpenaiApi(modelId);

            commitGenerationAbortController = new AbortController();
            try {
                const stream = apiInstance.createMessage(selectedModel, systemPrompt, messages, baseUrl, entry.value, commitGenerationAbortController.signal);

                response = "";
                for await (const chunk of stream) {
                    commitGenerationAbortController.signal.throwIfAborted();
                    if (chunk.type === "text") {
                        response += chunk.text;
                        inputBox.value = extractCommitMessage(response);
                    }
                }
                break; // success
            } catch (err) {
                // User cancellation → stop immediately
                if (commitGenerationAbortController.signal.aborted) {
                    throw err;
                }
                // If partial output already written to the InputBox, do NOT switch
                // keys (avoid overwriting half-written content) — just fail.
                if (response.length > 0) {
                    throw err;
                }
                if (isKeyRotationError(err)) {
                    const rawReason = getKeyRotationReason(err);
                    // Transient errors (platform busy / rate limit, per
                    // transientRetryStatusCodes) must be kept cooldown-only
                    // (never persisted unavailable) so the whole-round auto
                    // retry can actually re-pick the keys. If the raw reason
                    // isn't already transient (e.g. 500 → api_error but the
                    // user added 500 to transientRetryStatusCodes), normalize
                    // it to server_error so markApiKeyExhausted only cools.
                    const reason =
                        isTransientRetryError(err) && !isTransientExhaustedReason(rawReason)
                            ? "server_error"
                            : rawReason;
                    failedKeys.set(entry.value, reason);
                    await markApiKeyExhausted(secrets, entry.value, reason);
                    logger.warn("commit.key.rotation", {
                        key: entry.value.slice(0, 6) + "****",
                        reason,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue; // try next key
                }
                throw err; // non-rotation error
            }
        }

        inputBox.value = removeThinkTags(inputBox.value);

        if (!inputBox.value) {
            throw new Error(l10n("empty API response"));
        }

        logger.info("commit.end", { modelId, durationMs: Date.now() - startTime });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("commit.error", { modelId: modelId ?? "unknown", error: errorMessage });
        vscode.window.showErrorMessage(`${l10n("Failed to generate commit message:")} ${errorMessage}`);
    } finally {
        vscode.commands.executeCommand("setContext", "tokenrhythm.isGeneratingCommit", false);
    }
}

export function abortCommitGeneration() {
    commitGenerationAbortController?.abort();
    vscode.commands.executeCommand("setContext", "tokenrhythm.isGeneratingCommit", false);
}

function extractCommitMessage(str: string): string {
    return str
        .trim()
        .replace(/^```[^\n]*\n?|```$/g, "")
        .trim();
}

function removeThinkTags(text: string): string {
    const regex = /<think>.*?<\/think>/gs;
    return text.replace(regex, "").trim();
}
