# TokenRhythm API 参考记录

> ⚠️ **遇到 TokenRhythm API 集成问题（参数 400、协议不兼容、能力标记等）时，优先查看本文档和官方 API 文档**：
> - 官方 API 文档：<https://tokenrhythm.studio/docs/api-integration>
> - 调试时以官网示例（cURL/Node.js）为基准，对比插件请求体差异。
>
> 本文档记录 TokenRhythm 平台的 API 地址信息，供扩展开发与调试参考。
> 最后更新：2026-08-06

---

## 1. API 文档

| 项目 | 地址 |
|------|------|
| API 文档 | <https://tokenrhythm.studio/docs/api-integration> |
| 模型列表页 | <https://tokenrhythm.studio/models> |
| 注册 / 获取 API Key | <https://tokenrhythm.studio/register> |

---

## 2. 统一基础地址

```
https://tokenrhythm.studio/v1
```

所有端点均在统一基础地址下。

---

## 3. 主要端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/models` | `GET` | 模型列表（含能力标记 `supports_responses` / `supports_anthropic` 等） |
| `/v1/chat/completions` | `POST` | OpenAI 兼容对话 |
| `/v1/messages` | `POST` | Anthropic 兼容对话 |
| `/v1/responses` | `POST` | Responses API 对话（`supports_responses` 模型原生支持） |
| `/v1/embeddings` | `POST` | 向量嵌入 |

---

## 4. 代码中的引用位置

| 文件 | 常量 / 位置 |
|------|-------------|
| `src/apiModelList.ts` | `API_BASE_URL = "https://tokenrhythm.studio/v1/"` |
| `src/provider.ts` | `um?.baseUrl \|\| "https://tokenrhythm.studio/v1/"` |
| `src/gitCommit/commitMessageGenerator.ts` | `selectedModel.baseUrl \|\| "https://tokenrhythm.studio/v1/"` |
| `scripts/check-new-models.mjs` | `API_BASE_URL = "https://tokenrhythm.studio/v1/"` |
| `test/api-tests.mjs` | `BASE = "https://tokenrhythm.studio/v1"` |

---

## 5. 常见混淆说明

> **models.dev ≠ TokenRhythm API 文档**

- `models.dev`（<https://models.dev/models.json>）是 **OpenRouter 维护的全球模型目录数据库**，仅用于本扩展**自动模型发现**时获取新模型的规格元数据（上下文长度、视觉能力、工具调用、推理能力等），由 `src/modelsDev.ts` 下载并缓存。
- 扩展**实际请求**走的是上方 `https://tokenrhythm.studio/v1` 地址，两者用途不同，勿混淆。

---

## 6. 已确认的平台规则与踩坑记录

> 来源：官方文档示例 + `test/api-tests.mjs` 实测（2026-08-03）+ 2026-08-06 生产排障。

| 规则 | 说明 |
|------|------|
| Anthropic 协议必带头 | `anthropic-version: 2023-06-01` + 必须传 `max_tokens` |
| DeepSeek `tool_choice` | 传字符串 `none` / `auto` / `required`，**不要传对象形式** |
| OpenAI 端点 `thinking` | 仅接受字符串语义：`{ type: "enabled" }` / `{ type: "auto" }`（自适应；`adaptive` 会被拒绝）/ `{ type: "disabled" }` |
| Anthropic 端点 `thinking` | 已实测 `adaptive` / `disabled` 通过；`enabled` 未在测试中验证 |
| **Anthropic 模式 temperature/top_p** | **仅与 `thinking: {type:"enabled"}` 冲突 → 400 "请求参数组合无效"**（2026-08-06 实测 4 组合：enabled+temp→400、enabled+top_p→400、adaptive+temp+top_p→200、disabled+temp→200；生产复现 `trace_201493fe`）。符合 Anthropic 协议 extended thinking 须省略 temperature 的规则。**插件已修复：仅 thinking 强制 enabled 时跳过 temperature/top_p**（`src/anthropic/anthropicApi.ts` `prepareRequestBody`，adaptive/disabled 保留温度，top_k 恒保留） |
| **Anthropic 协议建议** | **建议优先使用 OpenAI 兼容格式**：Anthropic 端点对部分模型存在兼容性 bug（如 DeepSeek 系列强制思考 + temperature → 400"请求参数组合无效"），OpenAI 端点容忍该组合。仅在明确需要 Anthropic 原生 Messages 格式时使用 |
| 流式响应解析 | OpenAI SSE `choices[0].delta.content`；Anthropic 原生 Messages 流式事件。**两种协议不要混用解析器** |
| Responses 端点工具格式 | 工具定义需**扁平格式** `{ type: "function", name, description, parameters }`（OpenAI 嵌套 `function` 格式会被拒） |
| Responses `tool_choice` | 仅接受 `auto` / `none`（思考模式下拒绝 `required`/对象形式） |
| Anthropic 协议非全量 | `qwen3.7-max`、`kimi-k2.7-code` 不支持（`supports_anthropic=false`），以 `/v1/models` 动态标记为准 |
| qwen3.8-max 图片限制 | 图片尺寸必须 >= 10x10 像素 |
