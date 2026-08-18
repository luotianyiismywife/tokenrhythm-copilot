/**
 * TokenRhythm 多 API Key 管理模块。
 *
 * 负责：
 * - SecretStorage 中多 key 的存取（`tokenrhythm.apiKeys`），并自动迁移旧版单 key（`tokenrhythm.apiKey`）
 * - rotation（轮询）/ single（单 key）两种模式的选择逻辑
 * - key 可用性状态（持久化 `available` + 瞬态冷却）
 * - 轮换错误判定（按状态码 + 错误文本 patterns）
 * - 脱敏显示辅助
 */
import * as vscode from "vscode";
import { logger } from "./logger";

/** 单个 API Key 条目 */
export interface ApiKeyEntry {
    /** API Key 值 */
    value: string;
    /** 可选备注 */
    label?: string;
    /** tr_session cookie（可选；一个 cookie 可绑定多个 key，余额按 cookie 粒度查询） */
    cookie?: string;
    /** 可用性：true=可用 / false=不可用(余额不足或失效) / null=未检测 */
    available?: boolean | null;
    /** 最近一次检测时间戳（ms） */
    lastCheckedAt?: number;
}

/** 完整 store（SecretStorage JSON 结构） */
export interface ApiKeyStore {
    keys: ApiKeyEntry[];
    /** single 模式下的"当前使用" key 下标 */
    activeIndex: number;
}

/** key 使用模式 */
export type ApiKeyMode = "rotation" | "single" | "sticky";

/** single 模式当前 key 不可用时的行为 */
export type SingleKeyFallback = "error" | "switch";

const STORE_KEY = "tokenrhythm.apiKeys";
const LEGACY_KEY = "tokenrhythm.apiKey";

/** 内存缓存：避免每次读取都访问 SecretStorage */
let storeCache: ApiKeyStore | null = null;

/** 轮询游标：模块级，跨请求共享。rotation 模式选中后前移（顺序轮换）；sticky 模式选中后钉住不前移（固定使用） */
let rotationIndex = 0;

/** 瞬态失效表：429 限流等"可能恢复"的失效，带冷却时间 */
const transientExhausted = new Map<string, { exhaustedAt: number; reason: string }>();

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("tokenrhythm");
}

/** 读取 key 使用模式（默认 sticky；非法值回退 sticky） */
export function getApiKeyMode(): ApiKeyMode {
    const mode = getConfig().get<string>("apiKeyMode", "sticky");
    if (mode === "rotation" || mode === "single" || mode === "sticky") {
        return mode;
    }
    return "sticky";
}

/** 读取当前轮询/粘性游标下标（供 UI 标记 sticky 模式下固定的 key） */
export function getRotationCursorIndex(): number {
    return rotationIndex;
}

/** 读取 single 模式不可用时的行为（默认 error；非法值回退 error） */
export function getSingleKeyFallback(): SingleKeyFallback {
    const fallback = getConfig().get<string>("singleKeyFallback", "error");
    return fallback === "switch" ? "switch" : "error";
}

/** 读取触发轮换的状态码列表（默认 [401, 402, 429, 503]） */
export function getRotationStatusCodes(): number[] {
    return getConfig().get<number[]>("apiKeyRotationStatusCodes", [401, 402, 429, 503]);
}

/** 读取触发轮换的错误文本 patterns */
export function getRotationErrorPatterns(): string[] {
    return getConfig().get<string[]>("apiKeyRotationErrorPatterns", [
        "余额不足",
        "insufficient balance",
        "INSUFFICIENT_BALANCE",
        "balance",
        "RATE_LIMITED",
        "UPSTREAM_RATE_LIMITED",
    ]);
}

/** 读取触发"瞬态整轮自动重试"的状态码列表（默认 [429, 503]——限流/服务端繁忙） */
export function getTransientRetryStatusCodes(): number[] {
    return getConfig().get<number[]>("transientRetryStatusCodes", [429, 503]);
}

