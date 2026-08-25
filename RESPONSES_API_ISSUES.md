# TokenRhythm Responses API 问题分析

> 本文档记录 TokenRhythm 平台 `/v1/responses` 端点（Responses API 协议）在与官方 OpenAI Responses API 对比时发现的问题、实测现象、对插件的影响以及插件侧的应对措施。
>
> 信息来源：`test/api-tests.mjs` 三协议实测（2026-08-03）、生产排障记录（`.copilot/api-reference.md`）、`src/responses/responsesApi.ts` 实现注释、AGENTS.md 开发记录。
> 最后更新：2026-08-25

---

## 1. 结论（TL;DR）

TokenRhythm 的 `/v1/responses` 是一个**部分实现**的 Responses API：

1. **拒绝 `function_call` / `function_call_output` 内容块** —— 多轮工具调用历史无法用标准结构化格式回填，只能"文本化"（`[tool_call]` / `[tool_result]` 标签），工具调用上下文质量受损；
2. **`tool_choice` 仅接受 `auto` / `none`** —— 缺失 `required` 与"指定工具"两种模式，无法强制模型调用工具；
3. **工具定义格式与自家 OpenAI 兼容端点不一致**（扁平 vs 嵌套），且**报错信息含糊**，不指出根因；
4. **流式推理事件类型因模型而异**（qwen 系发 `reasoning_summary_text.delta`，deepseek 发 `reasoning_text.delta`），网关未统一转换；
5. **端点整体仍在演进**，行为不稳定，插件默认不使用该协议（`tokenrhythm.enableResponsesApi` 默认关闭）。

**一句话**：Responses 协议最核心的价值——标准化的工具调用（`function_call` 块 + 多轮回填）——在该端点上被砍掉了，工具调用退化成文本标记，与成熟的 OpenAI 兼容格式相比没有优势、徒增复杂度，因此插件默认回退 OpenAI 格式。

---

## 2. 背景

### 2.1 什么是 Responses API

OpenAI 的 Responses API（`POST /v1/responses`）是其新一代对话协议，核心特性包括：

| 特性 | 官方支持 | TokenRhythm | 状态 |
|------|----------|-------------|------|
| 内容块类型 `input_text` / `output_text` / `input_image` | ✅ | ✅ | 一致 |
| 内容块类型 `function_call` / `function_call_output`（多轮工具历史） | ✅ | ❌ 拒绝 | **缺失** |
| 工具定义（扁平格式 `{type, name, description, parameters}`） | ✅ | ✅ | 一致 |
| `tool_choice`: `auto` / `none` / `required` / 指定工具 | ✅ | 仅 `auto` / `none` | **缺失** |
| 推理流式事件 `reasoning_summary_text.delta` / `reasoning_text.delta` | ✅（两种并存） | 因模型而异 | **不统一** |
| usage 在 `response.completed` 事件返回 | ✅ | ✅ | 一致 |

> 注：工具定义采用**扁平格式**这一点 TokenRhythm 是符合官方规范的（与 Assistants API 一致）。问题出在与**自家** `/chat/completions` 端点（嵌套格式）不一致，导致生态内工具定义无法直接复用。

### 2.2 TokenRhythm 的支持范围

- 仅 `supports_responses=true` 的模型可用（动态探测自 `/v1/models`，当前：`qwen3.7-max`、`qwen3.8-max`、`deepseek-v4-flash-0731`）；
- 插件侧开关：`tokenrhythm.enableResponsesApi`（默认关闭），`tokenrhythm.apiMode = "responses"` 可强制；
- 实测结果：**修正工具格式后基础场景全通过**（非流式/流式对话、工具调用、图片输入、reasoning 参数均 200）。

---

## 3. 问题清单（按严重程度）

### 3.1 🔴 P0：拒绝 `function_call` / `function_call_output` 内容块

**现象**

Responses API 官方允许在 `input` 数组中用结构化块回填历史工具调用：

```jsonc
// 官方标准（TokenRhythm 拒绝）
{ "role": "assistant", "content": [
    { "type": "function_call", "call_id": "call_1", "name": "get_weather", "arguments": "{\"city\":\"北京\"}" }
]},
{ "role": "user", "content": [
    { "type": "function_call_output", "call_id": "call_1", "output": "晴天 25度" }
]}
```

