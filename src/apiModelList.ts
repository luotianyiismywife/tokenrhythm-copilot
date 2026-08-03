/**
 * API model list fetcher.
 *
 * Fetches the list of available model IDs from the TokenRhythm API
 * (/v1/models) and caches it with a 5-minute TTL.
 * Falls back to stale cache or an empty list on failure (silent degradation).
 */

const API_BASE_URL = "https://tokenrhythm.studio/v1/";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extended model metadata returned by /v1/models (subset we consume).
 */
export interface ApiModelMetadata {
    id: string;
    supports_responses?: boolean;
    supports_anthropic?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    supports_tools?: boolean;
    context_length?: number;
    max_completion_tokens?: number;
}

// ── Module-level cache ──
let cachedModelIds: string[] | null = null;
let cachedModelMetadata: ApiModelMetadata[] | null = null;
let cacheTimestamp = 0;
let lastFetchSuccess = false;

/**
 * Fetch the model list from the API's /models endpoint.
 * The endpoint follows OpenAI /v1/models format:
 *   { object: "list", data: [{ id, object, created, owned_by, ...capability flags }] }
 */
async function fetchApiModelList(apiKey: string): Promise<ApiModelMetadata[]> {
    const url = `${API_BASE_URL.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`API model list error: [${response.status}] ${response.statusText}`);
    }

    const body = (await response.json()) as {
        data?: Array<Partial<ApiModelMetadata> & { id: string }>;
    };
    return (body.data ?? []).map((m) => ({
        id: m.id,
        supports_responses: m.supports_responses,
        supports_anthropic: m.supports_anthropic,
        supports_vision: m.supports_vision,
        supports_reasoning: m.supports_reasoning,
        supports_tools: m.supports_tools,
        context_length: m.context_length,
        max_completion_tokens: m.max_completion_tokens,
    }));
}

/**
 * Get the list of model IDs available via the TokenRhythm API.
 *
 * @param apiKey - The API key for authentication.
 * @returns A set of model ID strings available on the API server.
 *          Returns an empty set on failure (silent degradation).
 */
export async function getApiModelIds(apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(apiKey);
    return new Set(cachedModelIds ?? []);
}

/**
 * Get the set of model IDs whose /v1/models entry reports supports_responses=true.
 * These models can use the Responses API protocol (POST /v1/responses).
 *
 * @param apiKey - The API key for authentication.
 * @returns A set of model IDs supporting the Responses API.
 */
export async function getResponsesSupportedModelIds(apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(apiKey);
    return new Set((cachedModelMetadata ?? []).filter((m) => m.supports_responses === true).map((m) => m.id));
}

/**
 * Ensure the module-level model cache is populated (5-minute TTL, silent fallback).
 */
async function ensureApiModelCache(apiKey: string | undefined): Promise<void> {
    const now = Date.now();

    // Use cached result if still fresh
    if (cachedModelMetadata !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        return;
    }

    if (!apiKey) {
        // No API key — keep stale cache or leave empty
        return;
    }

    try {
        const models = await fetchApiModelList(apiKey);
        cachedModelIds = models.map((m) => m.id);
        cachedModelMetadata = models;
        cacheTimestamp = now;
        lastFetchSuccess = true;
    } catch {
        // API call failed — keep stale cache if available
        lastFetchSuccess = false;
    }
}

/**
 * Returns true if the most recent API model list fetch was successful.
 * Used by the model provider to decide whether to apply API-based filtering.
 */
export function isApiFetchSuccessful(): boolean {
    return lastFetchSuccess;
}

/**
 * Clear the cached API model list (for testing / manual refresh).
 */
export function clearApiModelCache(): void {
    cachedModelIds = null;
    cacheTimestamp = 0;
    lastFetchSuccess = false;
}
