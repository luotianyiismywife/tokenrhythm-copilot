/**
 * TokenRhythm 用户中心 API 类型定义。
 *
 * 用户中心（/api/*）使用 session cookie（tr_session）认证，
 * 与 LLM 接口（/v1/*，Bearer API Key）是两套体系，勿混用。
 */

/** 通用 API 响应包装 */
export interface ApiResponse<T> {
    code: number;
    message: string;
    data: T;
    traceId?: string;
}

/** 用量 + 余额汇总（GET /api/usage-summary） */
export interface UsageSummary {
    /** 累计调用次数 */
    calls: number;
    /** 成功调用次数 */
    successCalls: number;
    /** 错误调用次数 */
    errorCalls: number;
    /** 中止调用次数 */
    abortedCalls: number;
    /** 累计输入 Token */
    inputTokens: number;
    /** 累计输出 Token */
    outputTokens: number;
    /** 累计成本（¥） */
    costCny: number;
    /** 账户余额（¥） */
    balanceCny: number;
    /** 冻结额度（¥，待结算占用） */
    frozenBalanceCny: number;
    /** 可用额度（¥） */
    availableBalanceCny: number;
    /** 限时额度（¥，即将到期部分） */
    expiringBalanceCny: number;
    /** 最近到期时间（ISO 8601 UTC），无则 null */
    nextExpiryAt: string | null;
    /** 币种 */
    currency: string;
}

/** 单条调用日志（GET /api/call-logs/page 列表元素） */
export interface CallLog {
    id: string;
    /** 本地时间 HH:mm:ss */
    time: string;
    /** 请求时间（ISO 8601 UTC） */
    requestAt: string;
    /** 端点，如 /v1/chat/completions */
    endpoint: string;
    /** 协议：openai / anthropic / responses */
    apiSurface: string;
    /** 请求 ID / 追踪 ID */
    requestId: string;
    traceId: string;
    opensquillaSessionId: string | null;
    opensquillaTurnId: string | null;
    opensquillaExecutionId: string | null;
    opensquillaCallKind: string | null;
    /** 是否流式 */
    stream: boolean;
    /** 调用来源：api_key 等 */
    source: string;
    /** 调用来源显示名，如 "API Key 调用" */
    sourceLabel: string;
    /** 请求模型 ID */
    requestModelId: string;
    /** 实际路由模型 ID */
    actualModelId: string;
    modelId: string;
    /** 模型显示名，如 "DeepSeek V4 Flash 0731" */
    model: string;
    /** 提供商，如 "DeepSeek" / "Alibaba Bailian" */
    provider: string;
    /** HTTP 状态码 */
    status: number;
    /** 耗时显示串，如 "2264ms" */
    latency: string;
    /** 耗时（毫秒） */
    latencyMs: number;
    /** 使用的 API Key 名称 */
    keyName: string;
    /** 客户端应用标识，如 ai-sdk */
    clientApp: string;
    /** 代理标识 */
    agent: string;
    clientAppSource: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    reasoningTokens: number;
    /** 本次成本（¥） */
    costCny: number;
    inputCostCny: number | null;
    outputCostCny: number | null;
    cacheReadCostCny: number | null;
    cacheCreationCostCny: number | null;
    costBreakdownComplete: boolean;
    billingInputPrice: string;
    billingOutputPrice: string;
    billingCacheReadPrice: string;
    billingCacheCreationPrice: string;
    billingUnit: number;
    billingPriceMode: string;
    actualCostUsd: number;
    tokenSavingUsd: number;
    fusionEquivalentOpusUsd: number;
    usageSource: string;
    /** 结束原因：tool_calls / stop / 错误码等 */
    finishReason: string;
    retryCount: number;
    streamInterrupted: boolean;
    clientDisconnected: boolean;
}

/** 调用日志分页响应 data 结构 */
export interface CallLogPage {
    list: CallLog[];
}

/** 调用日志查询参数 */
export interface CallLogQueryParams {
    /** 开始时间（ISO 8601 UTC） */
    startAt: string;
    /** 结束时间（ISO 8601 UTC） */
    endAt: string;
    /** 页码，从 1 开始 */
    page?: number;
    /** 每页条数 */
    pageSize?: number;
}

/** 调用日志统计汇总 */
export interface CallLogStats {
    total: number;
    byModel: Array<{ model: string; count: number; costCny: number }>;
    byStatus: Array<{ status: string; count: number }>;
    byKey: Array<{ keyName: string; count: number }>;
    totalCostCny: number;
}
