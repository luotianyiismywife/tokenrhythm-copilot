/**
 * TokenRhythm API 三协议完整测试脚本 (v2 - 修正非流式/流式解析)
 *
 * 用法:
 *   node test/api-tests.mjs <API_KEY> [openai|anthropic|responses|all]
 */
const API_KEY = process.argv[2];
const filter = process.argv[3] || "all";
if (!API_KEY) {
    console.error("用法: node test/api-tests.mjs <API_KEY> [openai|anthropic|responses|all]");
    process.exit(1);
}

const BASE = "https://tokenrhythm.studio/v1";
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
    if (cond) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(`${name} ${detail}`);
        console.log(`  ❌ ${name} ${detail}`);
    }
}

/** 发送请求并完整解析：流式返回 SSE 事件数组，非流式返回 JSON body */
async function api(path, body, headers = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, ...headers },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    if (body.stream === true) {
        // SSE 流式
        parsed = text.split("\n")
            .filter(l => l.startsWith("data:") && l.trim() !== "data: [DONE]")
            .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
            .filter(Boolean);
    } else {
        // 非流式 JSON
        try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    return { ok: res.ok, status: res.status, body: parsed, raw: text.substring(0, 500) };
}

const TOOLS = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Get weather of a city",
            parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
        },
    },
];

/**
 * Responses 端点要求扁平工具格式（OpenAI 嵌套 function 格式不被接受）:
 *   { type: "function", name, description, parameters }
 * 这是 TokenRhythm Responses 端点与 OpenAI 端点的差异之一。
 */
const FLAT_TOOLS = [
    {
        type: "function",
        name: "get_weather",
        description: "Get weather of a city",
        parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
    },
];

/**
 * 生成一个指定尺寸的纯色 PNG base64（浏览器环境下无效，Node 下返回 null）。
 * Node 环境下使用硬编码的 100x100 红色 PNG。
 */
function makePng(width, height) {
    // 1x1 红色 PNG（仅用于验证最小可用性；qwen3.8-max 要求 >=10x10）
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}

async function testOpenAI() {
    console.log("\n=== OpenAI 协议 (/chat/completions) ===");

    console.log("--- 1. 非流式对话 ---");
    {
        const r = await api("/chat/completions", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "回复OK" }], stream: false });
        check("HTTP 200", r.ok, `s=${r.status} ${r.raw}`);
        check("content 存在", !!r.body?.choices?.[0]?.message?.content);
        check("usage 存在", !!r.body?.usage);
        check("reasoning_content 存在", "reasoning_content" in (r.body?.choices?.[0]?.message ?? {}));
    }

    console.log("--- 2. 流式对话 ---");
    {
        const r = await api("/chat/completions", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "用一句话介绍你自己" }], stream: true, stream_options: { include_usage: true } });
        check("流式文本增量", r.body.some(e => e.choices?.[0]?.delta?.content));
        check("流式推理增量", r.body.some(e => e.choices?.[0]?.delta?.reasoning_content));
        check("流式 usage chunk", r.body.some(e => e.usage));
    }

    console.log("--- 3. 流式工具调用 ---");
    {
        const r = await api("/chat/completions", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "请使用 get_weather 工具查询北京的天气" }], stream: true, tools: TOOLS, tool_choice: "auto" });
        const tcs = r.body.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []);
        check("收到 tool_calls", tcs.length > 0, `n=${tcs.length}`);
        const name = tcs.find(t => t.function?.name)?.function?.name;
        check("工具名正确", name === "get_weather", `n=${name}`);
    }

    console.log("--- 4. 多轮工具回填 ---");
    {
        const r = await api("/chat/completions", {
            model: "deepseek-v4-flash",
            messages: [
                { role: "user", content: "查询北京天气" },
                { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] },
                { role: "tool", tool_call_id: "call_1", content: "晴天 25度" },
            ],
            stream: false, tools: TOOLS,
        });
        check("多轮回填成功", r.ok && !!r.body?.choices?.[0]?.message?.content, `s=${r.status} ${r.raw}`);
    }

    console.log("--- 5. thinking 参数 ---");
    {
        const r1 = await api("/chat/completions", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "回复OK" }], stream: false, thinking: { type: "enabled" } });
        check("thinking=enabled", r1.ok, `s=${r1.status} ${r1.raw}`);
        const r2 = await api("/chat/completions", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "回复OK" }], stream: false, thinking: { type: "disabled" } });
        check("thinking=disabled", r2.ok, `s=${r2.status} ${r2.raw}`);
        const r3 = await api("/chat/completions", { model: "glm-5.2", messages: [{ role: "user", content: "回复OK" }], stream: false, thinking: { type: "enabled" }, reasoning_effort: "high" });
        check("GLM-5.2 thinking+effort", r3.ok, `s=${r3.status} ${r3.raw}`);
    }
}

