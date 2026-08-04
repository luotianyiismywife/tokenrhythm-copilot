/**
 * TokenRhythm 用户中心 API 客户端。
 *
 * 用于通过登录 session cookie（tr_session）查询账号余额与调用日志，
 * 供扩展集成或独立脚本使用。认证走 cookie，与 /v1/* 的 Bearer Key 无关。
 *
 * 依赖：Node 18+ / 浏览器原生 fetch（项目已在用）。
 */

import {
    ApiResponse,
    CallLog,
    CallLogPage,
    CallLogQueryParams,
    CallLogStats,
    UsageSummary,
} from "./types";

/** 用户中心 API 基础地址 */
export const COOKIE_API_BASE_URL = "https://tokenrhythm.studio";

/** Cookie 名称常量 */
export const TR_SESSION_COOKIE = "tr_session";

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 构建带 cookie 的请求 URL。
 * @param path 以 / 开头的 API 路径
 * @param params 查询参数
 */
function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(path, COOKIE_API_BASE_URL);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url.toString();
}

/**
 * 发送 GET 请求并解析 JSON 响应。
 * @param sessionCookie tr_session Cookie 值（不含名称前缀）
 * @param path API 路径
 * @param params 查询参数
 * @throws 网络错误 / 非 2xx 状态 / code !== 0
 */
export async function apiGet<T>(
    sessionCookie: string,
    path: string,
    params?: Record<string, string | number | undefined>,
): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(buildUrl(path, params), {
            headers: {
                Cookie: `${TR_SESSION_COOKIE}=${sessionCookie}`,
                Accept: "application/json",
            },
            signal: controller.signal,
        });

        if (response.status === 401) {
            throw new Error(`401 未认证：Cookie 失效或格式错误（${TR_SESSION_COOKIE}）`);
        }
        if (!response.ok) {
            throw new Error(`API 请求失败：[${response.status}] ${response.statusText} (${path})`);
        }

        const body = (await response.json()) as ApiResponse<T>;
        if (body.code !== 0) {
            throw new Error(`API 返回错误：code=${body.code} message=${body.message} (${path})`);
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 查询账号用量 + 余额汇总（GET /api/usage-summary）。
 */
export function queryUsageSummary(sessionCookie: string): Promise<ApiResponse<UsageSummary>> {
    return apiGet<UsageSummary>(sessionCookie, "/api/usage-summary");
}

/**
 * 查询调用日志分页（GET /api/call-logs/page）。
 */
export async function queryCallLogs(
    sessionCookie: string,
    params: CallLogQueryParams,
): Promise<CallLog[]> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const response = await apiGet<CallLogPage>(sessionCookie, "/api/call-logs/page", {
        startAt: params.startAt,
        endAt: params.endAt,
        page,
        pageSize,
    });
    return response.data.list;
}

/**
 * 拉取时间范围内的全部调用日志（自动翻页，最多 maxPages 页）。
 */
export async function queryAllCallLogs(
    sessionCookie: string,
    startAt: string,
    endAt: string,
    options?: { pageSize?: number; maxPages?: number },
): Promise<CallLog[]> {
    const pageSize = options?.pageSize ?? 100;
    const maxPages = options?.maxPages ?? 10;
    const all: CallLog[] = [];
    for (let page = 1; page <= maxPages; page++) {
        const list = await queryCallLogs(sessionCookie, { startAt, endAt, page, pageSize });
        all.push(...list);
        if (list.length < pageSize) {
            break;
        }
    }
    return all;
}

/**
 * 对调用日志做统计汇总（按模型 / 状态 / Key 分组）。
 */
export function summarizeCallLogs(logs: CallLog[]): CallLogStats {
    const modelMap = new Map<string, { count: number; costCny: number }>();
    const statusMap = new Map<string, number>();
    const keyMap = new Map<string, number>();
    let totalCostCny = 0;

    for (const log of logs) {
        // 按模型
        const m = modelMap.get(log.model) ?? { count: 0, costCny: 0 };
        m.count += 1;
        m.costCny += log.costCny;
        modelMap.set(log.model, m);
        totalCostCny += log.costCny;

        // 按状态
        const statusKey = String(log.status);
        statusMap.set(statusKey, (statusMap.get(statusKey) ?? 0) + 1);

        // 按 Key
        keyMap.set(log.keyName, (keyMap.get(log.keyName) ?? 0) + 1);
    }

    const sortByCount = <K, V>(map: Map<K, V>) =>
        [...map.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

    return {
        total: logs.length,
        byModel: [...modelMap.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([model, v]) => ({ model, count: v.count, costCny: v.costCny })),
        byStatus: sortByCount(statusMap).map(([status, count]) => ({ status, count })),
        byKey: sortByCount(keyMap).map(([keyName, count]) => ({ keyName, count })),
        totalCostCny,
    };
}