/** 读取 429 瞬态冷却时长（分钟，默认 10） */
export function getExhaustedCooldownMin(): number {
    const v = getConfig().get<number>("apiKeyExhaustedCooldownMin", 10);
    return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** 读取瞬态失败（429/503）整轮自动重试次数（默认 3，夹取 0-10） */
export function getTransientRetryTimes(): number {
    const v = getConfig().get<number>("transientRetryTimes", 3);
    if (!Number.isFinite(v)) {
        return 3;
    }
    return Math.min(10, Math.max(0, Math.floor(v)));
}

// ---------------------------------------------------------------------------
// 存储读写与迁移
// ---------------------------------------------------------------------------

/**
 * 读取 API Key store。自动迁移旧版单 key（`tokenrhythm.apiKey`）为单元素列表；
 * JSON 损坏时回退旧 key 并修复。结果缓存到内存。
 */
export async function getApiKeyStore(secrets: vscode.SecretStorage): Promise<ApiKeyStore> {
    if (storeCache) {
        return storeCache;
    }

    let store: ApiKeyStore | null = null;
    const raw = await secrets.get(STORE_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<ApiKeyStore>;
            if (Array.isArray(parsed.keys)) {
                store = {
                    keys: parsed.keys
                        .filter((k) => k && typeof k.value === "string" && k.value.trim().length > 0)
                        .map((k) => ({
                            value: k.value.trim(),
                            label: k.label,
                            cookie: k.cookie,
                            available: k.available ?? null,
                            lastCheckedAt: k.lastCheckedAt,
                        })),
                    activeIndex: typeof parsed.activeIndex === "number" && parsed.activeIndex >= 0 ? parsed.activeIndex : 0,
                };
            }
        } catch (err) {
            logger.warn("keyManager.store.parse", { error: err instanceof Error ? err.message : String(err) });
        }
    }

    // 新格式不存在或损坏 → 回退旧版单 key
    if (!store || store.keys.length === 0) {
        const legacy = await secrets.get(LEGACY_KEY);
        if (legacy && legacy.trim()) {
            store = { keys: [{ value: legacy.trim(), available: null }], activeIndex: 0 };
            // 立即迁移写入新格式（save 会删除旧 key）
            await saveApiKeyStore(secrets, store);
        }
    }

    if (!store) {
        store = { keys: [], activeIndex: 0 };
    }
    // 修正 activeIndex 越界
    if (store.activeIndex >= store.keys.length) {
        store.activeIndex = store.keys.length > 0 ? 0 : 0;
    }

    storeCache = store;
    return store;
}

/**
 * 保存 API Key store 到 SecretStorage，成功后删除旧版单 key（幂等）。
 */
export async function saveApiKeyStore(secrets: vscode.SecretStorage, store: ApiKeyStore): Promise<void> {
    await secrets.store(STORE_KEY, JSON.stringify(store));
    try {
        await secrets.delete(LEGACY_KEY);
    } catch {
        // ignore legacy key deletion failures (idempotent retry on next save)
    }
    storeCache = store;
}

/** 使内存缓存失效（外部修改 SecretStorage 时调用） */
export function invalidateApiKeyStoreCache(): void {
    storeCache = null;
}

// ---------------------------------------------------------------------------
// 脱敏显示
// ---------------------------------------------------------------------------

