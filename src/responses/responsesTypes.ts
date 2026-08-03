/**
 * OpenAI Responses API types (POST /v1/responses).
 *
 * TokenRhythm's Responses endpoint supports a subset of the standard
 * OpenAI Responses API:
 * - Content block types: input_text / output_text / input_image
 * - Tool calls: function_call output items + function_call_arguments stream events
 * - Reasoning: reasoning items with summary_text blocks
 * - tool_choice: only "auto" / "none" (object/required forms rejected in thinking mode)
 */

/** Content block types supported by TokenRhythm's Responses endpoint. */
export type ResponsesContentType = "input_text" | "output_text" | "input_image";

/** A single content block inside a response input/output message. */
export interface ResponsesContentBlock {
    type: ResponsesContentType;
    /** Text content for input_text / output_text blocks. */
    text?: string;
    /** Data URL for input_image blocks. */
    image_url?: string;
    /** Annotations (output_text only). */
    annotations?: unknown[];
}

/** A message item in the input array. */
export interface ResponsesInputMessage {
    role: "user" | "assistant" | "system" | "developer";
    content: string | ResponsesContentBlock[];
}

/** A function_call output item (model decided to call a tool). */
export interface ResponsesFunctionCallItem {
    type: "function_call";
    id: string;
    call_id?: string;
    name: string;
    arguments: string;
    status?: string;
}

/** A reasoning output item. */
export interface ResponsesReasoningItem {
    type: "reasoning";
    id: string;
    summary?: Array<{ type: "summary_text"; text: string }>;
    content?: Array<{ type: "summary_text"; text: string }>;
}

/** A message output item. */
export interface ResponsesMessageItem {
    type: "message";
    id: string;
    role: string;
    status?: string;
    content: ResponsesContentBlock[];
}

/** Union of all possible output items. */
export type ResponsesOutputItem = ResponsesFunctionCallItem | ResponsesReasoningItem | ResponsesMessageItem;

/** Function tool definition for the Responses API. */
export interface ResponsesFunctionTool {
    type: "function";
    name: string;
    description?: string;
    parameters?: object;
}

/** Usage information returned by the Responses API. */
export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number | null;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
    x_details?: unknown[];
}

/** Non-streaming response object. */
export interface ResponsesResponse {
    id: string;
    object: "response";
    model: string;
    status: string;
    output: ResponsesOutputItem[];
    output_text?: string;
    usage?: ResponsesUsage;
    error?: unknown;
    cost_cny?: number;
    trace_id?: string;
}

/** Streaming event types emitted by the Responses endpoint. */
export type ResponsesStreamEventType =
    | "response.created"
    | "response.in_progress"
    | "response.completed"
    | "response.failed"
    | "response.output_item.added"
    | "response.output_item.done"
    | "response.content_part.added"
    | "response.content_part.done"
    | "response.output_text.delta"
    | "response.output_text.done"
    | "response.reasoning_summary_text.delta"
    | "response.reasoning_summary_text.done"
    | "response.function_call_arguments.delta"
    | "response.function_call_arguments.done"
    | "response.usage"
    | "error";

/** A parsed streaming event. */
export interface ResponsesStreamEvent {
    type: string;
    sequence_number?: number;
    item?: ResponsesOutputItem;
    output_index?: number;
    content_index?: number;
    delta?: string;
    arguments?: string;
    response?: Partial<ResponsesResponse>;
    error?: unknown;
}