TokenRhythm 端点会拒绝这些块，**只接受 `input_text` / `output_text` / `input_image` 三种**。

**插件侧 workaround**：`ResponsesApi.convertMessages` 把历史工具调用/结果**文本化**：

```
assistant: [tool_call] get_weather({"city":"北京"}) [/tool_call]
user:      [tool_result] 晴天 25度 [/tool_result]
```

**影响**：

- 工具调用的结构化信息（`call_id`、参数、结果边界）退化成自由文本，模型对工具历史的理解依赖文本标记解析，多轮工具协作（Agent 模式核心场景）可靠性下降；
- VS Code 的 `LanguageModelToolCallPart` / `LanguageModelToolResultPart` 生态围绕结构化消息设计，Responses 模式需要额外一层文本化转换，实现复杂度高于 OpenAI/Anthropic 模式；
- 与插件自身其他模式行为不一致：OpenAI 模式用标准 `tool_calls` + `tool` role 回填，Anthropic 模式用 `tool_use` + `tool_result` 块回填，唯 Responses 模式是文本标记。

### 3.2 🔴 P0：`tool_choice` 仅接受 `auto` / `none`

**现象**

官方支持四种取值：`auto` / `none` / `required` / `{ "type": "function", "name": ... }`。TokenRhythm 只接受前两种，**`required` 与对象形式在思考模式下被拒**。

**插件侧 workaround**：`prepareRequestBody` 固定发送 `tool_choice: "auto"`（`none` 仅在显式关闭时使用），放弃强制工具调用。

**影响**：

- 无法强制模型走工具流程（如"必须调用 `get_weather`"），依赖模型自主决策；
- DeepSeek 等模型在 `auto` 下可能跳过工具直接作答，工具类任务（尤其视觉代理 `ask_image`）的成功率下降。

### 3.3 🟡 P1：工具定义格式与自家 OpenAI 端点不一致，且报错信息含糊

**现象**

- OpenAI 端点（`/chat/completions`）与 VS Code / OpenAI SDK 生态使用**嵌套格式**：`{"type":"function","function":{"name","description","parameters"}}`；
- Responses 端点要求**扁平格式**：`{"type":"function","name","description","parameters"}`；
- 把嵌套格式发给 Responses 端点，报错为：

  ```
  InvalidParameter: The parameters, when provided as a dict, must confirm to a valid
  openai-compatible JSON schema. Please check the schema definition for tool
  ```

  —— 报错指向"parameters schema 非法"，**完全没有提示是工具定义外层结构（嵌套 vs 扁平）的问题**，排查成本高。

**插件侧 workaround**：`ResponsesApi.prepareRequestBody` 显式把每个工具从嵌套结构展平为扁平结构（含 `ask_image` / `ask_with_multi_image` 视觉代理工具）。

**影响**：

- 任何直接复用 OpenAI 格式工具定义（含 VS Code 的 `convertToolsToOpenAI` 产物）的调用都会 400，必须经过转换层；
- 报错信息误导性强，第三方接入方（不看官方文档直接照搬 OpenAI 示例）会卡在排查上。

### 3.4 🟡 P1：流式推理事件类型因模型而异

**现象**

| 模型 | 推理流式事件 |
|------|-------------|
| `qwen3.7-max` / `qwen3.8-max` | `response.reasoning_summary_text.delta` |
| `deepseek-v4-flash-0731` | `response.reasoning_text.delta` |

同一端点、不同模型发出**不同的事件类型**——网关未做统一转换，直接透传各模型后端的事件。

**插件侧 workaround**：`processResponsesEvent` 同时监听两种事件类型，都按推理内容处理。

**影响**：

- 客户端必须为每个模型做事件类型兼容，无法按单一规范编写解析器；
- 说明端点是"模型各自实现"而非"统一网关规范化"，未来新增模型可能继续引入第三种事件类型。

### 3.5 🟢 P2：端点仍在演进，行为不稳定

AGENTS.md 与仓库记忆中的记录：

> "TokenRhythm 的 Responses 端点仍在演进（不同模型流式事件类型不一致、工具调用不稳定、多轮工具回填非常规）"

