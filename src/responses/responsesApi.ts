import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    LanguageModelToolCallPart,
    ProvideLanguageModelChatResponseOptions,
    Progress,
} from "vscode";

import type { TokenRhythmModelItem } from "../types";
import {
    isImageMimeType,
    createDataUrl,
    isToolResultPart,
    convertToolsToOpenAI,
    mapRole,
    storeDataUriImages,
    replaceDataUriImages,
    tryParseJSONObject,
} from "../utils";
import { CommonApi, StreamUsage } from "../commonApi";
import { logger } from "../logger";
import type { StoredImage } from "../vision/types";
import {
    ASK_IMAGE_TOOL_NAME,
    ASK_IMAGE_TOOL_DEF,
    ASK_WITH_MULTI_IMAGE_TOOL_NAME,
    ASK_WITH_MULTI_IMAGE_TOOL_DEF,
} from "../vision/types";
import type {
    ResponsesContentBlock,
    ResponsesFunctionTool,
    ResponsesInputMessage,
    ResponsesStreamEvent,
    ResponsesOutputItem,
    ResponsesFunctionCallItem,
} from "./responsesTypes";

/**
 * OpenAI Responses API implementation (POST /v1/responses).
 *
 * TokenRhythm supports the Responses protocol for models whose /v1/models
 * entry reports supports_responses=true (currently qwen3.7-max and
 * deepseek-v4-flash-0731). This class converts VS Code chat messages to the
 * Responses input format, builds the request body, and parses the SSE stream.
 *
 * Known endpoint constraints (verified against the live API):
 * - Content block types are limited to input_text / output_text / input_image;
 *   function_call / function_call_output blocks are REJECTED. Historical tool
 *   calls and tool results are therefore textified with marker tags, and
 *   multi-round tool follow-ups use the same textified backfill.
 * - tool_choice only accepts "auto" / "none" (object/required forms rejected
 *   in thinking mode).
 * - reasoning: { effort: "none" } disables thinking; { effort: "high" } enables it.
 */
export class ResponsesApi extends CommonApi<ResponsesInputMessage, Record<string, unknown>> {
    /** Whether images were found during convertMessages for ask_image tool. */
    private _hasImages = false;

    /** Buffer for assembling streamed function_call items by output_index. */
    private _responsesToolCallBuffers: Map<number, { id?: string; callId?: string; name?: string; args: string }> =
        new Map<number, { id?: string; callId?: string; name?: string; args: string }>();

    /** output_index values whose function_call has been fully emitted. */
    private _completedResponsesToolCalls = new Set<number>();

    constructor(modelId: string) {
        super(modelId);
    }

    /**
     * Convert VS Code chat request messages into Responses API input messages.
     *
     * For non-vision models, images are replaced with text references and stored
     * in instance-local _localImages for the ask_image tool. Historical tool
     * calls/results are textified (the endpoint rejects function_call blocks).
     */
    convertMessages(
        messages: readonly LanguageModelChatRequestMessage[],
        modelConfig: { includeReasoningInRequest: boolean; vision?: boolean }
    ): ResponsesInputMessage[] {
        const modelSupportsVision = modelConfig.vision !== false;
        const out: ResponsesInputMessage[] = [];
        let imageIndex = 0;
        this._systemContent = undefined;

        // Collect images to instance-local array if model doesn't support vision
        const imagesToStore: StoredImage[] = [];
        if (!modelSupportsVision) {
            for (const m of messages) {
                for (const part of m.content ?? []) {
                    if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                        imagesToStore.push({ data: part.data, mimeType: part.mimeType });
                    }
                    if (isToolResultPart(part)) {
                        const toolContent = (part as { content?: ReadonlyArray<unknown> }).content;
                        if (toolContent) {
                            for (const inner of toolContent) {
                                if (inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                    imagesToStore.push({ data: inner.data, mimeType: inner.mimeType });
                                } else if (inner instanceof vscode.LanguageModelTextPart) {
                                    storeDataUriImages(inner.value, imagesToStore);
                                }
                            }
                        }
                    }
                    if (part instanceof vscode.LanguageModelTextPart) {
                        storeDataUriImages(part.value, imagesToStore);
                    }
                }
            }
            if (imagesToStore.length > 0) {
                this._localImages = imagesToStore;
                this._hasImages = true;
            }
        }