/** 脱敏 API Key：`sk_****abcd`（长度 ≤ 8 时只保留头 4 字符） */
export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return `${key.slice(0, 2)}****`;
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/** 脱敏 cookie：`sess_****abcd` */
export function maskCookie(cookie: string): string {
    if (cookie.length <= 8) {
        return `${cookie.slice(0, 2)}****`;
    }
    const head = cookie.slice(0, 5);
    return `${head}****${cookie.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 可用性判断
// ---------------------------------------------------------------------------

/** 是否处于瞬态冷却中（429），返回剩余秒数 */
export function getTransientExhaustedInfo(keyValue: string): { reason: string; remainingSec: number } | undefined {
    const entry = transientExhausted.get(keyValue);
    if (!entry) {
        return undefined;
    }
    const cooldownMs = getExhaustedCooldownMin() * 60_000;
    if (cooldownMs <= 0) {
        // 冷却为 0：立即恢复
        transientExhausted.delete(keyValue);
        return undefined;
    }
    const remainingMs = entry.exhaustedAt + cooldownMs - Date.now();
    if (remainingMs <= 0) {
        transientExhausted.delete(keyValue);
        return undefined;
    }
    return { reason: entry.reason, remainingSec: Math.ceil(remainingMs / 1000) };
}

/** 判断 entry 是否可被选中（非冷却中、非持久化不可用） */
export function isApiKeyEligible(entry: ApiKeyEntry): boolean {
    if (entry.available === false) {
        return false;
    }
    return getTransientExhaustedInfo(entry.value) === undefined;
}

/**
 * 是否存在处于瞬态冷却中的 key（429 限流 / 503 服务端繁忙）。
 * 供"全部 key 不可选"时判断是否值得自动重试整轮（平台繁忙通常很快恢复）。
 */
export async function hasTransientExhaustedKey(secrets: vscode.SecretStorage): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    return store.keys.some((entry) => getTransientExhaustedInfo(entry.value) !== undefined);
}

/**
 * 判断错误是否应触发 key 轮换。
 * 匹配规则：状态码出现在配置列表 `[code]`/`status code`，或错误文本包含任一 patterns。
 */
export function isKeyRotationError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const statusCodes = getRotationStatusCodes();
    const patterns = getRotationErrorPatterns();

    // 状态码匹配：`[401]` / `status 401` 形式
    for (const code of statusCodes) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    // 文本匹配（不区分大小写）
    for (const pattern of patterns) {
        if (pattern && message.includes(pattern.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * 判断错误是否为"瞬态类"（平台繁忙/限流，可能很快恢复 → 值得整轮自动重试）。
 * 匹配 `tokenrhythm.transientRetryStatusCodes`（默认 [429, 503]）中的状态码。
 * 与 `isKeyRotationError` 解耦：触发轮换的状态码与触发自动重试的状态码可分别配置。
 */
export function isTransientRetryError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    for (const code of getTransientRetryStatusCodes()) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 选择逻辑
// ---------------------------------------------------------------------------

/**
 * 获取主 key（模型列表 / 启动同步等"任意有效 key 即可"的场景）。
 * - single → active key（跳过瞬态冷却与持久化不可用）
 * - sticky → 当前钉住的 key（不可用时从游标环形扫描第一个可用 key）
 * - rotation → 第一个可用的 key
 * 全部不可用时返回 undefined。注意：模型列表不校验余额（实测），无需关心 available 余额标记。
 */
export async function getPrimaryApiKey(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    if (getApiKeyMode() === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    // rotation / sticky：从游标开始环形扫描
    for (let i = 0; i < store.keys.length; i++) {
        const entry = store.keys[(rotationIndex + i) % store.keys.length];
        if (isApiKeyEligible(entry)) {
            return entry;
        }
    }
    return undefined;
}

/**
 * 选择下一个要使用的 key。
 * - rotation：从游标开始环形扫描第一个可用 key，游标前移一位（每次请求都换 key）
 * - sticky：从游标开始环形扫描第一个可用 key，游标钉住不前移（固定使用该 key，
 *   仅当它失效——余额不足/401/429/503 等——变 ineligible 后下次才会切到下一个并钉住；
 *   原 key 恢复后不自动切回，保持前缀缓存亲和性）
 * - single：返回 active key（不可用返回 undefined，由调用方按 fallback 决定报错或降级为 rotation）
 */
export async function pickNextApiKey(
    secrets: vscode.SecretStorage,
    mode: ApiKeyMode
): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    if (mode === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    // rotation / sticky：从 rotationIndex 开始顺序查找第一个 eligible 的 key
    for (let i = 0; i < store.keys.length; i++) {
        const idx = (rotationIndex + i) % store.keys.length;
        const entry = store.keys[idx];
        if (isApiKeyEligible(entry)) {
            if (mode === "rotation") {
                rotationIndex = (idx + 1) % store.keys.length; // 游标前移到下一个
            } else {
                rotationIndex = idx; // sticky：钉住当前 key，不前移
            }
            return entry;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 状态更新
// ---------------------------------------------------------------------------

/**
 * 瞬态失效原因：仅做内存冷却，不持久化 available=false。
 * （429 限流 / 503 服务端繁忙等"可能很快恢复"的错误——持久化会导致 key 在本会话永久不可用）
 */
const TRANSIENT_REASONS = new Set(["rate_limited", "server_error"]);

/** 是否为瞬态失效原因（429 限流 / 503 服务端繁忙） */
export function isTransientExhaustedReason(reason: string): boolean {
    return TRANSIENT_REASONS.has(reason);
}

/**
 * 从轮换错误中提取失效原因。
 * 基于状态码与错误文本（比 patterns 匹配更精确）：
 * - 402 / INSUFFICIENT_BALANCE / "余额不足" → "balance"
 * - 401 → "invalid"
 * - 429 / RATE_LIMITED → "rate_limited"
 * - 503 → "server_error"
 * - 其他（文本 patterns 命中的轮换错误）→ "api_error"
 */
export function getKeyRotationReason(err: unknown): string {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (message.includes("[402]") || message.includes("status 402") || message.includes("insufficient_balance") || message.includes("余额不足")) {
        return "balance";
    }
    if (message.includes("[401]") || message.includes("status 401")) {
        return "invalid";
    }
    if (message.includes("[429]") || message.includes("status 429") || message.includes("rate_limited")) {
        return "rate_limited";
    }
    if (message.includes("[503]") || message.includes("status 503")) {
        return "server_error";
    }
    return "api_error";
}

/**
 * 获取 key 当前不可用的机器可读原因（供"全部 key 不可用"报错展示）：
 * - 瞬态冷却中（429/503）→ "rate_limited" / "server_error"
 * - 持久化不可用（available=false）→ "unavailable"
 * - 其他（未检测 / 余额不足 / cookie 预检跳过）→ "balance"
 */
export function getKeyUnavailableReason(entry: ApiKeyEntry): string {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return transient.reason;
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "balance";
}

/**
 * 标记 key 为不可用。
 * - 瞬态原因（rate_limited/server_error）→ 仅记录内存冷却，不持久化 available=false
 * - 确定性原因（balance/invalid/api_error）→ 持久化 available=false
 */
export async function markApiKeyExhausted(secrets: vscode.SecretStorage, keyValue: string, reason: string): Promise<void> {
    if (TRANSIENT_REASONS.has(reason)) {
        // 瞬态：只冷却，不持久化（冷却到期自动恢复）
        transientExhausted.set(keyValue, { exhaustedAt: Date.now(), reason });
        return;
    }
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = false;
    entry.lastCheckedAt = Date.now();
    await saveApiKeyStore(secrets, store);
}

/** 标记 key 为可用（自愈 / 手动检测通过），清瞬态冷却 */
export async function markApiKeyAvailable(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = true;
    entry.lastCheckedAt = Date.now();
    transientExhausted.delete(keyValue);
    await saveApiKeyStore(secrets, store);
}

/** 通用可用性更新 */
export async function updateKeyAvailability(
    secrets: vscode.SecretStorage,
    keyValue: string,
    available: boolean | null
): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = available;
    entry.lastCheckedAt = Date.now();
    if (available !== false) {
        transientExhausted.delete(keyValue);
    }
    await saveApiKeyStore(secrets, store);
}

/** 清空瞬态冷却；可选将所有持久化不可用标记重置为 null（未检测） */
export async function resetExhaustedKeys(secrets: vscode.SecretStorage, resetPersisted: boolean): Promise<void> {
    transientExhausted.clear();
    if (resetPersisted) {
        const store = await getApiKeyStore(secrets);
        let changed = false;
        for (const entry of store.keys) {
            if (entry.available === false) {
                entry.available = null;
                entry.lastCheckedAt = undefined;
                changed = true;
            }
        }
        if (changed) {
            await saveApiKeyStore(secrets, store);
        }
    }
}

// ---------------------------------------------------------------------------
// 增删改
// ---------------------------------------------------------------------------

/** 添加 key（校验重复值）；可选附带 label / cookie */
export async function addApiKey(secrets: vscode.SecretStorage, entry: ApiKeyEntry): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.some((k) => k.value === entry.value)) {
        return false; // 已存在
    }
    store.keys.push({
        value: entry.value,
        label: entry.label,
        cookie: entry.cookie,
        available: entry.available ?? null,
    });
    await saveApiKeyStore(secrets, store);
    return true;
}

/**
 * 批量添加多个 API Key（三元组：cookie / key / 备注）。
 * 已有重复 key **不跳过**，转为更新其 cookie（补全缺失的 cookie，且新 cookie 覆盖旧的）。
 * 返回新增数量与更新数量。
 */
export async function addApiKeys(
    secrets: vscode.SecretStorage,
    entries: { value: string; label?: string; cookie?: string }[]
): Promise<{ added: number; updated: number }> {
    const store = await getApiKeyStore(secrets);
    let added = 0;
    let updated = 0;

    for (const entry of entries) {
        const value = entry.value?.trim();
        if (!value) {
            continue;
        }
        const cookie = entry.cookie?.trim() || undefined;
        const label = entry.label?.trim() || undefined;

        const existing = store.keys.find((k) => k.value === value);
        if (existing) {
            // 已存在 → 更新 cookie（补全或覆盖），不重复添加
            if (cookie && existing.cookie !== cookie) {
                existing.cookie = cookie;
                updated++;
            }
            continue;
        }
        store.keys.push({
            value,
            label,
            cookie,
            available: null,
        });
        added++;
    }

    if (added > 0 || updated > 0) {
        await saveApiKeyStore(secrets, store);
    }
    return { added, updated };
}

/** 删除 key；自动修正 activeIndex 与轮询游标 */
export async function removeApiKey(secrets: vscode.SecretStorage, index: number): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    store.keys.splice(index, 1);
    if (store.activeIndex >= store.keys.length) {
        store.activeIndex = store.keys.length > 0 ? store.keys.length - 1 : 0;
    }
    if (rotationIndex >= store.keys.length) {
        rotationIndex = 0;
    }
    await saveApiKeyStore(secrets, store);
}

/** 设置 single 模式的当前 key */
export async function setActiveKey(secrets: vscode.SecretStorage, index: number): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    store.activeIndex = index;
    await saveApiKeyStore(secrets, store);
}

/** 绑定 / 更新 / 清除指定 key 的 cookie */
export async function setKeyCookie(secrets: vscode.SecretStorage, index: number, cookie?: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return;
    }
    store.keys[index].cookie = cookie ? cookie.trim() : undefined;
    await saveApiKeyStore(secrets, store);
}

/**
 * 编辑指定 key 的三个字段（key 值 / cookie / 备注）。
 * 修改 key 值时会校验不与其它已存在 key 冲突。
 * 仅更新调用方提供的字段（undefined 表示不修改）。
 */
export async function updateApiKey(
    secrets: vscode.SecretStorage,
    index: number,
    fields: { value?: string; label?: string; cookie?: string }
): Promise<{ ok: boolean; conflict?: boolean }> {
    const store = await getApiKeyStore(secrets);
    if (index < 0 || index >= store.keys.length) {
        return { ok: false };
    }
    const entry = store.keys[index];

    if (fields.value !== undefined && fields.value.trim()) {
        const newValue = fields.value.trim();
        if (newValue !== entry.value && store.keys.some((k) => k.value === newValue)) {
            return { ok: false, conflict: true }; // 与其他 key 冲突
        }
        entry.value = newValue;
    }
    if (fields.label !== undefined) {
        entry.label = fields.label.trim() || undefined;
    }
    if (fields.cookie !== undefined) {
        entry.cookie = fields.cookie.trim() || undefined;
    }
    await saveApiKeyStore(secrets, store);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// 供 UI 展示的状态辅助
// ---------------------------------------------------------------------------

/** 获取 key 的展示状态：available / unavailable / unknown / cooldown */
export type KeyDisplayStatus = "available" | "unavailable" | "unknown" | "cooldown";

export function getKeyDisplayStatus(entry: ApiKeyEntry): KeyDisplayStatus {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return "cooldown";
    }
    if (entry.available === true) {
        return "available";
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "unknown";
}