- 多轮工具调用参数拼接依赖 `function_call_arguments.delta` / `function_call_arguments.done` 事件，配合文本化回填后，多轮场景偶发工具调用丢失；
- 图片输入受模型限制（`qwen3.8-max` 要求图片 ≥ 10x10 像素，1x1 测试图被拒）——此项属模型限制而非协议问题，但说明端点未对输入做模型侧适配说明。

---

## 4. 官方标准 vs TokenRhythm 对照表

| 能力 | OpenAI 官方 `/v1/responses` | TokenRhythm `/v1/responses` | 对插件的影响 |
|------|------------------------------|------------------------------|-------------|
| `function_call` 内容块（多轮回填） | ✅ 支持 | ❌ 拒绝 | 文本化回填，工具历史结构化信息丢失 |
| `function_call_output` 内容块 | ✅ 支持 | ❌ 拒绝 | 同上 |
| `tool_choice = required` | ✅ 支持 | ❌ 拒绝 | 无法强制工具调用 |
| `tool_choice = {type,name}` | ✅ 支持 | ❌ 拒绝 | 无法指定工具 |
| 工具定义格式 | 扁平 | 扁平（但与自家 OpenAI 端点不一致） | 需展平转换层 |
| 工具格式报错 | — | 误导性报错（指向 schema 而非外层结构） | 排查成本高 |
| 推理事件 | 两种官方事件并存 | 因模型而异（未统一） | 解析器需双监听 |
| `reasoning: {effort}` | ✅ | ✅ | 无 |
| `input_image` | ✅ | ✅（≥10x10 像素限制） | 无（模型限制） |
| usage（`response.completed`） | ✅ | ✅ | 无 |

---

## 5. 插件侧的应对与建议

### 5.1 插件现状（已实现）

| 问题 | 插件应对 | 位置 |
|------|----------|------|
| 工具格式不一致 | 请求体显式展平为扁平格式 | `ResponsesApi.prepareRequestBody` |
| 拒绝 function_call 块 | 历史工具调用/结果文本化 `[tool_call]` / `[tool_result]` | `ResponsesApi.convertMessages` |
| tool_choice 受限 | 固定 `auto` / `none` | `ResponsesApi.prepareRequestBody` |
| 推理事件不统一 | 双监听 `reasoning_summary_text.delta` + `reasoning_text.delta` | `ResponsesApi.processResponsesEvent` |
| 整体不稳定 | **默认关闭**（`enableResponsesApi=false`），auto 模式优先 OpenAI/Anthropic | `provider.ts`、`package.json` |

> **结论性建议**：在平台补齐 3.1 / 3.2 两项（`function_call` 块 + `tool_choice` 完整支持）之前，**继续默认使用 OpenAI 兼容格式**。Responses 协议对 Copilot 场景的唯一价值是结构化工具调用，而该能力当前恰好是端点最薄弱的部分。

### 5.2 建议平台侧修复（按优先级）

1. **支持 `function_call` / `function_call_output` 内容块**——这是 Responses 协议的工具调用核心，补齐后插件可移除文本化回填；
2. **放开 `tool_choice` 至 `required` / 指定工具**——Agent 模式需要强制工具执行；
3. **统一推理事件类型**——网关层将各模型事件规范化为官方事件（或至少保证同一模型行为稳定）；
4. **改进工具格式报错**——检测到嵌套格式时明确指出"工具定义需扁平格式 `{type, name, description, parameters}`"，而非报 schema 错误。

---

## 6. 相关文件索引

| 文件 | 说明 |
|------|------|
| `src/responses/responsesApi.ts` | Responses 实现（convertMessages / prepareRequestBody / processStreamingResponse） |
| `src/responses/responsesTypes.ts` | Responses 类型定义 |
| `test/api-tests.mjs` | 三协议测试脚本（第 10–15 项为 Responses） |
| `test/README.md` | 平台差异记录（含扁平化问题） |
| `.copilot/api-reference.md` | API 参考与踩坑记录（§6 平台规则） |
| `AGENTS.md` | 项目架构与 Responses 模式说明（§2.3、§4.18） |
