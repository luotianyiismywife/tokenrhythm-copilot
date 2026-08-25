# TokenRhythm API 参考记录

> ⚠️ **遇到 TokenRhythm API 集成问题（参数 400、协议不兼容、能力标记等）时，优先查看本文档和官方 API 文档**：
> - 官方 API 文档：<https://tokenrhythm.studio/docs/api-integration>
> - 调试时以官网示例（cURL/Node.js）为基准，对比插件请求体差异。
> - **Responses API（`/v1/responses`）问题分析见根目录 [`RESPONSES_API_ISSUES.md`](../RESPONSES_API_ISSUES.md)**（工具格式扁平化、拒绝 function_call 块、tool_choice 受限等）。
>
> 本文档记录 TokenRhythm 平台的 API 地址信息，供扩展开发与调试参考。
> 最后更新：2026-08-25

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

---

## 7. 用户中心 API（cookie 认证，`/api/*`）

> 与 `/v1/*`（Bearer API Key）是两套体系。用户中心 `/api/*` 用 `tr_session` cookie 认证，
> 用于查询账号信息、余额、调用日志、API Key 管理等。基础地址 `https://tokenrhythm.studio`（无 `/v1`）。

### 7.1 已确认端点

| 端点 | 方法 | 认证 | 用途 | CSRF |
|------|------|------|------|------|
| `/api/usage-summary` | GET | tr_session | 余额 + 用量汇总（`balanceCny`/`availableBalanceCny`/`expiringBalanceCny`/`nextExpiryAt`） | 无 |
| `/api/auth/me` | GET | tr_session | 当前账号信息（id/name/phoneMasked/status/role）；**响应会 Set-Cookie 下发 `tr_csrf`** | 无 |
| `/api/api-keys` | GET | tr_session | API Key 列表（`data` 数组，含 `id`/`name`/`maskedKey`/`keyPrefix`/`status`/`lastUsedAt`/`createdAt`） | 无 |
| `/api/api-keys` | POST | tr_session + CSRF | 创建 API Key，body `{"name":"..."}`，返回含完整 `key`（仅此次展示） | **有** |
| `/api/api-keys/{id}/delete` | POST | tr_session + CSRF | 删除指定 API Key（注意是 POST 不是 DELETE） | **有** |
| `/api/call-logs/page` | GET | tr_session | 调用日志分页（`startAt`/`endAt`/`page`/`pageSize`） | 无 |

### 7.2 API Key 列表返回结构（GET /api/api-keys）

```jsonc
{
  "code": 0,
  "message": "ok",
  "data": [
    {
      "id": "043ea3b0-7037-4251-922c-bae7b9bde8cc",
      "name": "默认 API Key",
      "maskedKey": "sk_tr_68****7R0gHo",
      "keyPrefix": "sk_tr_68Hxko",
      "status": "enabled",          // enabled / disabled
      "lastUsedAt": "2026-08-24T02:46:49.699Z",  // 可能为 null
      "createdAt": "2026-08-22T22:56:21.714Z"
    }
  ],
  "traceId": "trace_..."
}
```

> **可用 Key 数量**：`data.filter(k => k.status === "enabled").length`。平台上限 10 个（停用/删除的不占上限），网页显示为 "可用 Key N / 10"。

### 7.3 CSRF 机制（创建/删除 key）

创建/删除 API Key 受 CSRF 保护，需三重校验：

1. **`tr_session` cookie**（认证）
2. **`tr_csrf` cookie + `x-csrf-token` header**（值相同；`tr_csrf` 可通过 `GET /api/auth/me` 响应的 Set-Cookie 获取）
3. **反爬 cookie**：`_c_WBKFRo` + `tr_ref_device` + `_nb_ioWEgULi`（网页加载时服务端/JS 下发）

### 7.4 ⚠️ 创建/删除 key 的 TLS 指纹硬障碍（2026-08-24 实测）

**结论：Node.js / curl 无法创建/删除 key，只有真实浏览器环境能通过。**

实测（2026-08-24，cookie + headers 完全相同）：

| 调用方式 | 结果 |
|----------|------|
| 浏览器页面内 `fetch`（`credentials: "include"` + `x-csrf-token` header） | ✅ 200 成功创建/删除 |
| Node.js `fetch`（带完全相同 cookie + headers + sec-ch-ua） | ❌ 403 CSRF_INVALID |
| curl（带完全相同 cookie + headers + sec-ch-ua） | ❌ 403 CSRF_INVALID |

`_c_WBKFRo` 在同一浏览器内是固定值（刷新 3 次不变），但 Node.js/curl 带上它仍被拒。
说明服务端用了 **TLS 指纹校验（JA3/JA4）**——只有真实浏览器的 TLS 握手能通过，
Node.js（undici）和 curl 的 TLS 指纹被识别并拒绝。

**影响**：VS Code 扩展运行在 Node.js 环境，**无法绕过 TLS 指纹校验**，
因此纯 API 方式创建/删除 key 不可行。查询（GET）不受影响，稳定可用。

> 若未来需实现创建/删除，只能用 `vscode.window.createWebviewPanel` 内嵌
> `/account/keys` 页面让用户在真实浏览器环境操作，非纯 API 调用。
