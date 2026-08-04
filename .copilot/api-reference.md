# TokenRhythm API 参考记录

> 本文档记录 TokenRhythm 平台的 API 地址信息，供扩展开发与调试参考。
> 最后更新：2026-08-04

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
