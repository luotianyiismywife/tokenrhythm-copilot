/**
 * TokenRhythm 余额查询模块（主动预检）。
 *
 * 通过 tr_session cookie 调用用户中心 `GET /api/usage-summary` 查询余额，
 * 独立实现（不依赖 scripts/cookieApi，该目录为独立 tsconfig）。
 *
 * 实测确认（2026-08-09）：
 * - 余额为负时 usage-summary 仍返回 code:0 + availableBalanceCny
 * - 余额不足时 `POST /v1/chat/completions` 返回 HTTP 402 + INSUFFICIENT_BALANCE（不消耗 token）
 * - `GET /v1/models` 不校验余额（余额 < 0 也 200），不能作为可用性判据
 */
import * as vscode from "vscode";
import { logger } from "./logger";
import type { ApiKeyEntry } from "./keyManager";

const USAGE_SUMMARY_URL = "https://tokenrhythm.studio/api/usage-summary";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = "https://tokenrhythm.studio/v1/";
/** 手动检测用的最小聊天请求模型 */
const TEST_MODEL_ID = "deepseek-v4-flash";

/** 余额查询 TTL 缓存（按 cookie 粒度） */
interface BalanceCacheEntry {
    availableBalanceCny: number;
    checkedAt: number;
}
const balanceCache = new Map<string, BalanceCacheEntry>();

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("tokenrhythm");
}

/** 是否启用主动余额预检（默认 true） */
export function getBalanceCheckEnabled(): boolean {
    return getConfig().get<boolean>("balanceCheckEnabled", true);
}

/** 余额阈值：availableBalanceCny ≤ 该值视为耗尽（默认 0，夹取 ≥ 0） */
export function getMinBalanceCny(): number {
    const v = getConfig().get<number>("minBalanceCny", 0);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 余额查询缓存 TTL（秒，默认 60；0 = 每次查询） */
export function getBalanceCheckIntervalSec(): number {
    const v = getConfig().get<number>("balanceCheckIntervalSec", 60);
    return Number.isFinite(v) && v >= 0 ? v : 60;
}

// ---------------------------------------------------------------------------
// 余额查询
// ---------------------------------------------------------------------------

/**
 * 查询账号余额（GET /api/usage-summary）。
 * @throws 网络错误 / 非 2xx / code!==0 / 401（cookie 失效）
 * @returns availableBalanceCny
 */
export async function queryAccountBalance(cookie: string): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(USAGE_SUMMARY_URL, {
            headers: {
                Cookie: `tr_session=${cookie}`,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (response.status === 401) {
            throw new Error("401 未认证：tr_session Cookie 失效或格式错误");
        }
        if (!response.ok) {
            throw new Error(`余额查询失败：[${response.status}] ${response.statusText}`);
        }
        const body = (await response.json()) as {
            code: number;
            message?: string;
            data?: { availableBalanceCny?: number };
        };
        if (body.code !== 0 || !body.data) {
            throw new Error(`余额查询返回错误：code=${body.code} message=${body.message ?? ""}`);
        }
        return body.data.availableBalanceCny ?? 0;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 带 TTL 缓存的余额查询（按 cookie 粒度）。
 * @returns 余额数值；查询失败返回 undefined（不抛错，调用方回退被动检测）
 */
export async function getBalanceCached(cookie: string, ttlSec: number): Promise<number | undefined> {
    if (ttlSec > 0) {
        const cached = balanceCache.get(cookie);
        if (cached && Date.now() - cached.checkedAt < ttlSec * 1000) {
            return cached.availableBalanceCny;
        }
    }
    try {
        const balance = await queryAccountBalance(cookie);
        balanceCache.set(cookie, { availableBalanceCny: balance, checkedAt: Date.now() });
        return balance;
    } catch (err) {
        logger.warn("key.balanceCheck", {
            cookie: maskCookieForLog(cookie),
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/**
 * 检查 key 余额是否充足，并返回查询到的余额值（供日志 / 管理界面展示）。
 *
 * 判定：余额 > minBalanceCny → sufficient=true；查询失败（cookie 失效/网络）→ sufficient=true
 * （不阻塞请求，回退被动检测——余额 ≤ 0 时 API 会返回 402 触发轮换）。
 * @returns `{ sufficient, balance? }` —— balance 仅在查询成功时存在
 */
export async function checkKeyBalance(cookie: string): Promise<{ sufficient: boolean; balance?: number }> {
    const minBalance = getMinBalanceCny();
    const ttlSec = getBalanceCheckIntervalSec();
    const balance = await getBalanceCached(cookie, ttlSec);
    if (balance === undefined) {
        return { sufficient: true }; // 查询失败不阻塞
    }
    return { sufficient: balance > minBalance, balance };
}

/**
 * 判断 key 余额是否充足。
 * 余额 > minBalanceCny → true；查询失败（cookie 失效/网络）→ 返回 true（不阻塞请求，回退被动检测）。
 * 注意：默认 minBalanceCny=0 时，余额 ≤ 0（含 0 与负数）即视为不足 → 轮询时跳过该 key。
 */
export async function isKeyBalanceSufficient(cookie: string): Promise<boolean> {
    return (await checkKeyBalance(cookie)).sufficient;
}

// ---------------------------------------------------------------------------
// 手动检测
// ---------------------------------------------------------------------------

/**
 * 手动检测 key 可用性：查 cookie 余额 + 最小真实聊天请求。
 *
 * 判定：
 * - 余额 ≤ minBalanceCny → { ok: false, reason: "balance" }
 * - 聊天请求 200 → { ok: true }
 * - 聊天请求 402 / INSUFFICIENT_BALANCE → { ok: false, reason: "balance" }
 * - 聊天请求 401 → { ok: false, reason: "invalid" }
 * - 网络错误 / 超时 / 其他 → { ok: null }（无法确定，保留原状态）
 *
 * @returns reason: "balance" | "invalid" | "network" | undefined
 */
export async function testKeyAvailability(
    entry: ApiKeyEntry,
    baseUrl?: string
): Promise<{ ok: boolean | null; reason?: "balance" | "invalid" | "network" }> {
    // 1. 余额检查（有 cookie 时）
    if (entry.cookie) {
        try {
            const balance = await queryAccountBalance(entry.cookie);
            if (balance <= getMinBalanceCny()) {
                return { ok: false, reason: "balance" };
            }
        } catch {
            // cookie 失效/网络失败：不阻断，继续请求校验
        }
    }

    // 2. 最小真实聊天请求
    try {
        const normalized = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        const url = normalized.endsWith("/v1")
            ? `${normalized}/chat/completions`
            : `${normalized}/v1/chat/completions`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${entry.value}`,
                },
                body: JSON.stringify({
                    model: TEST_MODEL_ID,
                    messages: [{ role: "user", content: "say ok" }],
                    stream: false,
                    max_tokens: 8,
                }),
                signal: controller.signal,
            });

            if (response.ok) {
                return { ok: true };
            }
            const text = await response.text();
            if (response.status === 402 || text.includes("INSUFFICIENT_BALANCE") || text.includes("余额不足")) {
                return { ok: false, reason: "balance" };
            }
            if (response.status === 401) {
                return { ok: false, reason: "invalid" };
            }
            return { ok: null, reason: "network" };
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return { ok: null, reason: "network" };
    }
}

/** 日志用 cookie 脱敏 */
function maskCookieForLog(cookie: string): string {
    if (cookie.length <= 8) {
        return `${cookie.slice(0, 2)}****`;
    }
    return `${cookie.slice(0, 5)}****${cookie.slice(-4)}`;
}