async function testAnthropic() {
    console.log("\n=== Anthropic 协议 (/v1/messages) ===");
    const ANTH = { "anthropic-version": "2023-06-01" };

    console.log("--- 6. 非流式对话 ---");
    {
        const r = await api("/messages", { model: "deepseek-v4-flash", max_tokens: 512, messages: [{ role: "user", content: "回复OK" }] }, ANTH);
        check("HTTP 200", r.ok, `s=${r.status} ${r.raw}`);
        check("type=message", r.body?.type === "message");
        check("有文本块", r.body?.content?.some(b => b.type === "text" && b.text));
        check("有 thinking 块", r.body?.content?.some(b => b.type === "thinking"));
        check("usage 存在", !!r.body?.usage);
    }

    console.log("--- 7. 流式对话 ---");
    {
        const r = await api("/messages", { model: "deepseek-v4-flash", max_tokens: 256, stream: true, messages: [{ role: "user", content: "say OK" }] }, ANTH);
        const types = new Set(r.body.map(e => e.type));
        check("message_start", types.has("message_start"));
        check("content_block_delta", types.has("content_block_delta"));
        check("text_delta", r.body.some(e => e.delta?.type === "text_delta"));
        check("thinking_delta", r.body.some(e => e.delta?.type === "thinking_delta"));
        check("message_stop", types.has("message_stop"));
    }

    console.log("--- 8. 流式工具调用 ---");
    {
        const r = await api("/messages", {
            model: "deepseek-v4-flash", max_tokens: 512, stream: true,
            messages: [{ role: "user", content: "必须使用 get_weather 工具查询北京的天气" }],
            tools: [{ name: "get_weather", description: "Get weather of a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
            tool_choice: { type: "any" },
        }, ANTH);
        const tu = r.body.find(e => e.content_block?.type === "tool_use");
        check("收到 tool_use 块", !!tu, `n=${tu?.content_block?.name} ${r.raw}`);
        check("input_json_delta", r.body.some(e => e.delta?.type === "input_json_delta"));
    }

    console.log("--- 9. thinking 参数 ---");
    {
        const r1 = await api("/messages", { model: "deepseek-v4-flash", max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], thinking: { type: "adaptive" } }, ANTH);
        check("thinking=adaptive", r1.ok, `s=${r1.status} ${r1.raw}`);
        const r2 = await api("/messages", { model: "deepseek-v4-flash", max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], thinking: { type: "disabled" } }, ANTH);
        check("thinking=disabled", r2.ok, `s=${r2.status} ${r2.raw}`);
    }
}