        for (const m of messages) {
            const role = mapRole(m);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: { id: string; name: string; args: string }[] = [];
            const toolResults: { callId: string; content: string }[] = [];

            for (const part of m.content ?? []) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (modelSupportsVision) {
                        textParts.push(part.value);
                    } else {
                        const result = replaceDataUriImages(part.value, imageIndex);
                        imageIndex += result.count;
                        textParts.push(result.text);
                    }
                } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                    if (modelSupportsVision) {
                        imageParts.push(part);
                    } else {
                        textParts.push(
                            `\n[The user sent an image (imageIndex=${imageIndex}). I am a text-only model and CANNOT see images directly. I MUST call the ask_image tool to learn about it.\n\nRecommended strategy:\n1. First call ask_image for a brief description to get an overview of the image.\n2. Then call ask_image again with specific questions about details you need (e.g., colors, text content, UI elements, error messages, or any other visible information).\n]`
                        );
                        imageIndex++;
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    let args = "{}";
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = "{}";
                    }
                    toolCalls.push({ id: part.callId || "", name: part.name, args });
                } else if (isToolResultPart(part)) {
                    const callId = (part as { callId?: string }).callId ?? "";
                    const toolContent = (part as { content?: ReadonlyArray<unknown> }).content;
                    const toolTexts: string[] = [];
                    if (toolContent) {
                        for (const inner of toolContent) {
                            if (inner instanceof vscode.LanguageModelTextPart) {
                                if (modelSupportsVision) {
                                    toolTexts.push(inner.value);
                                } else {
                                    const result = replaceDataUriImages(inner.value, imageIndex);
                                    imageIndex += result.count;
                                    toolTexts.push(result.text);
                                }
                            } else if (!modelSupportsVision && inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                toolTexts.push(
                                    `\n[Image data from tool call (imageIndex=${imageIndex}). I am a text-only model and CANNOT see images directly. I MUST call the ask_image tool to learn about it.\n\nRecommended strategy:\n1. First call ask_image for a brief description to get an overview of the image.\n2. Then call ask_image again with specific questions about details you need (e.g., colors, text content, UI elements, error messages, or any other visible information).\n]`
                                );
                                imageIndex++;
                            }
                        }
                    }
                    toolResults.push({ callId, content: toolTexts.join("\n").trim() });
                }
                // LanguageModelThinkingPart from history is dropped —
                // the Responses endpoint only accepts input_text/output_text blocks.
            }

            const joinedText = textParts.join("").trim();

            if (role === "system") {
                if (joinedText) {
                    // System prompts go to the top-level "instructions" field.
                    this._systemContent = [this._systemContent, joinedText].filter(Boolean).join("\n\n");
                }
                continue;
            }

            if (role === "assistant") {
                const blocks: ResponsesContentBlock[] = [];
                if (joinedText) {
                    blocks.push({ type: "output_text", text: joinedText });
                }
                // Historical tool calls are textified (function_call blocks unsupported)
                for (const tc of toolCalls) {
                    blocks.push({
                        type: "output_text",
                        text: `[tool_call] ${tc.name}(${tc.args}) [/tool_call]`,
                    });
                }
                if (blocks.length > 0) {
                    out.push({ role: "assistant", content: blocks });
                }
                continue;
            }

            if (role === "user") {
                const blocks: ResponsesContentBlock[] = [];
                if (joinedText) {
                    blocks.push({ type: "input_text", text: joinedText });
                }
                for (const imagePart of imageParts) {
                    const dataUrl = createDataUrl(imagePart);
                    blocks.push({ type: "input_image", image_url: dataUrl });
                }
                // Historical tool results are textified
                for (const tr of toolResults) {
                    blocks.push({
                        type: "input_text",
                        text: `[tool_result] ${tr.content || "(no output)"} [/tool_result]`,
                    });
                }
                if (blocks.length > 0) {
                    out.push({ role: "user", content: blocks });
                }
            }
        }

        this._originalApiMessages = out as any[];
        return out;
    }

    /**
     * Build the Responses API request body.
     */
    prepareRequestBody(
        rb: Record<string, unknown>,
        um: TokenRhythmModelItem | undefined,
        options?: ProvideLanguageModelChatResponseOptions
    ): Record<string, unknown> {
        // System prompt → instructions
        if (this._systemContent) {
            rb.instructions = this._systemContent;
        }

        // temperature / top_p
        if (um?.temperature !== undefined && um.temperature !== null) {
            if (um.supportsTemperature !== false) {
                rb.temperature = um.temperature;
            }
        }
        if (um?.top_p !== undefined && um.top_p !== null) {
            rb.top_p = um.top_p;
        }

        // max_output_tokens
        if (um?.max_completion_tokens !== undefined) {
            rb.max_output_tokens = um.max_completion_tokens;
        } else if (um?.max_tokens !== undefined) {
            rb.max_output_tokens = um.max_tokens;
        }

        // Reasoning / thinking control
        // - enabled + effort  → reasoning: { effort }
        // - enabled + adaptive → omit reasoning (let the model decide)
        // - disabled           → reasoning: { effort: "none" }
        if (um?.enable_thinking === true) {
            if (um?.reasoning_effort && um.reasoning_effort !== "adaptive") {
                rb.reasoning = { effort: um.reasoning_effort };
            }
        } else {
            rb.reasoning = { effort: "none" };
        }

        // Tools (Responses function format) + ask_image injection for stored images
        const toolConfig = convertToolsToOpenAI(options);
        const toolList: ResponsesFunctionTool[] = [];
        if (toolConfig.tools) {
            for (const tool of toolConfig.tools) {
                toolList.push({
                    type: "function",
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                });
            }
        }
        if (this._hasImages) {
            const imgDef = ASK_IMAGE_TOOL_DEF as unknown as { function: { name: string; description: string; parameters: object } };
            toolList.push({
                type: "function",
                name: imgDef.function.name,
                description: imgDef.function.description,
                parameters: imgDef.function.parameters,
            });
            if (this._localImages.length >= 2) {
                const multiDef = ASK_WITH_MULTI_IMAGE_TOOL_DEF as unknown as { function: { name: string; description: string; parameters: object } };
                toolList.push({
                    type: "function",
                    name: multiDef.function.name,
                    description: multiDef.function.description,
                    parameters: multiDef.function.parameters,
                });
            }
        }
        if (toolList.length > 0) {
            rb.tools = toolList;
        }

        // tool_choice — only "auto" / "none" are accepted by TokenRhythm
        if (toolConfig.tool_choice === "none") {
            rb.tool_choice = "none";
        } else {
            rb.tool_choice = "auto";
        }

        return rb;
    }

    /**
     * Process the SSE stream from /v1/responses.
     */
    async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this._resetStreamState();
        this._responsesToolCallBuffers.clear();
        this._completedResponsesToolCalls.clear();

        const modelId = this._modelId;
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        let cancelDisposable: vscode.Disposable | undefined;
        if (token.onCancellationRequested) {
            cancelDisposable = token.onCancellationRequested(() => {
                try {
                    reader.cancel();
                } catch {
                    // ignore
                }
            });
        }

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) {
                        continue;
                    }
                    const data = line.slice(5).trim();
                    if (data === "[DONE]") {
                        await this.flushResponsesToolCalls(progress, false);
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data) as ResponsesStreamEvent;
                        await this.processResponsesEvent(parsed, progress);
                    } catch (e) {
                        console.error("[TokenRhythm] Failed to parse Responses SSE chunk:", e, "data:", data);
                        logger.error("responses.stream.chunk.error", {
                            modelId,
                            error: e instanceof Error ? e.message : String(e),
                            data,
                        });
                    }
                }
            }
            logger.debug("responses.stream.done", { modelId });
        } catch (e) {
            console.error("[TokenRhythm] Responses streaming error:", e);
            logger.error("responses.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
            throw e;
        } finally {
            cancelDisposable?.dispose();
            reader.releaseLock();
            this.reportEndThinking(progress);
        }
    }

    /**
     * Handle a single Responses API streaming event.
     */
    private async processResponsesEvent(
        event: ResponsesStreamEvent,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<void> {
        switch (event.type) {
            case "response.output_item.added": {
                const item = event.item as ResponsesFunctionCallItem | undefined;
                if (item?.type === "function_call") {
                    const idx = event.output_index ?? 0;
                    this._responsesToolCallBuffers.set(idx, {
                        id: item.id,
                        callId: item.call_id,
                        name: item.name,
                        args: typeof item.arguments === "string" ? item.arguments : "",
                    });
                    this.reportEndThinking(progress);
                }
                break;
            }
            case "response.reasoning_summary_text.delta": {
                if (event.delta) {
                    this._capturedReasoningContent += event.delta;
                    this.bufferThinkingContent(event.delta, progress);
                }
                break;
            }
            // Some models (e.g. deepseek-v4-flash-0731) emit reasoning_text.delta
            // instead of reasoning_summary_text.delta — treat both as thinking content.
            case "response.reasoning_text.delta": {
                if (event.delta) {
                    this._capturedReasoningContent += event.delta;
                    this.bufferThinkingContent(event.delta, progress);
                }
                break;
            }
            case "response.output_text.delta": {
                if (event.delta) {
                    this.reportEndThinking(progress);
                    const res = this.processTextContent(event.delta, progress);
                    if (res.emittedAny) {
                        this._hasEmittedAssistantText = true;
                    }
                }
                break;
            }
            case "response.function_call_arguments.delta": {
                const idx = event.output_index ?? 0;
                const buf = this._responsesToolCallBuffers.get(idx) ?? { args: "" };
                if (event.delta) {
                    buf.args += event.delta;
                }
                this._responsesToolCallBuffers.set(idx, buf);
                break;
            }
            case "response.function_call_arguments.done": {
                const idx = event.output_index ?? 0;
                const buf = this._responsesToolCallBuffers.get(idx) ?? { args: "" };
                if (typeof event.arguments === "string") {
                    buf.args = event.arguments;
                }
                this._responsesToolCallBuffers.set(idx, buf);
                await this.tryEmitBufferedResponsesToolCall(idx, progress);
                break;
            }
            case "response.output_item.done": {
                const item = event.item as ResponsesFunctionCallItem | undefined;
                if (item?.type === "function_call") {
                    const idx = event.output_index ?? 0;
                    await this.tryEmitBufferedResponsesToolCall(idx, progress);
                }
                break;
            }
            case "response.completed": {
                // Usage arrives on the completed event
                const usage = event.response?.usage as
                    | { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
                    | undefined;
                if (usage) {
                    const cacheHitTokens =
                        typeof usage.input_tokens_details?.cached_tokens === "number"
                            ? usage.input_tokens_details.cached_tokens
                            : undefined;
                    const streamUsage: StreamUsage = {
                        promptTokens: usage.input_tokens ?? 0,
                        completionTokens: usage.output_tokens ?? 0,
                        cacheHitTokens,
                        cacheMissTokens:
                            cacheHitTokens !== undefined ? (usage.input_tokens ?? 0) - cacheHitTokens : undefined,
                    };
                    this._onUsage?.(streamUsage);
                }
                await this.flushResponsesToolCalls(progress, false);
                break;
            }
            case "response.failed": {
                const err = event.error ?? event.response?.error;
                logger.error("responses.stream.failed", { modelId: this._modelId, error: err });
                if (err) {
                    throw new Error(`Responses API error: ${JSON.stringify(err)}`);
                }
                break;
            }
            default:
                // response.created / in_progress / content_part.* / output_text.done / etc. — no-op
                break;
        }
    }

    /**
     * Try to emit a buffered function_call as a LanguageModelToolCallPart.
     * ask_image / ask_with_multi_image are intercepted for the vision proxy.
     */
    private async tryEmitBufferedResponsesToolCall(
        outputIndex: number,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<void> {
        if (this._completedResponsesToolCalls.has(outputIndex)) {
            return;
        }
        const buf = this._responsesToolCallBuffers.get(outputIndex);
        if (!buf || !buf.name) {
            return;
        }

        // Intercept vision proxy tools
        if (buf.name === ASK_IMAGE_TOOL_NAME || buf.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
            const argsText = buf.args.trim() || "{}";
            const parsed = tryParseJSONObject(argsText);
            if (parsed.ok) {
                this.interceptedToolCall = {
                    id: buf.callId ?? buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                    name: buf.name,
                    args: parsed.value as { imageIndex?: number; imageIndices?: number[]; query: string },
                };
            }
            this._responsesToolCallBuffers.delete(outputIndex);
            this._completedResponsesToolCalls.add(outputIndex);
            return;
        }

        const parsed = tryParseJSONObject(buf.args.trim() || "{}");
        if (!parsed.ok) {
            return;
        }
        const id = buf.callId ?? buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        let parameters = parsed.value;
        parameters = this.adjustReadFileParameters(buf.name, parameters);
        progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
        this._responsesToolCallBuffers.delete(outputIndex);
        this._completedResponsesToolCalls.add(outputIndex);
    }

    /**
     * Flush remaining buffered tool calls (e.g., at stream end).
     */
    private async flushResponsesToolCalls(
        progress: Progress<LanguageModelResponsePart>,
        throwOnInvalid: boolean
    ): Promise<void> {
        if (this._responsesToolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(this._responsesToolCallBuffers.entries())) {
            if (this._completedResponsesToolCalls.has(idx)) {
                continue;
            }
            // Intercept vision proxy tools
            if (buf.name === ASK_IMAGE_TOOL_NAME || buf.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
                const parsed = tryParseJSONObject(buf.args.trim() || "{}");
                if (parsed.ok) {
                    this.interceptedToolCall = {
                        id: buf.callId ?? buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                        name: buf.name,
                        args: parsed.value as { imageIndex?: number; imageIndices?: number[]; query: string },
                    };
                }
                this._responsesToolCallBuffers.delete(idx);
                this._completedResponsesToolCalls.add(idx);
                continue;
            }
            const parsed = tryParseJSONObject(buf.args.trim() || "{}");
            if (!parsed.ok) {
                if (throwOnInvalid) {
                    throw new Error("Invalid JSON for tool call");
                }
                continue;
            }
            const id = buf.callId ?? buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            let parameters = parsed.value;
            parameters = this.adjustReadFileParameters(name, parameters);
            progress.report(new LanguageModelToolCallPart(id, name, parameters));
            this._responsesToolCallBuffers.delete(idx);
            this._completedResponsesToolCalls.add(idx);
        }
    }

    /**
     * Non-streaming message creation (used for Git commit generation).
     */
    async *createMessage(
        model: TokenRhythmModelItem,
        systemPrompt: string,
        messages: { role: string; content: string }[],
        baseUrl: string,
        apiKey: string,
        signal?: AbortSignal
    ): AsyncGenerator<{ type: "text"; text: string }> {
        const input: ResponsesInputMessage[] = messages.map((m) => ({
            role: (m.role === "assistant" || m.role === "user" || m.role === "system" ? m.role : "user") as "user" | "assistant" | "system",
            content: [{ type: "input_text" as const, text: m.content }],
        }));

        const body: Record<string, unknown> = {
            model: model.id,
            input,
            stream: false,
        };
        if (systemPrompt) {
            body.instructions = systemPrompt;
        }
        if (model.enable_thinking === false) {
            body.reasoning = { effort: "none" };
        } else if (model.reasoning_effort) {
            body.reasoning = { effort: model.reasoning_effort };
        }
        if (model.max_completion_tokens !== undefined) {
            body.max_output_tokens = model.max_completion_tokens;
        }

        const headers = CommonApi.prepareHeaders(apiKey, "openai", model.headers);
        const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Responses API error: [${response.status}] ${response.statusText}${errorText ? `\n${errorText}` : ""}`);
        }

        const json = (await response.json()) as {
            output?: ResponsesOutputItem[];
            output_text?: string;
            status?: string;
            error?: unknown;
        };
        if (json.status === "failed" || json.error) {
            throw new Error(`Responses API failed: ${JSON.stringify(json.error ?? json)}`);
        }
        if (json.output_text) {
            yield { type: "text", text: json.output_text };
        }
    }
}
