import * as vscode from "vscode";
import { getApiModelIds, isApiFetchSuccessful } from "./apiModelList";
import { ensureModelsDevLoaded } from "./modelsDev";
import { getBuiltInModelIds } from "./models";
import { getPrimaryApiKey } from "./keyManager";
import { logger } from "./logger";

/**
 * Startup model sync.
 *
 * On every VS Code window open the extension checks whether the TokenRhythm
 * API has any new models. To avoid hammering the API, the check runs at most
 * once per day (tracked via globalState). Every sync event is appended to a
 * Markdown log file — the workspace `.copilot/model-sync-log.md` when a
 * workspace folder is open, otherwise the extension's globalStorageUri.
 */

/** globalState key storing the last successful sync date (YYYY-MM-DD, local time). */
const SYNC_DATE_KEY = "tokenrhythm.lastModelSyncDate";
/** Log file name (inside .copilot/ or globalStorageUri). */
const SYNC_LOG_FILENAME = "model-sync-log.md";
/** Configuration key that enables/disables the startup sync. */
const SYNC_ENABLED_KEY = "syncModelsOnStartup";

/** Markdown header written when the log file is created. */
const LOG_HEADER = `# TokenRhythm 模型同步日志

> 扩展启动时自动检查 TokenRhythm API 是否有新的模型，每日最多同步一次。
> 同步事件由扩展自动追加，请勿手动编辑。

| 同步时间 | 结果 | 说明 |
| -------- | ---- | ---- |
`;

/** Resolve the sync log file URI: workspace .copilot/ first, global storage as fallback. */
function resolveSyncLogUri(context: vscode.ExtensionContext): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        return vscode.Uri.joinPath(folder.uri, ".copilot", SYNC_LOG_FILENAME);
    }
    return vscode.Uri.joinPath(context.globalStorageUri, SYNC_LOG_FILENAME);
}

/**
 * Append one sync event row to the Markdown log. Creates the file (with
 * header) if it does not exist yet. Failures are swallowed — logging must
 * never break the startup flow.
 */
async function appendSyncEvent(context: vscode.ExtensionContext, status: string, detail: string): Promise<void> {
    try {
        const uri = resolveSyncLogUri(context);
        let content = "";
        try {
            const existing = await vscode.workspace.fs.readFile(uri);
            content = Buffer.from(existing).toString("utf8");
        } catch {
            content = ""; // file does not exist yet
        }
        if (!content.includes("# TokenRhythm")) {
            content = LOG_HEADER;
        }
        if (!content.endsWith("\n")) {
            content += "\n";
        }
        const time = new Date().toLocaleString("zh-CN", { hour12: false });
        // Escape pipe characters in the detail so the table stays valid.
        const escaped = detail.replace(/\|/g, "\\|");
        content += `| ${time} | ${status} | ${escaped} |\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
        logger.debug("models.sync.log", { uri: uri.toString(), status, detail });
    } catch (err) {
        logger.warn("models.sync.log.writeFailed", { error: String(err) });
    }
}

/**
 * Check for new models on startup, at most once per day.
 * Safe to call without awaiting (fire-and-forget); all errors are handled
 * internally and never break extension activation.
 */
export async function syncModelsOnStartup(context: vscode.ExtensionContext): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration("tokenrhythm");
        if (!config.get<boolean>(SYNC_ENABLED_KEY, true)) {
            return;
        }

        // Skip if a successful sync already happened today.
        // Use local time so the "synced today" check matches the local-time
        // timestamps written to the log file (no UTC/local mismatch at midnight).
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        if (context.globalState.get<string>(SYNC_DATE_KEY) === today) {
            logger.debug("models.sync.skipped", { reason: "already-synced-today", date: today });
            return;
        }

        // Need an API key to query /v1/models. Use the primary key
        // (any valid key works — /v1/models does not check balance).
        const primaryKey = await getPrimaryApiKey(context.secrets);
        if (!primaryKey) {
            await appendSyncEvent(context, "⏭️ 跳过", "未配置 API Key");
            return;
        }

        // Warm the models.dev metadata cache (1h TTL) so auto-discovered
        // models get fresh capabilities.
        await ensureModelsDevLoaded();

        // Fetch the live model list from the API.
        const apiIds = await getApiModelIds(primaryKey.value);
        if (!isApiFetchSuccessful() || apiIds.size === 0) {
            await appendSyncEvent(context, "❌ 失败", "API 不可用或返回空列表");
            return;
        }

        // Detect models that are not in the built-in list.
        const builtInIds = getBuiltInModelIds();
        const newModels = [...apiIds].filter((id) => !builtInIds.has(id)).sort();
        const detail =
            newModels.length > 0
                ? `发现 ${newModels.length} 个新模型: ${newModels.join(", ")}`
                : `无新模型（API 共 ${apiIds.size} 个模型）`;

        // Mark today as synced BEFORE logging success: if globalState.update
        // throws, we land in the catch below and only write the ⚠️ row (no
        // duplicate ✅ row). A failed update also means we are NOT marked as
        // synced, so the next startup retries — as intended.
        await context.globalState.update(SYNC_DATE_KEY, today);
        await appendSyncEvent(context, "✅ 成功", detail);
    } catch (err) {
        logger.error("models.sync.error", { error: String(err) });
        try {
            await appendSyncEvent(context, "⚠️ 出错", `同步异常: ${String(err).slice(0, 200)}`);
        } catch {
            // ignore — logging failure must never break startup
        }
    }
}