async function testResponses() {
    console.log("\n=== Responses 协议 (/v1/responses) ===");
    const RESP_MODELS = ["qwen3.7-max", "deepseek-v4-flash-0731", "qwen3.8-max"];

    console.log("--- 10. 非流式对话 ---");
    {
        const r = await api("/responses", { model: "qwen3.7-max", input: [{ role: "user", content: [{ type: "input_text", text: "回复OK" }] }], stream: false });
        check("HTTP 200", r.ok, `s=${r.status} ${r.raw}`);
        check("status=completed", r.body?.status === "completed", `s=${r.body?.status}`);
        check("output_text 存在", !!r.body?.output_text);
        check("usage 存在", !!r.body?.usage);
    }

    console.log("--- 11. 流式对话 (三模型) ---");
    for (const model of RESP_MODELS) {
        const r = await api("/responses", { model, input: [{ role: "user", content: [{ type: "input_text", text: "用一句话介绍你自己" }] }], stream: true });
        const types = new Set(r.body.map(e => e.type));
        check(`${model} 流式文本`, r.body.some(e => e.type === "response.output_text.delta" && e.delta));
        check(`${model} 推理事件`, types.has("response.reasoning_summary_text.delta") || types.has("response.reasoning_text.delta"), [...types].filter(t => t.includes("reasoning")).join(","));
        check(`${model} completed+usage`, r.body.some(e => e.type === "response.completed" && e.response?.usage));
    }

    console.log("--- 12. 流式工具调用 ---");
    {
        const r = await api("/responses", {
            model: "qwen3.7-max",
            input: [{ role: "user", content: [{ type: "input_text", text: "查询北京天气" }] }],
            stream: true, tools: FLAT_TOOLS, tool_choice: "required", reasoning: { effort: "none" },
        });
        const fc = r.body.find(e => e.type === "response.output_item.added" && e.item?.type === "function_call");
        check("output_item.added function_call", !!fc, `n=${fc?.item?.name} ${r.raw}`);
        check("function_call_arguments.delta", r.body.some(e => e.type === "response.function_call_arguments.delta"));
        const done = r.body.find(e => e.type === "response.function_call_arguments.done");
        check("arguments.done 完整", !!done?.arguments, `a=${done?.arguments}`);
        if (done?.arguments) {
            check("参数可解析", (() => { try { JSON.parse(done.arguments); return true; } catch { return false; } })());
        }
    }

    console.log("--- 13. 工具调用回填（文本化） ---");
    {
        const r = await api("/responses", {
            model: "qwen3.7-max",
            input: [
                { role: "user", content: [{ type: "input_text", text: "查询北京天气" }] },
                { role: "assistant", content: [{ type: "output_text", text: '[tool_call] get_weather({"city":"北京"}) [/tool_call]' }] },
                { role: "user", content: [{ type: "input_text", text: "[tool_result] 晴天 25度 [/tool_result]" }] },
            ],
            stream: false, tools: FLAT_TOOLS,
        });
        check("文本化回填接受", r.ok && r.body?.status === "completed", `s=${r.status} ${r.raw}`);
    }

    console.log("--- 14. reasoning 参数 ---");
    {
        const r1 = await api("/responses", { model: "qwen3.7-max", input: [{ role: "user", content: [{ type: "input_text", text: "回复OK" }] }], stream: false, reasoning: { effort: "none" } });
        check("reasoning=none", r1.ok, `s=${r1.status} ${r1.raw}`);
        const rt = r1.body?.usage?.output_tokens_details?.reasoning_tokens;
        check("reasoning=none 无推理tokens", rt === 0, `rt=${rt}`);
        const r2 = await api("/responses", { model: "qwen3.7-max", input: [{ role: "user", content: [{ type: "input_text", text: "回复OK" }] }], stream: false, reasoning: { effort: "high" } });
        check("reasoning=high", r2.ok, `s=${r2.status} ${r2.raw}`);
    }

    console.log("--- 15. 图片输入 (qwen3.8-max) ---");
    {
        // 注意: qwen3.8-max 要求图片至少 10x10 像素（1x1 会被拒绝）
        const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAJUlEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAADXBjZgAAH6vF+JAAAAAElFTkSuQmCC";
        const r = await api("/responses", {
            model: "qwen3.8-max",
            input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${pngB64}` }, { type: "input_text", text: "这张图是什么颜色？" }] }],
            stream: false,
        });
        check("qwen3.8-max 图片输入", r.ok && r.body?.status === "completed", `s=${r.status} ${r.raw}`);
    }
}

async function testErrors() {
    console.log("\n=== 公共: 错误处理 ===");

    console.log("--- 16. 无效模型 ID ---");
    {
        const r = await api("/chat/completions", { model: "nonexistent-model-xyz", messages: [{ role: "user", content: "hi" }], stream: false });
        check("无效模型返回 4xx", r.status >= 400 && r.status < 500, `s=${r.status}`);
        check("错误含 message", !!r.body?.error?.message || !!r.body?.message);
    }

    console.log("--- 16b. Anthropic 不支持的模型 (qwen3.7-max) ---");
    {
        const r = await api("/messages", { model: "qwen3.7-max", max_tokens: 256, messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2023-06-01" });
        check("qwen3.7-max Anthropic 返回错误", !r.ok && r.status >= 400, `s=${r.status} ${r.raw}`);
    }
}

async function main() {
    console.log(`TokenRhythm API 测试 (filter=${filter})`);
    console.log(`模型能力: responses=[qwen3.7-max, deepseek-v4-flash-0731, qwen3.8-max]`);

    if (filter === "all" || filter === "openai") await testOpenAI();
    if (filter === "all" || filter === "anthropic") await testAnthropic();
    if (filter === "all" || filter === "responses") await testResponses();
    if (filter === "all") await testErrors();

    console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
    if (failures.length) {
        console.log("失败项:");
        failures.forEach(f => console.log(`  - ${f}`));
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("测试执行异常:", e); process.exit(1); });
