# TokenRhythm Copilot Provider — AGENTS.md

> **所有更改必须通过 `npm run compile` / `npx tsc --noEmit` 编译检查无错误通过。**  
> **每次更改后，必须同步更新本文档 (`AGENTS.md`) 以反映代码变更。**

---

## 目录

1. [项目详细介绍](#1-项目详细介绍)
2. [详细逻辑架构](#2-详细逻辑架构)
3. [程序文件索引](#3-程序文件索引)
4. [函数定义大全](#4-函数定义大全)
5. [编译与构建](#5-编译与构建)
6. [开发规范](#6-开发规范)

---

## 1. 项目详细介绍

### 1.1 概述

**TokenRhythm Copilot Provider** 是一个 VS Code 扩展，它将 TokenRhythm 平台的 AI 语言模型集成到 GitHub Copilot Chat 中。用户可以在 VS Code 的 Copilot Chat 界面中选择并使用 TokenRhythm 提供的各种模型（如 DeepSeek、GLM、Qwen、MiMo、MiniMax、Kimi 等系列），享受智能代码补全、聊天对话、Git 提交消息生成等功能。

### 1.2 核心能力

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider` 接口，向 VS Code 注册为 `tokenrhythm` 厂商 |
| **多 API Key 轮询** | 支持多个 API Key（SecretStorage 加密存储 `tokenrhythm.apiKeys`），两种模式：`rotation`（默认，轮询使用、跳过不可用 key）/ `single`（仅用当前 key；不可用时按 `tokenrhythm.singleKeyFallback` 设置报错或自动切换并弹窗提示）。**主动余额预检为核心**：每个 key 可绑定 `tr_session` cookie（一个 cookie 可绑定多个 key，余额按 cookie 粒度查询并缓存），请求前查余额 ≤ `minBalanceCny` 自动跳过；**被动检测兜底**：cookie 缺失/失效/网络失败时按请求错误（402 余额不足 / 401 无效 Key / 429 限流 / 503 服务端繁忙，状态码与文本 patterns 均可配置）判定 key 失效并切换——**402/401 持久化 `available=false`（确定性），429/503 仅内存冷却不持久化（瞬态，冷却到期自动恢复）**。**手动检测**：`tokenrhythm.manageApiKeys` 命令 QuickPick 管理（增删/设为当前/绑定 cookie/重置失效/检测可用性——查余额 + 最小真实聊天请求 `say ok`，实测余额不足时 402 拦截不耗 token）。**UI 增强**：表单式批量导入（三元组 cookie/key/备注，逐条输入）、检测二级界面（列出全部 key 状态 + "检测所有"选项）、编辑 API Key（三字段 value/cookie/label，冲突校验）、**轮询模式下隐藏"设为当前使用"**（★ Current 标记与动作项均仅 single 模式显示）、批量导入时已存在 key 自动更新 cookie 不重复添加、**管理主界面与检测二级界面均显示每个 key 的余额**（绑定 cookie 时经 `getBalanceCached` TTL 缓存查询：余额 > `minBalanceCny` 显示 `$(coin) ¥X.XX`，余额 ≤ `minBalanceCny` 显示 `$(error) ¥X.XX` 即轮询会被跳过的 key，查询失败显示 `$(warning) 余额未知`，未绑定 cookie 不显示余额）。**全部 key 用尽时**：轮换循环跟踪每个 key 的失败原因，报错列出脱敏 key + 原因，并区分"瞬态失败请稍后重试"（429/503）与"确定性失败请检测"（402/401）。旧版单 key `tokenrhythm.apiKey` 自动迁移。`/v1/models` 实测不校验余额（余额 < 0 也 200），模型列表/启动同步用任意有效 key 即可 |
| **多模型支持** | 内置 14 个模型定义，覆盖 6 大模型系列，统一通过推理强度选择器切换思考模式。支持自动模型发现：开启后从 API 获取模型列表，自动过滤不可用模型并发现新增模型 |
| **自动模型发现** | 通过 `tokenrhythm.enableAutoModelDiscovery` 配置（默认开启）。启动时从 `/v1/models` 获取当前可用模型 ID 列表及能力标记（含 `supports_responses`），过滤内置模型列表（不可用模型自动隐藏）。新增模型从 `models.dev` 数据库获取元数据（上下文长度、视觉能力、工具调用、推理能力等）并自动添加，`thinkingMode` 从 `reasoning` 字段推断（支持推理→switchable，不支持→always）。API 不可用时静默回退到全量内置列表。内存缓存（5 分钟 TTL）。**按 API 模式过滤**：模型列表还会按 `tokenrhythm.apiMode` 过滤——`auto`/`openai` 显示全部（所有模型均支持 OpenAI 格式），`anthropic` 仅显示 `supports_anthropic=true` 的模型，`responses` 仅显示 `supports_responses=true` 的模型；能力集合为空（API 探测失败）时回退显示全部。**动态刷新**：通过 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+），切换 `apiMode` / `enableAutoModelDiscovery` 设置时自动重新拉取模型列表并刷新选择器，**无需 reload 窗口** |
| **启动模型同步** | 通过 `tokenrhythm.syncModelsOnStartup` 配置（默认开启）。每次 VS Code 打开时自动检查 API 是否有新模型，**每日最多同步一次**（`globalState` 记录上次同步日期）。同步结果以**一行日志**输出到「TokenRhythm」输出通道（`models.sync` 标签，含状态/说明），**不写任何文件**（v1.7.0 起不再写工作区 `.copilot/model-sync-log.md`——该文件会污染用户仓库，见 issue #1）。无 API Key、API 不可用时记录失败事件且不标记为已同步（下次打开重试） |
| **三协议 API 模式** | 同时支持 **OpenAI 兼容格式** (`/chat/completions`)、**Anthropic 格式** (`/v1/messages`) 和 **Responses API 格式** (`/v1/responses`)。可通过设置 `tokenrhythm.apiMode`（默认 `auto`）手动切换：`auto` 跟随各模型默认格式，`openai` 强制 OpenAI 格式，`anthropic` 强制 Anthropic 格式，`responses` 强制 Responses 格式。开关对聊天请求和 Git 提交消息生成均生效。启动时自动读取 `/v1/models` 的 `supports_responses` / `supports_anthropic` 字段并**缓存动态标记**（不硬编码模型 ID，未来新支持协议的模型自动生效）。**auto 模式优先级**：`enableResponsesApi`（默认关闭）→ `enableAnthropicApi`（默认关闭）→ 兜底 OpenAI。默认关闭原因：① TokenRhythm 的 Responses 端点仍在演进（不同模型流式事件类型不一致、工具调用不稳定、多轮工具回填非常规）；② **Anthropic 格式对部分模型存在兼容性 bug**（如 DeepSeek 系列强制思考 + temperature/top_p → 400"请求参数组合无效"，2026-08-06 实测，插件已修复仅强制思考时跳过温度）。**建议默认使用更成熟的 OpenAI 兼容格式** |
| **流式推理** | 支持 SSE (Server-Sent Events) 流式响应，实时输出文本和工具调用 |
| **Thinking/推理** | 支持模型的推理过程展示 ("thinking" 状态)，包括 XML think 块解析 |
| **工具调用 (Tool Calling)** | 支持 VS Code 的 LanguageModelToolCallPart 机制 |
| **图片代理 (Tool-based)** | 为不支持视觉的模型注入 `ask_image` 工具，模型可自主选择调用视觉模型（默认 Kimi K2.6）回答关于图片的具体问题，支持两轮 API 请求完成"调用工具→提问→获取答案→继续回答"的完整流程。与旧版 `describe_image` 不同，`ask_image` 允许模型针对图片提出具体问题（如"按钮是什么颜色？"），视觉模型会针对性回答。视觉模型 ID、查询提示词和思考模式均可通过设置配置；视觉代理会在同一个 thinking 块中显示“正在根据图片提问：[问题]”并实时追加视觉模型流式输出。**跨轮视觉历史持久化（v1.8.0）**：每轮视觉代理完成后输出私有 MIME（`application/vnd.opencodego.vision-tool-history+json`）的 `LanguageModelDataPart`，VS Code 自动带入下一轮对话；下次请求 `convertMessages`（OpenAI/Anthropic）识别该 DataPart 并重建标准 tool call + tool result 消息，模型不会忘记之前看过的图片 |
| **上下文窗口声明** | `maxInputTokens` 按真实上下文窗口的**可配置比例**声明（内置模型与自动发现模型均适用，默认 `1.0` 即完整窗口，可通过设置 `tokenrhythm.maxInputTokensRatio` 调整，范围 0.1–1.0，**建议 0.8**）。VS Code agent 模式的自动压缩（`chat.summarizeAgentConversationHistory.enabled`，约在 `maxInputTokens` 的 90% 触发）在比例 0.8 时于真实上下文的约 **72%** 处触发，避免按完整上下文（如 1M token）声明时压缩永不触发的问题。`context_length` / `max_completion_tokens` 保持真实值不变（用于 API 请求体） |
| **Token 计数** | 使用 `o200k_base` tiktoken 分词器精确统计 token 用量 |
| **状态栏** | 实时显示当前会话 token 使用量、累计用量、缓存命中率 |
| **原生 Token 指示器** | 始终启用，向 Copilot Chat 原生 Token 指示器报告 token 用量。通过发送 MIME 类型为 `usage` 的 `LanguageModelDataPart`（TextEncoder 编码 JSON）实现，无需自建状态栏。依赖 VS Code/Copilot Chat 1.116+ 对外部模型 `usage` data part 的识别 |
| **高级 Token 指示器** | 可通过 `tokenrhythm.enableThirdPartyTokenIndicator` 配置（默认开启）控制 VS Code 状态栏中的高级Token计数器。关闭后仅显示原生指示器。状态栏**仅在用户实际使用本插件提供的模型时显示**：启动时隐藏，发起 tokenrhythm 模型请求时显示，停止使用（空闲 60 秒）后自动隐藏，避免使用其他模型时残留上下文信息 |
| **Git 提交消息生成** | 一键生成 Conventional Commit 格式的 Git 提交消息，支持 `auto` 语言模式自动从历史提交检测语言 |
| **多仓库支持** | 支持多根工作区 (multi-root) 中多个 Git 仓库的提交消息生成 |
| **模型预设** | 支持通过命令面板快速切换 temperature/top_p 预设（🎯 Precise/⚖️ Balanced/🔥 Creative），也支持手动自定义输入 |
| **国际化** | 内置简体中文 (zh-cn) 中英文双语界面 |
| **重试机制** | 可配置的指数退避重试策略，应对网络抖动和限流 (429) |
| **请求延迟** | 可配置的请求间隔延迟，避免触发 API 限流 |
| **超时控制** | 可配置的请求超时时间（默认 10 分钟） |
| **立即取消** | 取消请求时通过 `reader.cancel()` 立即中断流式读取，停止后台接收 |
| **视觉代理配置** | 支持通过设置 `tokenrhythm.visionProxyModel`、`tokenrhythm.visionProxyThinking` 配置图片代理所使用的视觉模型和思考模式。`tokenrhythm.visionProxyThinking` 默认关闭，关闭时内部请求通过 `modelOptions.thinking={ type: "disabled" }` / `reasoning_effort="disabled"` 禁用视觉模型思考，最终 OpenAI 兼容请求体发送 `thinking: { type: "disabled" }`。**视觉代理模型动态选择**：`tokenrhythm.setVisionProxyModel` 命令从 `/v1/models` 动态加载 `supports_vision=true` 的模型列表（实测含 kimi-k2.5/k2.6/k2.7-code、qwen3.8-max、seed-2.1-turbo/pro），QuickPick 选择代替手填；API 不可用时回退手填 |
| **安装欢迎页 (Walkthrough)** | 首次安装且未配置 API Key 时自动打开引导向导，指引用户设置 API Key 和打开语言模型管理器。包含 3 个步骤：设置 API Key、显示模型、高级设置。通过 `onStartupFinished` 激活事件确保在 VS Code 启动后立即检测 |

### 1.3 模型清单

> **自动模型发现**（默认开启）会从 API 获取当前可用模型列表，自动隐藏不在列表中的内置模型，并从 models.dev 自动添加 API 返回的新模型。以下为全量内置模型定义，实际显示情况取决于 API 可用性。

#### 内置模型

| 系列 | 模型 ID | 视觉 | 推理强度选择器 | API 格式 |
|------|---------|------|----------------|----------|
| GLM | `glm-5.2`, `glm-5.1`, `glm-5` | ❌ | `禁用思考` / `高` / `最大` (5.2)² / `思考`（5.1/5 不支持思考切换） | OpenAI |
| Kimi | `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`¹ | ✅ | `思考`（不支持思考切换） | OpenAI |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-0731`³ | ❌ | `禁用思考` / `高` / `极高` | OpenAI / Responses⁵ |
| MiMo | `mimo-v2.5-pro` | ❌ | `禁用思考` / `思考` | OpenAI |
| MiniMax | `minimax-m2.7`, `minimax-m2.5` | ❌ | `思考`（不支持思考切换） | OpenAI |
| Qwen | `qwen3.7-max`⁴, `qwen3.8-max`⁶ | ❌/✅⁶ | `禁用思考` / `思考` | OpenAI / Responses⁵ |

> ¹ `kimi-k2.7-code` 不支持设置 Temperature/Top-p 参数。
> ² GLM-5.2 支持通过 reasoning_effort 设置 thinking 强度 (high/max)，GLM-5.1/GLM-5 不支持 thinking 切换。
> ³ `deepseek-v4-flash-0731` 同时支持 OpenAI 与 Responses 协议（supports_responses=true）。
> ⁴ `qwen3.7-max` 仅支持 OpenAI/Responses 协议（supports_anthropic=false）。
> ⁵ Responses 能力**动态探测**：启动时读取 `/v1/models` 的 `supports_responses` 标记，不硬编码模型 ID——未来任何模型获得 Responses 支持都会自动生效。协议**默认关闭**（`enableResponsesApi=false`），默认使用 OpenAI 兼容格式。
> ⁶ `qwen3.8-max`（测试中）支持文本与图像输入（视觉 ✅），1M 上下文 / 131.1K 输出，原生支持 Responses API。

> 模型清单来源于 [TokenRhythm 模型页](https://tokenrhythm.studio/models)。图片生成模型（`qwen-image-2.0`、`wan2.7-image`）不适用于 Chat，已排除。

在模型选择器中，内置模型归入 `TokenRhythm` 分组（`family="TokenRhythm"`）。

> 所有模型在模型选择器中均显示**一个条目**，通过**推理强度选择器**（中文标签）切换思考模式。  
> - `thinkingMode="switchable"`：用户可选择`禁用思考`、`自动`或启用思考（强度可配置）  
> - `thinkingMode="adaptive"`：仅`禁用思考`和`自动`两档选择，无强制启用思考选项  
> - `thinkingMode="always"`：推理始终启用，选择器中不显示`禁用思考`选项（模型特性）  
> 
> **关于图像输入：** 所有模型（包括非视觉模型）的 `imageInput` 能力均声明为 `true`，以确保 VS Code 始终传递图片数据。非视觉模型通过内部的 `ask_image` 工具代理机制处理图片，不直接支持视觉输入。

---

## 2. 详细逻辑架构

### 2.1 总体数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Copilot Chat                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  用户发送消息 → LanguageModelChatProvider                     │  │
│  │                    ↓                                          │  │
│  │  TokenRhythmChatModelProvider (provider.ts)                    │  │
│  │   1. 获取模型配置 (getBuiltInModelConfig)                     │  │
│  │   2. 获取 API Key (SecretStorage)                             │  │
│  │   3. 计算 Token 用量 (provideToken → statusBar)               │  │
│  │   3b. 可选: 向 Copilot Chat 原生 Token 指示器报告用量          │  │
│  │       (LanguageModelDataPart, MIME type "usage", VS Code 1.116+)│  │
│  │   4. 应用请求延迟 (delay)                                     │  │
│  │   5. 构建请求 → API 路由选择                                  │  │
│  │      ├─ apiMode="openai"     → OpenaiApi                    │  │
│  │      ├─ apiMode="anthropic"  → AnthropicApi                 │  │
│  │      └─ apiMode="responses"  → ResponsesApi                 │  │
│  │   6. 发送 HTTP 请求 (fetch with undici + 超时控制)             │  │
│  │   7. 流式解析响应 → Progress<LanguageModelResponsePart2>      │  │
│  │      ├─ LanguageModelTextPart     (文本)                      │  │
│  │      ├─ LanguageModelThinkingPart (推理过程)                  │  │
│  │      └─ LanguageModelToolCallPart (工具调用)                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        Git 提交消息生成                              │
│  SCM 标题栏按钮 → generateCommitMsg()                              │
│    → 获取 Git Diff (gitUtils.ts)                                   │
│    → 获取最近提交风格参考                                          │
│    → 构建 prompt → 调用 API (OpenaiApi/AnthropicApi/ResponsesApi)  │
│    → 流式输出到 SCM InputBox                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 扩展激活流程

```
activate(context)
  ├── logger.init()                         ← 创建 LogOutputChannel
  ├── TokenizerManager.initialize()         ← 加载 o200k_base.tiktoken
  ├── initStatusBar()                       ← 创建状态栏条目
  ├── new TokenRhythmChatModelProvider()      ← 创建 Provider 实例
  ├── vscode.lm.registerLanguageModelChatProvider("tokenrhythm", provider)
  ├── 注册命令:
  │   ├── tokenrhythm.setApiKey                ← 设置 API Key
  │   ├── tokenrhythm.getApiKey                ← 打开 TokenRhythm 官网获取 Key
  │   ├── tokenrhythm.openSettings             ← 打开扩展设置页
  │   ├── tokenrhythm.generateGitCommitMessage ← 生成提交消息
  │   ├── tokenrhythm.abortGitCommitMessage    ← 中止生成
  │   └── tokenrhythm.setModelPreset           ← 设置模型预设
  ├── showWelcomeIfNeeded()                 ← 首次安装时显示欢迎向导
  ├── syncModelsOnStartup(context)           ← 启动模型同步（每日最多一次，结果以一行日志输出）
  └── 注册 dispose 清理
```

### 2.3 聊天请求处理流程

```
provideLanguageModelChatResponse(model, messages, options, progress, token)
  │
  ├── 1. 解析模型 ID → getBuiltInModelConfig(model.id)
  │       格式: "baseId"（无 :: 后缀）
  │       所有模型注册为单一条目
  │       内置模型查找失败时回退到 getAutoDiscoveredModelConfig(model.id)
  │
  ├── 2. 应用用户配置的 reasoningEffort
  │       ├── "disabled" → 关闭思考（always 模型除外）
  │       ├── "adaptive" → 开启思考，自动模式（OpenAI 端点发送 thinking: { type: "auto" }，Anthropic 端点发送 { type: "adaptive" }）
  │       ├── "enabled" → 开启思考，使用默认推理力度
  │       ├── "high"/"max" → 开启思考，指定推理力度
  │
  ├── 2b. 注入 temperature/top_p（模型预设或自定义设置）
  │       ├── preset 模式 → 注入预设的 temperature（不传入 top_p，由模型使用默认值）
  │       └── custom 模式 → 注入用户自定义的 temperature 和 top_p（如有设置）
  │
  ├── 2c. 注入 vision 配置
  │       └── modelConfig.vision = um?.vision ?? false
  │
  ├── 3. 确定 API 模式 (apiMode: "openai" | "anthropic" | "responses")
  │       ├── 读取设置 tokenrhythm.apiMode (auto/openai/anthropic/responses)
  │       ├── "openai"/"anthropic"/"responses" → 强制使用对应协议
  │       ├── "auto" → 优先级探测：
  │       │   ├── enableResponsesApi=true 且模型 ∈ supports_responses 集合 → responses
  │       │   ├── enableAnthropicApi=true 且模型 ∈ supports_anthropic 集合 → anthropic
  │       │   └── 否则 → openai
  │       └── 默认（两开关均关闭）→ 全部使用 openai
  │
  ├── 4. 记录请求开始日志
  │
  ├── 5. 更新状态栏 Token 用量
  │
  ├── 6. 应用请求延迟 (delay)
  │
  ├── 7. 确保至少一个 API Key 存在（ensureApiKey → keyManager.getApiKeyStore）
  │       └── 无 key 时弹输入框引导添加第一个
  │
  ├── 8. 创建请求超时 AbortController
  │      └── 连接 VS Code 取消令牌 → abort()
  │
  ├── 9. 创建 undici fetch (自定义 bodyTimeout)
  │
  ├── 9b. 获取 Response body reader 后，注册取消回调
  │      └── `token.onCancellationRequested` / `signal.addEventListener("abort")`
  │      └── 调用 `reader.cancel()` 立即中断流，使 `reader.read()` 返回 `{ done: true }`
  │
  │
  ├── 9c. **多 Key 轮换循环**（外层 while(true)，每轮选一个 key，`failedKeys` 跟踪各 key 失败原因）:
  │       ├── pickNextApiKey(secrets, apiKeyMode)
  │       │   ├── rotation → 从轮询游标环形扫描第一个可用 key，游标前移
  │       │   ├── single → active key；不可用且 singleKeyFallback=switch → 降级 rotation + 弹窗提示
  │       │   └── 全部不可用 → 报错 "所有 API Key 均不可用"
  │       ├── 主动余额预检（balanceCheckEnabled 且有 cookie）:
  │       │   ├── checkKeyBalance(cookie) → 按 cookie 粒度查 /api/usage-summary（TTL 缓存），返回余额值供日志记录
  │       │   ├── 余额 ≤ minBalanceCny（默认 0，即余额 ≤ 0 视为不足）→ markApiKeyExhausted(balance) + continue 换下一个 key
  │       │   └── 曾标记不可用但余额恢复 → markApiKeyAvailable（自愈）
  │       ├── 用当前 key 构造 requestHeaders → _executeApiRequest()（见步骤 10 协议分发）
  │       ├── 成功 → break 循环；曾不可用 → 自愈置可用
  │       └── 失败: isKeyRotationError(err)（状态码 [401]/[402]/[429]/[503] 或文本 patterns 可配置）
  │           ├── getKeyRotationReason(err) → 402/401 → markApiKeyExhausted(持久化 available=false) + continue 换 key
  │           ├── 429/503 → markApiKeyExhausted(仅内存冷却，不持久化) + continue 换 key
  │           ├── 取消/超时/其他错误（400/403/500/网络/IMAGE_SENSITIVE）→ 抛给外层 catch，不轮换
  │           └── failedKeys.size >= keys.length → 报错：列出脱敏 key+原因；含瞬态(429/503)提示"请稍后重试"，否则提示"用管理命令检测"
  │
  ├── 10. 根据 apiMode 路由（_executeApiRequest）:
  │
  │     ├── OpenAI 模式:
  │     │   ├── OpenaiApi.convertMessages()    ← 消息格式转换
  │     │   ├── OpenaiApi.prepareRequestBody()  ← 构建请求体
  │     │   ├── POST /chat/completions          ← 发送请求
  │     │   ├── executeWithRetry()              ← 可重试
  │     │   └── OpenaiApi.processStreamingResponse()
  │     │       ├── SSE 行解析 ("data: ...")
  │     │       ├── processDelta() → 处理每个 delta
  │     │       │   ├── 推理内容 (thinking/reasoning/reasoning_content)
  │     │       │   ├── XML think 块解析 (꽁...꽁)
  │     │       │   ├── 文本内容 → LanguageModelTextPart
  │     │       │   └── 工具调用 → LanguageModelToolCallPart
  │     │       └── 用量统计 (usage chunk)
  │     │
  │     └── Anthropic 模式:
  │         ├── AnthropicApi.convertMessages()   ← 消息格式转换
  │         ├── AnthropicApi.prepareRequestBody() ← 构建请求体
  │         ├── POST /v1/messages               ← 发送请求
  │         ├── executeWithRetry()               ← 可重试
  │         └── AnthropicApi.processStreamingResponse()
  │             ├── SSE 行解析 ("data: ...")
  │             └── processAnthropicChunk()
  │                 ├── content_block_start → 块开始
  │                 ├── content_block_delta → 增量内容
  │                 │   ├── text_delta      → 文本
  │                 │   ├── thinking_delta  → 推理
  │                 │   └── input_json_delta → 工具参数
  │                 └── content_block_stop/message_stop → 结束
  │
  │     └── Responses 模式 (POST /v1/responses):
  │         ├── ResponsesApi.convertMessages()   ← 消息格式转换（input 数组，仅 input_text/output_text/input_image）
  │         ├── ResponsesApi.prepareRequestBody() ← 构建请求体（instructions/reasoning/tools，工具用扁平格式）
  │         ├── POST /v1/responses               ← 发送请求
  │         ├── executeWithRetry()               ← 可重试
  │         └── ResponsesApi.processStreamingResponse()
  │             ├── SSE 行解析 ("data: ...")
  │             └── processResponsesEvent()
  │                 ├── response.output_item.added → function_call 缓冲（按 output_index）
  │                 ├── response.reasoning_summary_text.delta / reasoning_text.delta → 推理内容（因模型而异）
  │                 ├── response.output_text.delta → 文本
  │                 ├── response.function_call_arguments.delta/done → 工具参数
  │                 └── response.completed → usage 统计
  │
  ├── 11. 图片代理拦截处理:
  │       └── _handleInterceptedToolCall()
  │           ├── 检查 interceptedToolCall（循环，最多 visionMaxRounds 次）
  │           ├── 发出同一 thinking 块: "正在根据图片提问：[问题]" + 视觉模型流式输出
  │           ├── 调用 callVisionModel() 获取描述（可选实时转发文本到 thinking 块）
  │           ├── 关闭 thinking 块
  │           ├── 用户取消则跳过本轮
  │           ├── 创建独立 AbortController 用于本轮请求
  │           │   ├── 保留 temperature/reasoning_effort 等原始参数
  │           │   ├── Anthropic 模式额外恢复 system 和 thinking 配置
  │           │   ├── Responses 模式使用文本化回填（output_text/input_text）
  │           │   └── DeepSeek 兼容注入 reasoning_content
  │           ├── 注入工具: 本轮注入 VS Code 原生工具 + ask_image（+ ask_with_multi_image 当 >=2 张图时）
  │           └── 循环: 若模型再次调用 ask_image 则继续下一轮，无限追问
  │
  ├── 12. 错误处理:
  │        ├── 用户取消（token.isCancellationRequested）→ 直接重新抛出
  │        ├── 超时（abortController.signal.aborted）→ 友好超时提示
  │        ├── 连接被终止 → 友好终止提示
  │        └── 其他错误 → 原样抛出
  │
  └── 12. finally: 清理定时器, 记录请求结束日志
```

### 2.4 Thinking/推理内容处理

```
推理内容来源 (OpenAI 模式):
  ├── choice.thinking (对象/字符串)
  ├── delta.reasoning_content (字符串)
  ├── delta.reasoning (对象)
  ├── delta.thinking (对象)
  └── reasoning_details[] (OpenRouter 格式)
      ├── reasoning.summary → summary 字段
      ├── reasoning.text    → text 字段
      └── reasoning.encrypted → "[REDACTED]"

处理机制:
  1. bufferThinkingContent(text) → 积累到 _thinkingBuffer
  2. 每 100ms 定时刷新 → LanguageModelThinkingPart
  3. XML think 块 (꽁...꽁) → processXmlThinkBlocks()
  4. 文本内容出现时 → reportEndThinking()

回传机制 (OpenAI 模式 convertMessages):
  - includeReasoningInRequest=true 时，assistant 消息**始终**设置 reasoning_content
    （有真实推理内容用内容，否则空字符串兜底）——DeepSeek thinking 模式要求每个
    assistant 消息必须携带该字段；VS Code 回传历史时不含 LanguageModelThinkingPart，
    缺失字段会 400（"The reasoning_content in the thinking mode must be passed
    back to the API"，2026-08-11 实测）
```

### 2.5 工具调用处理

```
工具调用流 (OpenAI 模式):
  delta.tool_calls[]
    ├── index: 工具调用索引
    ├── id: 调用 ID
    ├── function.name: 函数名
    └── function.arguments: JSON 参数 (可能分片)

处理机制:
  1. _toolCallBuffers Map<index, {id, name, args}>
  2. stream 分片拼接 args
  3. tryEmitBufferedToolCall() → 参数可解析 JSON 时立即发射
  4. flushToolCallBuffers() → finish_reason 时强制发射剩余
  5. adjustReadFileParameters() → 自动扩增 read_file 行数
  ask_image 拦截: 不在 tryEmit/flush 中发出，改为设置 interceptedToolCall
```

### 2.6 图片代理（ask_image Tool）流程

```
非视觉模型收到含图片的消息:
  │
  ├── 1. convertMessages()
  │      模型 vision=false，有 image → 替换为 "[The user sent an image (imageIndex=N)... I MUST call the ask_image tool...]"
  │      原图数据存入实例的 _localImages 数组
  │      同时递归扫描 tool result 内嵌的图片一并存入
  │      记录 _hasImages = true，保存 _originalApiMessages
  │
  ├── 2. prepareRequestBody()
  │      有 _localImages → 注入 ask_image 工具定义到 tools 列表
  │      设置 tool_choice = "auto"（DeepSeek 等模型拒绝强制 tool_choice）
  │
  ├── 3. 第一次 API 请求（含 ask_image + VS Code 原生工具）
  │      └── 模型自主决定是否调用 ask_image
  │
  ├── 4. processDelta() / processAnthropicChunk() / processResponsesEvent() 拦截
  │      ask_image 和 ask_with_multi_image 被缓存到 interceptedToolCall（不在 progress 中发出）
  │      tryEmitBufferedToolCall() 和 flushToolCallBuffers() 同时跳过 ask_image/ask_with_multi_image
  │
  └── 5. _handleInterceptedToolCall() 循环（多轮追问）
         for round = 1 to visionMaxRounds:
           ├── 读取 interceptedToolCall
           ├── 发出 LanguageModelThinkingPart("正在根据图片提问：[问题]\n...")
           ├── 使用模型的具体 query 调用 callVisionModel()，并将视觉模型文本流实时追加到同一 thinking 块
           │   └── 发送图片 + 查询到视觉模型，收集流式回答
           ├── 关闭 thinking
           ├── 输出跨轮历史 DataPart（createVisionToolHistoryPart）:
           │   ├── 封装 { version: 1, entry: { id, name, args, result, reasoningContent? } }
           │   ├── MIME: application/vnd.opencodego.vision-tool-history+json
           │   ├── reasoningContent 取自 OpenAI 模式的 _capturedReasoningContent（DeepSeek 兼容）
           │   └── VS Code 自动把该 DataPart 带入下一轮对话
           ├── 构建本轮消息: 追加 assistant(tool_call) + tool(result)
           ├── 注入工具: VS Code 原生工具 + ask_image（两者共存）
           ├── 发送 API 请求并流式处理
           ├── 若模型再次调用 ask_image → 继续循环
           └── 若模型未调 ask_image → 结束

跨轮恢复（下一轮请求的 convertMessages）:
  ├── OpenAI 模式: parseVisionToolHistoryPart(part) → toOpenAIVisionToolMessages(entry)
  │   └── 重建 [{role:"assistant", tool_calls:[...], reasoning_content?}, {role:"tool", tool_call_id, content}]，插到该消息正常内容之前
  └── Anthropic 模式: parseVisionToolHistoryPart(part) → toAnthropicVisionToolMessages(entry)
      └── 重建 [{role:"assistant", content:[{type:"tool_use",...}]}, {role:"user", content:[{type:"tool_result",...}]}]，在 system 处理与工具结果合并缓冲之前
```

#### 多轮请求特点

- **支持无限追问**: 模型拿到图片描述后可以继续调用 ask_image 追问细节（最多 `visionMaxRounds` 次，默认 5）
- **工具共存**: 每轮同时注入 VS Code 原生工具（read_file 等）+ ask_image，模型可混合使用
- **图片数据生命周期**: 图片存于 API 实例的 `_localImages` 数组，请求结束后随实例 GC 自动回收
- **跨轮视觉历史持久化（v1.8.0）**: 每轮视觉代理完成后输出私有 MIME `application/vnd.opencodego.vision-tool-history+json` 的 `LanguageModelDataPart`（`historyPart.ts` 的 `createVisionToolHistoryPart`），VS Code 自动带入下一轮对话；下次请求 `convertMessages` 经 `parseVisionToolHistoryPart` 识别并重建标准 tool call/tool result 消息（`historyCodec.ts` 的 `toOpenAIVisionToolMessages` / `toAnthropicVisionToolMessages`）——模型跨轮记住之前看过的图片，不会重复调用 ask_image 或忘记图片内容
- **OpenAI 模式**: 使用 `tool_calls` + `tool` role 消息格式构建每轮
- **Anthropic 模式**: 使用 `tool_use` + `tool_result` content block 格式构建每轮；**连续工具结果合并（v1.8.0）**: VS Code 可能把每个工具结果作为独立消息传入，Anthropic 协议要求同一 assistant `tool_use` 对应的全部 `tool_result` 必须在紧随的同一条 user 消息里——`convertMessages` 缓冲纯工具结果消息（`pendingToolResults`），合并为单条 user 消息输出，避免 400 "tool_use ids were found without tool_result blocks immediately after"
- **Responses 模式**: 使用文本化回填（assistant `output_text` `[tool_call] name(args) [/tool_call]` + user `input_text` `[tool_result] ... [/tool_result]`，因端点拒绝 function_call 块）。**工具定义需扁平格式**：Responses 端点要求 `{ type: "function", name, description, parameters }`（OpenAI 端点的嵌套 `function` 格式会被拒绝，报 `InvalidParameter: ...valid openai-compatible JSON schema`）——`ResponsesApi.prepareRequestBody` 已按扁平格式注入，且工具定义来自 VS Code 转换后的扁平结构
- **参数保留**: 每轮保留 temperature、top_p、thinking 模式等原始参数
- **DeepSeek 兼容**: 对 DeepSeek 模型的 assistant tool_call 消息注入 reasoning_content 字段

### 2.6 Git 提交消息生成流程

```
generateCommitMsg(secrets, scm?)
  ├── 检测 Git 扩展和仓库
  ├── 获取 Git Diff (gitUtils.getGitDiff)
  │   ├── 优先 staged diff (git diff --cached)
  │   └── 回退 unstaged diff (git diff)
  ├── 多仓库处理:
  │   ├── 0 个有变化的仓库 → 提示用户
  │   ├── 1 个 → 直接生成
  │   └── 多个 → QuickPick 选择
  ├── 构建 Prompt:
  │   ├── 系统提示词 (可自定义，强调直接输出不包含解释)
  │   ├── 最近提交风格参考
  │   │   ├── 默认: 仅提交标题 (git log --format=%s)
  │   │   └── 可选: 同时包含每次提交的 diff (tokenrhythm.commitIncludeCommitDiff)
  │   ├── 语言检测: auto 模式时告知模型匹配历史 commit 语言风格
  │   ├── 用户当前输入 (SCM InputBox)
  │   └── Git Diff 内容
  ├── 调用 API（多 key 轮换循环）:
  │   ├── ensureApiKeyEntry → pickNextApiKey (rotation/single + fallback)
  │   ├── 余额预检（cookie）
  │   ├── OpenaiApi.createMessage() / AnthropicApi.createMessage() / ResponsesApi.createMessage()
  │   ├── 流式输出到 SCM InputBox
  │   └── 轮换错误 → 换 key 重试（已有部分输出则不换）；用户取消 → 中止
  └── 清理: 移除 ``` 标记和 <think> 标签
```

---

## 3. 程序文件索引

### 3.1 目录结构

```
src/
├── apiModelList.ts                       # API 模型列表获取
├── balanceCheck.ts                       # 余额查询（cookie /api/usage-summary，TTL 缓存，手动检测）
├── commonApi.ts                          # API 抽象基类
├── extension.ts                          # 扩展入口 (activate/deactivate)，含 manageApiKeys QuickPick 管理
├── keyManager.ts                         # 多 API Key 管理（存储/迁移/轮询选择/失效状态/轮换判定/脱敏）
├── localize.ts                           # 国际化/本地化
├── logger.ts                             # 日志系统
├── models.ts                             # 内置模型定义清单
├── modelsDev.ts                          # models.dev 元数据拉取与查询
├── modelSync.ts                          # 启动模型同步（每日一次，结果以一行日志输出到 Output 通道）
├── provideModel.ts                       # 模型信息提供函数（含自动发现）
├── provider.ts                           # Chat 模型提供商 (核心主文件，含多 key 轮换循环)
├── provideToken.ts                       # Token 计数函数
├── statusBar.ts                          # 状态栏管理
├── types.ts                              # TypeScript 类型定义
├── utils.ts                              # 通用工具函数
├── versionManager.ts                     # 版本信息管理
├── openai/
│   ├── openaiApi.ts                      # OpenAI 兼容 API 实现
│   └── openaiTypes.ts                    # OpenAI 类型定义
├── anthropic/
│   ├── anthropicApi.ts                   # Anthropic API 实现
│   └── anthropicTypes.ts                 # Anthropic 类型定义
├── responses/
│   ├── responsesApi.ts                   # Responses API 实现 (POST /v1/responses)
│   └── responsesTypes.ts                 # Responses 类型定义
├── gitCommit/
│   ├── commitMessageGenerator.ts         # Git 提交消息生成
│   └── gitUtils.ts                       # Git 工具函数
├── tokenizer/
│   ├── tokenizerManager.ts               # Tokenizer 管理 (o200k_base)
│   └── imageUtils.ts                     # 图片尺寸解析
├── vision/
│   ├── types.ts                          # Vision proxy 类型定义
│   ├── historyCodec.ts                   # 跨轮视觉历史编解码（serialize/deserialize/toOpenAI/toAnthropic）
│   ├── historyPart.ts                    # 跨轮视觉历史 DataPart 创建/解析（私有 MIME）
│   └── imageProxy.ts                     # 图片代理核心 (ask_image)
└── resources/
    └── walkthrough/                      # 安装欢迎页 (Walkthrough) 文档
        ├── set-api-key.md                # 步骤 1：设置 API Key
        ├── set-api-key.nls.zh-cn.md      # 步骤 1 中文版
        ├── show-models.md                # 步骤 2：显示模型
        ├── show-models.nls.zh-cn.md      # 步骤 2 中文版
        ├── advanced-settings.md          # 步骤 3：高级设置
        └── advanced-settings.nls.zh-cn.md# 步骤 3 中文版

scripts/
├── tsconfig.json                        # scripts 独立编译配置（输出到 scripts/out）
├── build-info.mjs                       # 编译元信息生成（out/build-info.json + .copilot/build-log.md，compile 后自动运行）
├── check-new-models.mjs                 # 检查 API 新模型
├── copy-tokenizer.js                    # 拷贝 tokenizer 资源
├── export-call-logs.mjs                 # 导出全部调用日志为 CSV（cookie 认证）
├── analyze-call-logs.mjs                # 分析调用日志 CSV（按模型/Key/状态/协议/小时统计）
├── test-vision-history.mjs              # 跨轮视觉历史编解码 + 双 API 转换器闭环测试（源自上游 opencode-go-copilot v1.9.2）
├── test-anthropic-tool-result-merge.mjs # Anthropic 连续工具结果合并测试（源自上游 opencode-go-copilot v1.9.2）
└── cookieApi/
    ├── types.ts                         # 用户中心 API 类型定义（UsageSummary/CallLog 等）
    ├── cookieApi.ts                     # 用户中心 API 客户端（cookie 认证：余额/调用日志）
    └── cli.ts                           # 用户中心查询 CLI（临时调试用）

test/
├── api-tests.mjs                        # 三协议 API 完整测试脚本（OpenAI/Anthropic/Responses，第 9b 项含生产 400 回归用例）
└── README.md                            # 测试说明与平台差异记录（含 Responses 扁平化问题）

.copilot/
└── build-log.md                        # 编译日志（每次 npm run compile 由 build-info.mjs 追加，含版本号+时区）
```

### 3.2 文件详细说明

| 文件 | 行数 | 职责 |
|------|------|------|
| `extension.ts` | ~870 | 扩展激活/停用，注册 Provider 和 7 条命令，`manageApiKeys` QuickPick 管理（增删/批量导入/设为当前（仅 single 模式）/绑定 cookie/重置失效/检测可用性/编辑 key/**余额显示**），首次安装欢迎页引导 |
| `provider.ts` | ~1290 | 实现 `LanguageModelChatProvider`，处理聊天请求全流程（三协议路由、多 key 轮换循环、余额预检、被动切换）及图片代理多轮循环处理 |
| `keyManager.ts` | ~500 | 多 API Key 管理：SecretStorage 存取与旧 key 迁移、rotation/single 选择逻辑、可用性状态（持久化 available + 瞬态冷却）、轮换错误判定、脱敏、批量添加（addApiKeys）、三字段编辑（updateApiKey） |
| `balanceCheck.ts` | ~195 | 余额查询：cookie 认证 `GET /api/usage-summary`、TTL 缓存、`checkKeyBalance` 预检（返回余额值供日志/UI 展示）、`isKeyBalanceSufficient` 快捷判断、`testKeyAvailability` 手动检测（查余额 + 最小聊天请求） |
| `models.ts` | ~230 | 14 个内置模型定义，模型配置查询（所有模型声明 `imageInput: true`） |
| `types.ts` | ~95 | `TokenRhythmModelItem`, `ModelPreset`, `ModelsResponse`, `RetryConfig` 等类型 |
| `apiModelList.ts` | ~120 | API 模型列表获取：从 `/v1/models` 拉取可用模型 ID 及能力标记（含 `supports_responses`），5 分钟缓存，静默降级 |
| `modelsDev.ts` | ~130 | models.dev 元数据拉取与查询：从 `models.dev/models.json` 下载并索引模型规格，支持短 ID 匹配，1 小时缓存 |
| `modelSync.ts` | ~90 | 启动模型同步：每日最多一次检查 API 新模型（`globalState` 记录日期），同步结果以一行日志输出到「TokenRhythm」Output 通道（`models.sync` 标签），**不写文件**（v1.7.0 移除工作区 `.copilot/model-sync-log.md`，见 issue #1），无 Key/API 不可用记录失败且不标记已同步 |
| `commonApi.ts` | ~462 | `CommonApi<TMessage,TRequestBody>` 抽象基类（图片存储、工具调用拦截） |
| `provideModel.ts` | ~130 | 模型信息提供函数（含自动发现）：过滤内置模型、从 API 和 models.dev 自动发现新增模型 |
| `provideToken.ts` | ~100 | Token 用量计算 |
| `utils.ts` | ~285 | 工具函数 (重试、角色映射、工具转换等) |
| `statusBar.ts` | ~140 | 状态栏创建、更新、累计计数器 |
| `logger.ts` | ~55 | 日志输出 (LogOutputChannel) |
| `localize.ts` | ~109 | 中英文国际化 |
| `versionManager.ts` | ~35 | 扩展版本信息 |
| `openai/openaiApi.ts` | ~613 | OpenAI 格式 API 实现 (消息转换/请求构建/流式处理/图片代理/跨轮视觉历史重建) |
| `openai/openaiTypes.ts` | ~75 | OpenAI 类型定义 |
| `anthropic/anthropicApi.ts` | ~535 | Anthropic 格式 API 实现 (消息转换/请求构建/流式处理/图片代理/跨轮视觉历史重建/**连续工具结果合并**) |
| `anthropic/anthropicTypes.ts` | ~130 | Anthropic 类型定义 |
| `responses/responsesApi.ts` | ~600 | Responses API 格式实现 (消息转换/请求构建/流式处理/图片代理/文本化工具回填) |
| `responses/responsesTypes.ts` | ~130 | Responses 类型定义 |
| `gitCommit/commitMessageGenerator.ts` | ~295 | Git 提交消息生成逻辑 |
| `gitCommit/gitUtils.ts` | ~260 | Git 命令封装 |
| `cookieApi/types.ts` | ~150 | 用户中心 API 类型定义（`UsageSummary`, `CallLog`, `CallLogPage`, `CallLogQueryParams`, `CallLogStats`, `ApiResponse`） |
| `cookieApi/cookieApi.ts` | ~190 | 用户中心 API 客户端：基于 session cookie（`tr_session`）查询余额（`/api/usage-summary`）与调用日志（`/api/call-logs/page`），含自动翻页与统计汇总 |
| `cookieApi/cli.ts` | ~140 | 用户中心查询 CLI（临时调试用）：`node scripts/out/cookieApi/cli.js <tr_session值> [startAt] [endAt]`（编译：`npx tsc -p scripts/tsconfig.json`） |
| `export-call-logs.mjs` | ~80 | 导出全部调用日志为 CSV（`$env:TR_SESSION="<cookie>"; node scripts/export-call-logs.mjs [startAt] [endAt] [outFile]`） |
| `analyze-call-logs.mjs` | ~110 | 分析调用日志 CSV 并输出统计（按模型/Key/状态/协议/小时/单次成本 TOP5）：`node scripts/analyze-call-logs.mjs [csv路径]` |
| `test-vision-history.mjs` | ~150 | 跨轮视觉历史编解码 + 双 API 转换器闭环测试（源自上游 opencode-go-copilot v1.9.2，含 DeepSeek 空 reasoning_content 回归用例；运行前需 `npm run compile`） |
| `test-anthropic-tool-result-merge.mjs` | ~170 | Anthropic 连续工具结果合并测试（源自上游，issue #87 场景：3 个并行 tool_use 结果合并为单条 user 消息；运行前需 `npm run compile`） |
| `build-info.mjs` | ~90 | 编译元信息生成：`npm run compile` 后自动运行，写入 `out/build-info.json`（版本号 + 编译时间，标注 IANA 时区与 UTC 偏移）并追加 `.copilot/build-log.md`（编译日志） |
| `tokenizer/tokenizerManager.ts` | ~115 | o200k_base 分词器管理 (含 LRU 缓存) |
| `tokenizer/imageUtils.ts` | ~130 | 图片尺寸解析 (PNG/GIF/JPEG/WebP) |
| `vision/types.ts` | ~53 | Vision proxy 类型定义（`StoredImage`, `InterceptedToolCall`, `ASK_IMAGE_TOOL_DEF`, `ASK_IMAGE_TOOL_NAME`, `ASK_WITH_MULTI_IMAGE_TOOL_DEF`, `ASK_WITH_MULTI_IMAGE_TOOL_NAME`, `DEFAULT_VISION_PROMPT`） |
| `vision/historyCodec.ts` | ~150 | 跨轮视觉历史编解码（源自上游 opencode-go-copilot v1.9.2）：`VISION_TOOL_HISTORY_MIME`、`VisionToolHistoryEntry`、`serializeVisionToolHistory`、`deserializeVisionToolHistory`、`toOpenAIVisionToolMessages`、`toAnthropicVisionToolMessages` |
| `vision/historyPart.ts` | ~28 | 跨轮视觉历史 DataPart 创建/解析（源自上游）：`createVisionToolHistoryPart`、`parseVisionToolHistoryPart` |
| `vision/imageProxy.ts` | ~95 | 图片代理核心：调用视觉模型描述图片（`callVisionModel`/`callVisionModelMulti`），支持 thinking 模式配置和文本流式转发 |

---

## 4. 函数定义大全

### 4.1 `src/extension.ts`

#### `activate(context: vscode.ExtensionContext): void`
扩展激活入口。初始化日志、分词器、状态栏；注册 `LanguageModelChatProvider`；注册七条命令（设置 API Key、获取 API Key 网址、打开扩展设置、生成 Git 提交消息、中止生成、设置模型预设、管理 API Keys）；首次安装时调用 `showWelcomeIfNeeded()` 显示欢迎页引导。

#### `showApiKeyManager(context: vscode.ExtensionContext): Promise<void>`
多 Key 管理 QuickPick 主流程（`tokenrhythm.manageApiKeys` 命令）。循环渲染 key 列表（脱敏显示 + 可用性/当前使用/cookie 状态/**余额显示**标记），支持动作：添加 Key（可附 label/cookie）、**批量导入**（`batchImportFlow` 表单式三元组）、删除 Key（二次确认）、**设为当前使用（仅 single 模式渲染，轮询模式隐藏；★ Current 标记同理）**、重置失效状态（清冷却 + available=false → null）、**检测可用性（`showCheckMenu` 二级界面：列出全部 key 状态 + "检测所有"选项）**、绑定或更新 Cookie、清除 Cookie、**编辑 Key（`editKeyFlow` 三字段 value/cookie/label）**。内部局部函数：`batchImportFlow`（逐条输入 cookie/key/备注三元组，Finish 时调用 `addApiKeys`，已存在 key 更新 cookie）、`showCheckMenu`（检测二级界面，单测/全测）、`checkAllAvailabilityFlow`（withProgress 遍历 `testKeyAvailability` 并更新状态）、`bindCookieFlow`、`editKeyFlow`、`checkAvailabilityFlow`、`addKeyFlow`、`pickKey`。

**余额显示（2026-08-11）**：主界面 `render()` 与检测二级界面 `showCheckMenu()` 均通过 `getBalanceCached(cookie, ttl)`（TTL 缓存）为绑定 cookie 的 key 查询余额并展示——`$(coin) ¥X.XX`（余额 > minBalanceCny）或 `$(error) ¥X.XX`（余额 ≤ minBalanceCny，即轮询会被跳过的 key）；查询失败显示 `$(warning) 余额未知`；未绑定 cookie 不显示余额（无法预检）。`checkAvailabilityFlow` 的余额不足提示改用 `getMinBalanceCny()` 显示实际阈值（原硬编码 0）。

#### `showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void>`
检查是否已显示过欢迎页（通过 `globalState` 的 `WELCOME_SHOWN_KEY` 标记）。如果已标记或已有 API Key，直接返回；否则通过 `workbench.action.openWalkthrough` 命令打开 Walkthrough 页面并标记为已显示。静默处理异常，不阻塞扩展激活。

#### `deactivate(): void`
扩展停用。清理资源（日志 dispose）。

---

### 4.2 `src/provider.ts`

#### `class TokenRhythmChatModelProvider implements LanguageModelChatProvider`
核心 Provider 类。

| 属性 | 类型 | 说明 |
|------|------|------|
| `_lastRequestTime` | `number \| null` | 上次请求完成时间，用于延迟计算 |

#### `constructor(secrets: vscode.SecretStorage, statusBarItem: vscode.StatusBarItem)`
构造函数，接收密钥存储和状态栏条目。

#### `notifyModelListChanged(): void`
触发 `onDidChangeLanguageModelChatInformation` 事件，通知 VS Code 模型列表可能已变化（如 `tokenrhythm.apiMode` 切换），VS Code 会重新调用 `provideLanguageModelChatInformation` 刷新选择器。由 `extension.ts` 在 `onDidChangeConfiguration` 中调用。

#### `private _createFetchWithTimeout(requestTimeoutMs: number): typeof fetch`
创建 undici fetch 实例，设置自定义 `bodyTimeout` 防止流式响应中 TCP 空闲连接被提前关闭。回退到全局 `fetch`。

#### `provideLanguageModelChatInformation(options, _token): Promise<LanguageModelChatInformation[]>`
获取可用的语言模型列表。参数类型为 `PrepareLanguageModelChatModelOptions`，委托给 `prepareLanguageModelChatInformation()`。

#### `provideTokenCount(_model, text, _token): Promise<number>`
计算文本或消息的 Token 数量。委托给 `countMessageTokens()`。

#### `provideLanguageModelChatResponse(model, messages, options, progress, token): Promise<void>`
核心方法：处理聊天请求，流式返回响应。包括模型配置获取（内置模型 → 自动发现回退）、API Key 验证（多 key 轮换循环）、推理力度应用、temperature/top_p 注入（模型预设或自定义设置）、API 模式确定（`tokenrhythm.apiMode` 设置：`auto` 跟随模型默认或强制 `openai`/`anthropic`/`responses`；`tokenrhythm.enableResponsesApi` 关闭时 auto 模式下的 responses 模型回退 openai）、延迟控制、超时管理、**多 key 轮换循环**（`pickNextApiKey` → 余额预检 → `_executeApiRequest` → 成功 break / 轮换错误换 key / 其他错误抛出）、流式解析、图片代理拦截处理和错误处理。错误处理区分三种情况：用户取消（直接重新抛出原始错误）、超时（友好超时提示）、连接被终止（友好终止提示）。

#### `private async _executeApiRequest(params): Promise<void>`
执行单个 key 的完整 API 请求：三协议分发（openai/anthropic/responses，原 provideLanguageModelChatResponse 内的协议分支）、流式处理、`_handleInterceptedToolCall` 图片代理第二轮。在轮换循环内每轮调用一次。参数含 `apiKey`（当前选中的 key 值）、`requestHeaders`、`trackingProgress`、`onUsage`（用量回调）等。错误抛出给轮换循环调用方决定是否换 key。

#### `private async _handleInterceptedToolCall(params): Promise<void>`
处理图片代理拦截。循环处理最多 `tokenrhythm.visionMaxRounds` 轮（默认 5）。每轮检测 API 实例的 `interceptedToolCall`，发出 thinking 块显示“正在根据图片提问：[问题]”，关闭 thinking 块后视觉模型输出以普通文本流式显示。单图调用 `callVisionModel()`，多图调用 `callVisionModelMulti()`，**每轮在关闭 thinking 块后输出跨轮视觉历史 DataPart（`createVisionToolHistoryPart`，封装 id/name/args/result/reasoningContent）供 VS Code 带入下一轮对话**，构建本轮 API 请求（追加 assistant tool_call + tool result），注入 VS Code 原生工具 + ask_image（+ ask_with_multi_image 当 >=2 图时）供模型继续使用，保留 temperature/reasoning_effort 等原始参数，DeepSeek 兼容注入 `reasoning_content`。模型不再调用 ask_image/ask_with_multi_image 时退出循环。**视觉代理轮内失败不触发 key 轮换**（主请求已成功、tool 上下文已建立，换 key 会不一致），直接报错由用户重试整个请求。

- 视觉模型调用期间用户取消则跳过本轮。
- 每轮创建独立 AbortController，带独立超时。
- 每轮注入 VS Code 原生工具 + ask_image + ask_with_multi_image，确保模型可以混合使用。
- Anthropic 模式额外恢复 `system` 内容（`_systemContent`）和 `thinking` 参数（启用→`{ type: "enabled", budget_tokens: 8192 }` / adaptive→`{ type: "adaptive" }` / 禁用→`{ type: "disabled" }`，与主请求 `prepareRequestBody` 保持一致）。
- Responses 模式使用文本化回填（assistant `output_text` + user `input_text`，因端点拒绝 function_call 块）。
- 第二轮及后续轮次请求体中显式设置 `tool_choice` 为 `"auto"`（OpenAI）或 `{ type: "auto" }`（Anthropic），确保模型可继续调用工具。
- 使用 `_resetStreamState()` 重置流状态，避免 `_completedToolCallIndices` 等状态在轮次间残留导致工具调用被跳过。
- `thinking` 字段值统一使用字符串（`"enabled"` / `"disabled"`），与 `prepareRequestBody` 保持一致。

#### `private async ensureApiKey(): Promise<ApiKeyEntry | undefined>`
确保至少一个 API Key 存在（经 keyManager.getApiKeyStore）。无任何 key 时弹出输入框引导添加第一个（写入多 key 存储）。轮换循环在请求前调用，为空时抛出"TokenRhythm API key not found"。

---

### 4.3 `src/models.ts`

#### `interface BuiltInModelDef`
内置模型定义接口。

| 属性 | 类型 | 说明 |
|------|------|------|
| `baseId` | `string` | API 请求中使用的模型 ID |
| `displayName` | `string` | 用户友好的显示名称 |
| `vision` | `boolean` | 是否支持图片输入（所有模型 `imageInput` 能力声明为 `true`，非视觉模型通过代理处理） |
| `thinkingMode` | `"switchable" \| "always" \| "adaptive"` | switchable=可选择思考开关, always=思考始终启用, adaptive=仅禁用/自动 |
| `defaultReasoningEffort` | `string` (可选) | 默认推理力度 |
| `supportedReasoningEfforts` | `string[]` (可选) | 支持的推理力度选项 |
| `includeReasoningInRequest` | `boolean` (可选) | 是否在 assistant 消息中包含 reasoning_content |
| `supportsTemperature` | `boolean` (可选) | 是否支持设置 temperature/top_p，默认 true |
| `contextLength` | `number` (可选) | 默认上下文长度 |
| `maxTokens` | `number` (可选) | 默认最大输出 Token |
| `extra` | `Record<string, unknown>` (可选) | 额外的请求体参数 |
| `apiMode` | `"openai" \| "anthropic" \| "responses"` (可选) | API 格式模式 |

#### `const BUILT_IN_MODELS: BuiltInModelDef[]`
14 个内置模型定义常量数组（来源：[TokenRhythm 模型页](https://tokenrhythm.studio/models)）。

#### `getBuiltInModelInfos(): LanguageModelChatInformation[]`
将内置模型定义转换为 VS Code 的模型信息列表。每个模型注册**一个条目**，带 `isUserSelectable: true` 确保在模型选择器中可见（VS Code 1.120+ 要求），并通过 `configurationSchema` 附加推理强度选择器（中文标签）。switchable 模型显示 `禁用思考/思考` 或 `禁用思考/高/最大`（可关闭推理）；adaptive 模型仅显示 `禁用思考/自动`；always 模型不显示 `禁用思考` 选项，仅在支持推理强度时显示强度选项。`maxInputTokens` 按真实上下文窗口的**可配置比例**声明（`getMaxInputTokensRatio()` 读取 `tokenrhythm.maxInputTokensRatio` 设置，默认 `1.0`，建议 `0.8`，`Math.floor` 取整，范围 0.1–1.0），使 VS Code 的 agent 自动压缩（约 90% 阈值）能在真实上下文的约 72%（比例 0.8 时）处触发；`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getBuiltInModelCount(): number`
返回内置模型定义总数（BUILT_IN_MODELS.length）。

#### `getBuiltInModelIds(): Set<string>`
返回所有内置模型的 baseId 集合。供 `src/modelSync.ts` 在启动同步时对比 API 模型列表，检测不在内置列表中的新模型。

#### `getMaxInputTokensRatio(): number`
读取可配置的 `maxInputTokens` 声明比例（设置 `tokenrhythm.maxInputTokensRatio`，默认 `1.0`，建议 `0.8`），并夹取到合法范围 [0.1, 1.0]。设置缺失或非法时回退到默认值。`maxInputTokens` 按真实上下文窗口 × 该比例声明（`Math.floor` 取整），使 VS Code 的 agent 自动压缩（约 90% 阈值）能在真实上下文的约 72%（比例 0.8 时）处触发；`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getBuiltInModelConfig(modelId: string): TokenRhythmModelItem | undefined`
按模型 ID 查找内置模型定义，返回对应的模型配置对象（含 thinkingMode、默认推理力度、API 模式、extra 参数等）。思考模式的具体启用状态由 provider.ts 根据 reasoningEffort 配置动态决定。

---

### 4.4 `src/types.ts`

#### `interface TokenRhythmModelItem`
完整模型配置接口。

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 模型 ID |
| `owned_by` | `string` | 提供商 |
| `configId` | `string` (可选) | 配置 ID（保留兼容） |
| `displayName` | `string` (可选) | 显示名称 |
| `baseUrl` | `string` (可选) | 自定义 Base URL |
| `context_length` | `number` (可选) | 上下文长度 |
| `vision` | `boolean` (可选) | 是否支持视觉 |
| `max_completion_tokens` | `number` (可选) | 最大输出 Token (新标准) |
| `reasoning_effort` | `string` (可选) | 推理力度 |
| `enable_thinking` | `boolean` (可选) | 是否启用 thinking |
| `thinking_budget` | `number` (可选) | Thinking 预算 Token |
| `temperature` | `number \| null` (可选) | 温度参数 |
| `top_p` | `number \| null` (可选) | Top-p 采样 |
| `top_k` | `number` (可选) | Top-k 采样 |
| `min_p` | `number` (可选) | Min-p 采样 |
| `frequency_penalty` | `number` (可选) | 频率惩罚 |
| `presence_penalty` | `number` (可选) | 存在惩罚 |
| `repetition_penalty` | `number` (可选) | 重复惩罚 |
| `reasoning` | `object` (可选) | OpenRouter 推理配置 |
| `extra` | `Record<string, unknown>` (可选) | 额外请求体参数 |
| `family` | `string` (可选) | 模型系列 |
| `include_reasoning_in_request` | `boolean` (可选) | 是否在请求中包含推理内容 |
| `thinkingMode` | `"switchable" \| "always"` (可选) | 思考模式类型 |
| `supportsTemperature` | `boolean` (可选) | 是否支持设置 temperature/top_p，默认 true |
| `useForCommitGeneration` | `boolean` (可选) | 是否用于提交消息生成 |
| `delay` | `number` (可选) | 模型专属请求延迟 |
| `apiMode` | `string` (可选) | API 模式 |
| `headers` | `Record<string, string>` (可选) | 自定义 HTTP 头 |

#### `interface ModelsResponse`
`{ object: string; data: ModelItem[] }` — 模型列表 API 响应。

#### `interface ModelItem`
`{ id, object?, created?, owned_by? }` — 单个模型条目。

#### `interface ModelPreset`
`{ id, label, temperature, top_p }` — 模型预设配置，用于快速切换温度和 top_p。

#### `interface RetryConfig`
`{ enabled, maxAttempts, intervalMs, backoffFactor, maxIntervalMs, statusCodes }` — 重试配置。

---

### 4.5 `src/commonApi.ts`

#### `interface StreamUsage`
`{ promptTokens, completionTokens, cacheHitTokens?, cacheMissTokens? }` — 流式用量信息。

#### `abstract class CommonApi<TMessage, TRequestBody>`
API 实现的抽象基类。

| 属性 | 类型 | 说明 |
|------|------|------|
| `_toolCallBuffers` | `Map<number, {id?, name?, args}>` | 工具调用参数缓冲区 |
| `_completedToolCallIndices` | `Set<number>` | 已完成发射的工具调用索引 |
| `_hasEmittedAssistantText` | `boolean` | 是否已发射过助手文本 |
| `_hasEmittedText` | `boolean` | 是否已发射过文本 |
| `_hasEmittedThinking` | `boolean` | 是否已发射过推理内容 |
| `_emittedBeginToolCallsHint` | `boolean` | 是否已发射工具调用前导空格 |
| `_xmlThinkActive` | `boolean` | XML think 块解析中 |
| `_xmlThinkDetectionAttempted` | `boolean` | 是否尝试过 XML think 检测 |
| `_currentThinkingId` | `string \| null` | 当前推理内容 ID |
| `_thinkingBuffer` | `string` | 推理内容缓冲区 |
| `_thinkingFlushTimer` | `NodeJS.Timeout \| null` | 推理刷新定时器 |
| `_systemContent` | `string \| undefined` | 系统提示内容 |
| `_modelId` | `string` | 模型 ID |
| `_onUsage` | `((usage: StreamUsage) => void) \| undefined` | 用量回调 |
| `interceptedToolCall` | `InterceptedToolCall \| null` | 被拦截的 ask_image 工具调用 |
| `_localImages` | `StoredImage[]` | 实例局部图片数据，请求结束随 GC 回收 |
| `_originalApiMessages` | `any[] \| null` | 转换后的原始 API 消息，用于构建多轮请求 |

#### `abstract convertMessages(messages, modelConfig): TMessage[]`
将 VS Code 聊天消息转换为特定 API 格式的消息数组。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。

#### `abstract prepareRequestBody(rb, um, options?): TRequestBody`
构建特定 API 的请求体。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `abstract processStreamingResponse(responseBody, progress, token): Promise<void>`
处理特定 API 的流式响应。

#### `protected tryEmitBufferedToolCall(index, progress): Promise<void>`
当工具调用的名称和 JSON 参数都可用时，尝试发射缓冲的工具调用。跳过 `ask_image` 和 `ask_with_multi_image` 工具（由 provider 处理）。

#### `protected flushToolCallBuffers(progress, throwOnInvalid): Promise<void>`
清空所有工具调用缓冲区，发射剩余的工具调用。拦截 `ask_image` 和 `ask_with_multi_image` 存入 `interceptedToolCall`。

#### `public getStoredImage(imageIndex): StoredImage | undefined`
从实例的 `_localImages` 数组中按索引获取存储的图片数据。

#### `protected adjustReadFileParameters(toolName, parameters): Record<string, unknown>`
调整 `read_file` 工具的参数，根据配置自动扩增读取行数。

#### `protected _resetStreamState(): void`
重置可变流状态。必须在每次 `processStreamingResponse` 调用开始时调用，防止状态在轮次间残留（例如第一轮 → 视觉代理 → 第二轮）。清理内容包括：工具调用缓冲区、已发射索引、文本/推理发射标记、XML think 解析状态、thinking 缓冲区与定时器、被拦截工具调用。

#### `protected reportEndThinking(progress): void`
结束当前推理序列，向 VS Code 报告推理结束。

#### `protected generateThinkingId(): string`
生成唯一的推理内容 ID。

#### `protected bufferThinkingContent(text, progress): void`
缓冲推理内容，设置定时器每 100ms 刷新。

#### `protected flushThinkingBuffer(progress): void`
立即将缓冲的推理内容刷新到进度报告器。

#### `protected processXmlThinkBlocks(content, progress): { emittedAny: boolean }`
解析 XML think 块 (`꽁...꽁`)，将推理内容与文本内容分离。

#### `protected processTextContent(content, progress): { emittedAny: boolean }`
处理普通文本内容，发射到进度报告器。

#### `static prepareHeaders(apiKey, apiMode, customHeaders?): Record<string, string>`
准备 HTTP 请求头。Anthropic 模式使用 `x-api-key`，OpenAI 模式使用 `Bearer` 令牌。

---

### 4.6 `src/keyManager.ts`

#### `interface ApiKeyEntry`
`{ value: string; label?: string; cookie?: string; available?: boolean | null; lastCheckedAt?: number }` — 单个 API Key 条目。`cookie` 为可选的 `tr_session` cookie（一个 cookie 可绑定多个 key，余额按 cookie 粒度查询）；`available` 为可用性状态（true=可用 / false=不可用 / null=未检测，持久化于 SecretStorage）。

#### `interface ApiKeyStore`
`{ keys: ApiKeyEntry[]; activeIndex: number }` — 完整 store（`tokenrhythm.apiKeys` 的 JSON 结构）。

#### `type ApiKeyMode = "rotation" | "single"`
key 使用模式：轮询 / 单 key。

#### `type SingleKeyFallback = "error" | "switch"`
single 模式当前 key 不可用时的行为：报错 / 自动切换并弹窗提示。

#### `getApiKeyMode(): ApiKeyMode`
读取 `tokenrhythm.apiKeyMode`（默认 `rotation`；非法值回退）。

#### `getSingleKeyFallback(): SingleKeyFallback`
读取 `tokenrhythm.singleKeyFallback`（默认 `error`）。

#### `getRotationStatusCodes(): number[]`
读取触发轮换的状态码列表（默认 `[401, 402, 429, 503]`）。

#### `getRotationErrorPatterns(): string[]`
读取触发轮换的错误文本 patterns（默认含"余额不足"/`INSUFFICIENT_BALANCE`/`RATE_LIMITED` 等）。

#### `getExhaustedCooldownMin(): number`
读取 429 瞬态冷却时长（分钟，默认 10）。

#### `getApiKeyStore(secrets): Promise<ApiKeyStore>`
读取并缓存 store；自动迁移旧版单 key（`tokenrhythm.apiKey`）为单元素列表；JSON 损坏时回退修复。

#### `saveApiKeyStore(secrets, store): Promise<void>`
写新格式到 SecretStorage；成功后删除旧版单 key（幂等）。

#### `invalidateApiKeyStoreCache(): void`
使内存缓存失效。

#### `maskApiKey(key): string`
脱敏 API Key：`sk_****abcd`。

#### `maskCookie(cookie): string`
脱敏 cookie：`sess_****abcd`。

#### `getTransientExhaustedInfo(keyValue): { reason; remainingSec } | undefined`
查询是否处于 429 瞬态冷却中；冷却到期自动清除。

#### `isApiKeyEligible(entry): boolean`
判断 entry 是否可被选中（非持久化不可用、非冷却中）。

#### `isKeyRotationError(err): boolean`
判定错误是否应触发 key 轮换：状态码 `[code]`/`status code` 匹配配置列表，或错误文本包含任一 patterns（不区分大小写）。

#### `isTransientExhaustedReason(reason): boolean`
判断失效原因是否为瞬态类（`rate_limited`/`server_error`）。

#### `getKeyRotationReason(err): string`
从轮换错误中提取失效原因（基于状态码+文本，比 patterns 精确）：402/`INSUFFICIENT_BALANCE`/"余额不足" → `balance`；401 → `invalid`；429/`RATE_LIMITED` → `rate_limited`；503 → `server_error`；其他 → `api_error`。

#### `getPrimaryApiKey(secrets): Promise<ApiKeyEntry | undefined>`
获取主 key（模型列表/启动同步等"任意有效 key 即可"场景）：single→active；rotation→第一个可用。

#### `pickNextApiKey(secrets, mode): Promise<ApiKeyEntry | undefined>`
选择下一个要使用的 key：rotation 从游标环形扫描第一个可用 key 并前移游标；single 返回 active key（不可用返回 undefined，由调用方按 fallback 处理）。

#### `markApiKeyExhausted(secrets, keyValue, reason): Promise<void>`
标记 key 不可用。**瞬态原因**（`rate_limited`/`server_error`）→ 仅记录内存冷却（不持久化，冷却到期自动恢复）；**确定性原因**（`balance`/`invalid`/`api_error`）→ 持久化 `available=false`。

#### `markApiKeyAvailable(secrets, keyValue): Promise<void>`
标记 key 可用（自愈/手动检测通过），清瞬态冷却。

#### `updateKeyAvailability(secrets, keyValue, available): Promise<void>`
通用可用性更新。

#### `resetExhaustedKeys(secrets, resetPersisted): Promise<void>`
清空瞬态冷却；可选将所有持久化不可用标记重置为 null。

#### `addApiKey(secrets, entry): Promise<boolean>`
添加 key（校验重复值）；返回是否添加成功。

#### `addApiKeys(secrets, entries): Promise<{ added: number; updated: number }>`
批量添加多个 API Key（三元组 `{ value, label?, cookie? }`）。**已有重复 key 不跳过**，转为更新其 cookie（补全缺失的 cookie，且新 cookie 覆盖旧的）；返回新增数量与更新数量。供 `showApiKeyManager` 的批量导入流程使用。

#### `updateApiKey(secrets, index, fields): Promise<{ ok: boolean; conflict?: boolean }>`
编辑指定 key 的三个字段（key 值 / cookie / 备注）。修改 key 值时校验不与其它已存在 key 冲突（`conflict: true`）；仅更新调用方提供的字段（undefined 表示不修改）。

#### `removeApiKey(secrets, index): Promise<void>`
删除 key；自动修正 activeIndex 与轮询游标。

#### `setActiveKey(secrets, index): Promise<void>`
设置 single 模式的当前 key。

#### `setKeyCookie(secrets, index, cookie?): Promise<void>`
绑定/更新/清除指定 key 的 cookie。

#### `getKeyDisplayStatus(entry): "available" | "unavailable" | "unknown" | "cooldown"`
获取 key 的展示状态（供 QuickPick UI）。

---

### 4.7 `src/balanceCheck.ts`

#### `getBalanceCheckEnabled(): boolean`
读取 `tokenrhythm.balanceCheckEnabled`（默认 true）。

#### `getMinBalanceCny(): number`
读取 `tokenrhythm.minBalanceCny`（默认 0，夹取 ≥ 0）。

#### `getBalanceCheckIntervalSec(): number`
读取余额查询缓存 TTL（秒，默认 60）。

#### `queryAccountBalance(cookie): Promise<number>`
`GET https://tokenrhythm.studio/api/usage-summary`，头 `Cookie: tr_session=<value>`，20s 超时；返回 `availableBalanceCny`；401 抛"cookie 失效"。

#### `getBalanceCached(cookie, ttlSec): Promise<number | undefined>`
带 TTL 缓存的余额查询（按 cookie 粒度）；查询失败返回 undefined（不抛错）。

#### `checkKeyBalance(cookie): Promise<{ sufficient: boolean; balance?: number }>`
检查余额是否充足并返回查询到的余额值（供日志/管理界面展示）。判定：余额 > minBalanceCny（默认 0，即余额 ≤ 0 视为不足）→ `sufficient=true`；查询失败（cookie 失效/网络）→ `{sufficient: true}`（不阻塞请求，回退被动检测——余额不足时 API 返回 402 触发轮换）。

#### `isKeyBalanceSufficient(cookie): Promise<boolean>`
判断余额是否充足（> minBalanceCny）；委托 `checkKeyBalance`；查询失败返回 true（不阻塞请求，回退被动检测）。

#### `testKeyAvailability(entry, baseUrl?): Promise<{ ok: boolean | null; reason?: "balance" | "invalid" | "network" }>`
手动检测可用性：有 cookie 先查余额（≤ 阈值 → `{ok:false, reason:"balance"}`）→ 发最小真实聊天请求（`say ok` + `max_tokens=8`）：200 → `{ok:true}`，402/`INSUFFICIENT_BALANCE` → `{ok:false, reason:"balance"}`，401 → `{ok:false, reason:"invalid"}`，网络/超时/其他 → `{ok:null}`（无法确定）。

---

### 4.8 `src/apiModelList.ts`

#### `interface ApiModelMetadata`
`{ id, supports_responses?, supports_anthropic?, supports_vision?, supports_reasoning?, supports_tools?, context_length?, max_completion_tokens? }` — `/v1/models` 返回的扩展模型元数据（能力标记子集）。

#### `getApiModelIds(apiKey): Promise<Set<string>>`
从 `/v1/models` 拉取可用模型 ID 列表并返回 Set。使用内存缓存（5 分钟 TTL），API 不可用时静默降级（保留旧缓存或返回空集）。导出 `isApiFetchSuccessful()` 检查上次请求是否成功。

#### `getResponsesSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_responses=true` 的模型 ID 集。供 `provideModel.ts` 在启动时缓存为动态标记（`getResponsesModelIds()`），由 provider 在 auto 模式下查询决定是否使用 Responses 协议。

#### `getAnthropicSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_anthropic=true` 的模型 ID 集。供 `provideModel.ts` 在启动时缓存为动态标记（`getAnthropicModelIds()`），由 provider 在 auto 模式下查询决定是否使用 Anthropic 协议。

#### `getVisionSupportedModelIds(apiKey): Promise<Set<string>>`
从缓存的 `/v1/models` 元数据中筛选 `supports_vision=true` 的模型 ID 集。供 `extension.ts` 的 `tokenrhythm.setVisionProxyModel` 命令动态加载视觉模型列表（QuickPick 选择代替手填）。

#### `isApiFetchSuccessful(): boolean`
返回最近一次 API 模型列表拉取是否成功。用于模型提供者决定是否应用 API 过滤。

---

### 4.7 `src/modelsDev.ts`

#### `interface ModelsDevEntry`
`{ id, name?, family?, reasoning?, tool_call?, structured_output?, temperature?, attachment?, modalities?, limit? }` — models.dev 数据库中单个模型条目的接口。

#### `ensureModelsDevLoaded(): Promise<void>`
从 `https://models.dev/models.json` 下载完整模型目录并构建内存索引（完整 ID → 条目 + 短 ID → 条目）。1 小时缓存 TTL，失败时静默保留旧缓存。首次无缓存时初始化为空 Map。

#### `lookupModelDevEntry(apiModelId): ModelsDevEntry | undefined`
按 API 模型 ID 查找 models.dev 元数据。匹配策略：1) 完整 models.dev ID 精确匹配，2) 短 ID（斜杠后最后一段）匹配，3) 后缀匹配。

---

### 4.8 `src/modelSync.ts`

#### `syncModelsOnStartup(context): Promise<void>`
启动模型同步入口（fire-and-forget，不阻塞扩展激活）。流程：
1. 读取 `tokenrhythm.syncModelsOnStartup` 配置（默认开启），关闭则直接返回。
2. 检查 `globalState` 的 `tokenrhythm.lastModelSyncDate`（上次成功同步日期），若等于今天（本地时间 `YYYY-MM-DD`）则跳过。
3. 用 `getPrimaryApiKey()` 获取主 key（任意有效 key 即可——`/v1/models` 实测不校验余额，余额 < 0 也 200）；缺失时记录 `⏭️ 跳过` 事件并返回（不标记已同步，下次打开重试）。
4. `ensureModelsDevLoaded()` 预热 models.dev 元数据缓存（1 小时 TTL）。
5. `getApiModelIds()` 拉取 API 模型列表；`isApiFetchSuccessful()` 为 false 或列表为空时记录 `❌ 失败` 事件并返回（不标记已同步）。
6. 用 `getBuiltInModelIds()` 对比，找出不在内置列表中的新模型。
7. `logSyncEvent()` 记录 `✅ 成功` 事件（含新模型列表）；成功后 `globalState.update()` 标记今日已同步。

#### `logSyncEvent(status, detail): Promise<void>`
将一条同步事件以**一行日志**输出到「TokenRhythm」输出通道（`models.sync` 标签，含状态/说明）。**不写任何文件**——v1.7.0 起移除工作区 `.copilot/model-sync-log.md`（该文件会污染用户仓库，见 issue #1）。写入失败仅记日志，不影响启动流程。

---

### 4.10 `src/provideModel.ts`

#### `prepareLanguageModelChatInformation(options, _token, _secrets): Promise<LanguageModelChatInformation[]>`
获取模型信息列表。默认使用硬编码的内置模型列表（委托 `getBuiltInModelInfos()`）。当配置 `tokenrhythm.enableAutoModelDiscovery` 开启时（默认），用 `getPrimaryApiKey()` 获取主 key（任意有效 key 即可——`/v1/models` 不校验余额），从 API 获取可用模型 ID 列表，过滤内置模型（仅保留 API 中存在的模型），并从 models.dev 自动发现新增模型（默认 `thinkingMode="always"`）。启动时通过 `getResponsesSupportedModelIds()` / `getAnthropicSupportedModelIds()` 读取 `/v1/models` 的 `supports_responses` / `supports_anthropic` 标记，缓存到模块级集合供 `getResponsesModelIds()` / `getAnthropicModelIds()` 同步查询（不硬编码模型 ID，未来任何模型获得协议支持自动生效）。**末尾按 `tokenrhythm.apiMode` 过滤**：`anthropic` 仅保留 `supports_anthropic=true` 的模型，`responses` 仅保留 `supports_responses=true` 的模型（能力集合为空时回退全部）。API 不可用时静默回退到全量内置列表。自动发现模型与内置模型一致：`maxInputTokens` 按真实上下文的**可配置比例**声明（`getMaxInputTokensRatio()`，默认 `1.0`，建议 `0.8`），`context_length` / `max_completion_tokens` 保持真实值用于 API 请求体。

#### `getResponsesModelIds(): Set<string>`
同步返回当前探测到的 supports_responses=true 模型 ID 集（由 `prepareLanguageModelChatInformation` 在启动时更新）。provider.ts 在 auto 模式下查询此集合决定是否使用 Responses 协议。

#### `getAnthropicModelIds(): Set<string>`
同步返回当前探测到的 supports_anthropic=true 模型 ID 集（由 `prepareLanguageModelChatInformation` 在启动时更新）。provider.ts 在 auto 模式下查询此集合决定是否使用 Anthropic 协议。

#### `getAutoDiscoveredModelConfig(modelId): TokenRhythmModelItem | undefined`
返回之前自动发现的模型配置。由 `provider.ts` 在 `getBuiltInModelConfig()` 返回 undefined 时作为回退调用。

---

### 4.7 `src/provideToken.ts`

#### `const BaseTokensPerMessage = 3`
每条消息的基础 Token 数。

#### `const BaseTokensPerName = 1`
每个名称的基础 Token 数。

#### `countMessageTokens(text, modelConfig): Promise<number>`
计算消息的总 Token 数。支持 `LanguageModelTextPart`、`LanguageModelDataPart`（图片/二进制）、`LanguageModelToolCallPart`、`LanguageModelToolResultPart`、`LanguageModelThinkingPart`。

#### `textTokenLength(text): Promise<number>`
使用 tiktoken 分词器计算文本的 Token 数。

#### `countToolTokens(tools): Promise<number>`
计算工具定义的总 Token 数。

#### `calculateImageTokenCost(dataUrl): number`
基于图片尺寸计算 Token 成本。使用 512px 磁贴算法：基础 85 Token + 每磁贴 170 Token。

#### `calculateNonImageBinaryTokens(byteLength): number`
计算非图片二进制数据的 Token 成本（约 0.75 Token/字节）。

---

### 4.8 `src/utils.ts`

#### `interface ParsedModelId`
`{ baseId: string; configId?: string }` — 解析后的模型 ID。

#### `getModelProviderId(model): string`
从模型对象中提取提供商 ID，依次检查 `owned_by`、`provide`、`provider`、`ownedBy`、`owner`、`vendor` 字段。

#### `normalizeUserModels(models): TokenRhythmModelItem[]`
规范化用户自定义模型列表，为每个模型设置 `owned_by` 字段。

#### `parseModelId(modelId): ParsedModelId`
解析模型 ID，按 `::` 分隔为 `baseId` 和 `configId`。

#### `mapRole(message): "user" | "assistant" | "system"`
将 VS Code 消息角色映射为字符串角色。

#### `convertToolsToOpenAI(options?): { tools?, tool_choice? }`
将 VS Code 工具定义转换为 OpenAI 函数工具定义。

#### `createRetryConfig(): RetryConfig`
从 VS Code 设置中读取重试配置。

#### `executeWithRetry<T>(fn, retryConfig): Promise<T>`
使用指数退避策略执行可重试的异步操作。

#### `isRetryableError(error, retryableStatusCodes): boolean`
判断错误是否可重试（网络错误 + 指定 HTTP 状态码）。

#### `isImageMimeType(mimeType): boolean`
判断 MIME 类型是否为图片。

#### `createDataUrl(part): string`
从 `LanguageModelDataPart` 创建 Base64 Data URL。

#### `arrayBufferToBase64(buffer): string`
将 Uint8Array 转换为 Base64 字符串。

#### `isToolResultPart(part): boolean`
判断是否为 `LanguageModelToolResultPart`。

#### `tryParseJSONObject(text): { ok: true, value } | { ok: false }`
安全尝试解析 JSON 对象字符串。

---

### 4.23 `src/vision/types.ts`

#### `interface StoredImage`
`{ data: Uint8Array; mimeType: string }` — 存储的图片数据，用于 ask_image 工具。

#### `interface InterceptedToolCall`
`{ id: string; name: string; args: { imageIndex?: number; imageIndices?: number[]; query: string } }` — 被拦截的 ask_image 或 ask_with_multi_image 工具调用信息。`query` 是模型对图片的具体提问。`imageIndex` 用于单图，`imageIndices` 用于多图对比。

#### `const ASK_IMAGE_TOOL_DEF`
ask_image 工具定义的 OpenAI 格式（`type: "function"`），包含 `imageIndex` 和 `query` 参数签名。

#### `const ASK_IMAGE_TOOL_NAME`
`"ask_image"` — ask_image 工具名称常量。

#### `const ASK_WITH_MULTI_IMAGE_TOOL_DEF`
`ask_with_multi_image` 工具的 OpenAI 格式工具定义（`type: "function"`），包含 `imageIndices`（number[]）和 `query` 参数签名。支持多张图片的同时传入，模型可用此工具进行对比、差异分析等需要同时看多图的场景。

#### `const ASK_WITH_MULTI_IMAGE_TOOL_NAME`
`"ask_with_multi_image"` — ask_with_multi_image 工具名称常量。仅在 `_localImages.length >= 2` 时注入。

#### `const DEFAULT_VISION_PROMPT`
默认的图片分析提示词（未设置自定义查询时使用）。

---

### 4.24 `src/vision/imageProxy.ts`

#### `callVisionModel(imageData, mimeType, visionModelId, query, token, progress?): Promise<string>`
调用视觉模型回答关于图片的查询。使用 `vscode.lm.selectChatModels()` 查找模型，发送图片+查询文本，收集流式回答返回，并可通过 `progress` 实时转发 `LanguageModelTextPart`。与旧版 `describe_image` 不同，`query` 参数来自模型的 `ask_image` 工具调用，允许针对性提问（如"按钮是什么颜色？"）。支持 thinking 模式配置，通过 `tokenrhythm.visionProxyThinking` 设置控制，开启时发送 `reasoning_effort="high"`，关闭时发送 `reasoning_effort="disabled"`。

#### `callVisionModelMulti(images, visionModelId, query, token, progress?): Promise<string>`
多图版本的视觉模型调用。将多张图片的 `LanguageModelDataPart` 和 query 文本放在同一条消息中发送给视觉模型，使其可以同时看到所有图片进行比较分析。支持流式输出转发。

---

### 4.24b `src/vision/historyCodec.ts`（源自上游 opencode-go-copilot v1.9.2）

跨轮视觉历史编解码模块：把每轮完成的 ask_image 工具调用/结果序列化为私有 MIME 的 DataPart 负载，下一轮请求时解码并重建标准 tool call/tool result 消息。

#### `const VISION_TOOL_HISTORY_MIME`
`"application/vnd.opencodego.vision-tool-history+json"` — 私有 MIME 类型，用于在响应流中持久化被拦截的视觉工具调用。VS Code 可将该 DataPart 带入下一轮请求。

#### `interface VisionToolHistoryArguments`
`{ imageIndex?: number; imageIndices?: number[]; query: string; [key: string]: unknown }` — 视觉工具调用参数（与 `InterceptedToolCall.args` 对应）。

#### `interface VisionToolHistoryEntry`
`{ id: string; name: typeof ASK_IMAGE_TOOL_NAME | typeof ASK_WITH_MULTI_IMAGE_TOOL_NAME; args: VisionToolHistoryArguments; result: string; reasoningContent?: string }` — 一条完整的视觉工具调用/结果记录。`reasoningContent` 为 DeepSeek 兼容的 assistant tool call 推理内容。

#### `serializeVisionToolHistory(entry): Uint8Array`
序列化：`{ version: 1, entry }` JSON → `TextEncoder().encode()`。

#### `deserializeVisionToolHistory(data): VisionToolHistoryEntry | null`
解码 + 严格校验（`version === 1`、工具名合法、`args.query`/`result` 为 string、`imageIndex`/`imageIndices` 为非负整数）；任何不符返回 `null`。

#### `toOpenAIVisionToolMessages(entry): OpenAIChatMessage[]`
重建 OpenAI 消息对：`[{ role: "assistant", tool_calls: [...], reasoning_content? }, { role: "tool", tool_call_id, content }]`。

#### `toAnthropicVisionToolMessages(entry): AnthropicMessage[]`
重建 Anthropic 消息对：`[{ role: "assistant", content: [{ type: "tool_use", ... }] }, { role: "user", content: [{ type: "tool_result", ... }] }]`。

---

### 4.24c `src/vision/historyPart.ts`（源自上游 opencode-go-copilot v1.9.2）

#### `createVisionToolHistoryPart(entry): vscode.LanguageModelDataPart`
创建携带跨轮视觉历史的数据部分：`new vscode.LanguageModelDataPart(serializeVisionToolHistory(entry), VISION_TOOL_HISTORY_MIME)`。由 provider 每轮视觉代理完成后输出到响应流。

#### `parseVisionToolHistoryPart(part): VisionToolHistoryEntry | null`
解析持久化的视觉历史 DataPart：非 `LanguageModelDataPart` 或 MIME 不匹配返回 `null`；否则 `deserializeVisionToolHistory(part.data)`。由 openai/anthropic 的 `convertMessages` 在 part 循环开头调用。

---

### 4.25 `scripts/cookieApi/types.ts`

#### `interface ApiResponse<T>`
`{ code, message, data: T, traceId? }` — 用户中心 API 通用响应包装。

#### `interface UsageSummary`
`{ calls, successCalls, errorCalls, abortedCalls, inputTokens, outputTokens, costCny, balanceCny, frozenBalanceCny, availableBalanceCny, expiringBalanceCny, nextExpiryAt, currency }` — 用量 + 余额汇总。

#### `interface CallLog`
单条调用日志完整字段（时间、端点、协议、模型、Key 名称、状态、耗时、Token 用量、成本、finishReason 等）。

#### `interface CallLogPage`
`{ list: CallLog[] }` — 调用日志分页响应 data。

#### `interface CallLogQueryParams`
`{ startAt, endAt, page?, pageSize? }` — 调用日志查询参数。

#### `interface CallLogStats`
`{ total, byModel, byStatus, byKey, totalCostCny }` — 调用日志统计汇总。

---

### 4.26 `scripts/cookieApi/cookieApi.ts`

#### `const COOKIE_API_BASE_URL`
`"https://tokenrhythm.studio"` — 用户中心 API 基础地址。

#### `const TR_SESSION_COOKIE`
`"tr_session"` — 登录会话 Cookie 名称常量。

#### `apiGet<T>(sessionCookie, path, params?): Promise<ApiResponse<T>>`
发送带 cookie 的 GET 请求并解析 JSON。401 时抛出"Cookie 失效"错误，非 2xx 或 `code !== 0` 时抛错。20 秒超时。

#### `queryUsageSummary(sessionCookie): Promise<ApiResponse<UsageSummary>>`
查询账号用量 + 余额汇总（`GET /api/usage-summary`）。

#### `queryCallLogs(sessionCookie, params: CallLogQueryParams): Promise<CallLog[]>`
查询调用日志分页（`GET /api/call-logs/page`），返回 `data.list`。

#### `queryAllCallLogs(sessionCookie, startAt, endAt, options?): Promise<CallLog[]>`
拉取时间范围内全部调用日志，自动翻页（`pageSize` 默认 100，`maxPages` 默认 10）。

#### `summarizeCallLogs(logs: CallLog[]): CallLogStats`
对调用日志按模型 / 状态 / Key 分组统计，计算总成本。

---

### 4.27 `scripts/cookieApi/cli.ts`

#### `main(): Promise<void>`
CLI 入口：`node scripts/out/cookieApi/cli.js <tr_session值> [startAt] [endAt]`。依次输出账号汇总、调用日志明细表格（最多 50 条）、按模型/状态/Key 统计。

---

### 4.28 `scripts/export-call-logs.mjs`

#### `main 流程`
全量导出调用日志为 CSV。通过环境变量 `TR_SESSION` 传入 cookie（避免出现在命令行历史），自动翻页（每页 100 条）拉取时间范围内全部调用日志，输出 17 列精简 CSV（`# / requestAt / model / keyName / status / latencyMs / inputTokens / outputTokens / cacheReadTokens / reasoningTokens / costCny / apiSurface / finishReason / traceId / clientApp / stream / retryCount`）。

用法：
```bash
$env:TR_SESSION="<tr_session值>"; node scripts/export-call-logs.mjs [startAt] [endAt] [outFile]
```
默认时间范围 `2026-08-03T00:00:00.000Z ~ 2026-08-05T00:00:00.000Z`，默认输出 `call-logs-export.csv`。

---

### 4.29 `scripts/analyze-call-logs.mjs`

#### `main 流程`
分析导出的调用日志 CSV，输出统计摘要：调用总数、总成本、总输入/输出/缓存 Token；按模型（次数/成本/Token）、按 Key、按状态、按协议、按小时（UTC）分布；单次成本 TOP5。

用法：`node scripts/analyze-call-logs.mjs [csv路径]`（默认读取 `call-logs-export.csv`）。

---

### 4.9 `src/statusBar.ts`

#### `initStatusBar(context): vscode.StatusBarItem`
创建状态栏条目并重置累计计数器。**启动时不显示**（保持隐藏），仅在用户实际使用本插件模型时才显示。

#### `showTokenStatusBar(statusBarItem): void`
显示状态栏并取消待执行的自动隐藏定时器。在 `provideLanguageModelChatResponse` 发起请求时调用。

#### `scheduleStatusBarHide(statusBarItem, delayMs?): void`
调度状态栏自动隐藏（默认空闲 60 秒后隐藏，可被下一次请求取消）。在请求结束（finally）时调用，确保切换其他模型后状态栏不会残留。

#### `formatTokenCount(value): string`
格式化 Token 数为人类可读格式 (K/M/B)。

#### `createProgressBar(usedTokens, maxTokens): string`
创建视觉进度条（使用 Unicode 块字符 ▁▂▃▄▅▆▇█）。

#### `updateContextStatusBar(messages, tools, model, statusBarItem, modelConfig): Promise<void>`
更新状态栏文本：显示当前消息的 Token 用量和进度条。新对话时重置累计计数器。

#### `resetCumulativeCounters(): void`
重置所有累计 Token 计数器（VS Code 启动和新对话时调用）。

#### `recordUsage(usage: StreamUsage): void`
将流式用量累计到全局计数器。

#### `updateCumulativeTooltip(statusBarItem): void`
更新状态栏工具提示，显示累计输入/输出 Token 数和缓存命中率。

---

### 4.10 `src/logger.ts`

#### `class Logger`

| 方法 | 说明 |
|------|------|
| `init()` | 创建 VS Code `LogOutputChannel("TokenRhythm")` |
| `debug(tag, data)` | 输出 DEBUG 级别日志 |
| `info(tag, data)` | 输出 INFO 级别日志 |
| `warn(tag, data)` | 输出 WARN 级别日志 |
| `error(tag, data)` | 输出 ERROR 级别日志 |
| `sanitizeHeaders(headers)` | 脱敏敏感 HTTP 头 (Authorization, x-api-key 等) |
| `dispose()` | 清理输出通道 |

#### `export const logger = new Logger()`
单例导出。

---

### 4.11 `src/localize.ts`

#### `l10n(key): string`
获取当前语言的本地化字符串。当前支持简体中文 (`zh-cn`)，回退到英文 key。

#### `l10nFormat(template, ...args): string`
格式化本地化字符串，替换 `{0}`, `{1}` 等占位符。

---

### 4.12 `src/versionManager.ts`

#### `class VersionManager`

| 静态方法 | 说明 |
|----------|------|
| `getVersion(): string` | 获取扩展版本号（从 `package.json` 读取） |
| `getUserAgent(): string` | 构建 User-Agent 字符串 |
| `getClientInfo(): { name, version, author }` | 获取客户端信息 |

---

### 4.13 `src/openai/openaiTypes.ts`

#### `interface OpenAIToolCall`
`{ id, type: "function", function: { name, arguments } }` — OpenAI 工具调用。

#### `interface OpenAIFunctionToolDef`
`{ type: "function", function: { name, description?, parameters? } }` — OpenAI 函数工具定义。

#### `interface OpenAIChatMessage`
`{ role, content?, name?, tool_calls?, tool_call_id?, reasoning_content? }` — OpenAI 聊天消息。

#### `interface ChatMessageContent`
`{ type: "text" | "image_url", text?, image_url? }` — 多模态消息内容。

#### `type OpenAIChatRole`
`"system" | "user" | "assistant" | "tool"` — 聊天角色。

#### `interface ReasoningDetailCommon`
`{ id, format, index? }` — 推理详情公共接口。

#### `interface ReasoningSummaryDetail extends ReasoningDetailCommon`
`{ type: "reasoning.summary", summary }` — 推理摘要。

#### `interface ReasoningEncryptedDetail extends ReasoningDetailCommon`
`{ type: "reasoning.encrypted", data }` — 加密推理内容。

#### `interface ReasoningTextDetail extends ReasoningDetailCommon`
`{ type: "reasoning.text", text, signature? }` — 推理文本。

#### `type ReasoningDetail = ReasoningSummaryDetail | ReasoningEncryptedDetail | ReasoningTextDetail`
推理详情联合类型。

---

### 4.14 `src/openai/openaiApi.ts`

#### `class OpenaiApi extends CommonApi<OpenAIChatMessage, Record<string, unknown>>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): OpenAIChatMessage[]`
将 VS Code 消息转换为 OpenAI 格式。支持文本、图片、工具调用、工具结果、推理内容的消息转换。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。同时递归扫描 `LanguageModelToolResultPart.content` 中的图片一并存入（确保通过工具返回的图片也能被 `ask_image` 代理识别）。**跨轮视觉历史恢复（v1.8.0）**：part 循环开头调用 `parseVisionToolHistoryPart` 识别私有 MIME 的历史 DataPart，在 `joinedText` 计算后、assistant 消息处理前用 `toOpenAIVisionToolMessages` 重建标准 `assistant tool_call → tool → assistant text` 消息序列（保证顺序正确）。

#### `prepareRequestBody(rb, um?, options?): Record<string, unknown>`
构建 OpenAI 请求体。设置 temperature、top_p、max_tokens、reasoning_effort（adaptive 模式时跳过）、thinking 模式（TokenRhythm OpenAI 端点仅接受字符串：支持 `{ type: "enabled" }`、`{ type: "auto" }`（自适应模式，`adaptive` 会被拒绝）和关闭用 `{ type: "disabled" }`）、stop、tools、tool_choice 以及各种惩罚参数和 extra 参数。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 OpenAI SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，处理 `[DONE]` 标记，解析 usage 用量信息，委托 `processDelta()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调，防止多次调用 `processStreamingResponse` 时回调累积。

#### `private processDelta(delta, progress): Promise<boolean>`
处理单个 stream delta。按序处理：推理内容 → XML think 块 → 文本内容 → 工具调用。支持 `reasoning_details` 数组（OpenRouter 格式）。

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式聊天消息生成器（用于 Git 提交生成）。发送 HTTP 请求后 yield 文本块。注册取消回调：`signal.addEventListener("abort")` 时调用 `reader.cancel()` 立即中断流。

---

### 4.15 `src/anthropic/anthropicTypes.ts`

#### `type AnthropicRole`
`"user" | "assistant"`

#### `interface AnthropicTextBlock`
`{ type: "text", text }` — 文本块。

#### `interface AnthropicImageBlock`
`{ type: "image", source: { type: "base64", media_type, data } }` — 图片块。

#### `interface AnthropicThinkingBlock`
`{ type: "thinking", thinking, signature? }` — 推理块。

#### `interface AnthropicToolUseBlock`
`{ type: "tool_use", id, name, input }` — 工具使用块。

#### `interface AnthropicToolResultBlock`
`{ type: "tool_result", tool_use_id, content: string | (AnthropicTextBlock | AnthropicImageBlock)[], is_error? }` — 工具结果块（v1.8.0 起 content 类型放宽为支持图片块）。

#### `type AnthropicContentBlock`
文本 | 图片 | 推理 | 工具使用 | 工具结果的联合类型。

#### `interface AnthropicMessage`
`{ role, content: string | AnthropicContentBlock[] }` — Anthropic 消息。

#### `interface AnthropicRequestBody`
Anthropic 请求体。包含 `model`, `messages`, `max_tokens`, `system`, `stream`, `temperature`, `top_p`, `top_k`, `thinking`, `tools`, `tool_choice` 等字段。

#### `interface AnthropicToolDefinition`
`{ name, description?, input_schema? }` — Anthropic 工具定义。

#### `type AnthropicToolChoice`
`{ type: "auto" } | { type: "any" } | { type: "tool"; name } | { type: "none" }`

#### `interface AnthropicStreamChunk`
流式响应块的完整定义。包含 `type`（8 种事件类型）、`message`、`content_block`、`delta`、`usage`、`error` 等字段。

---

### 4.16 `src/anthropic/anthropicApi.ts`

#### `class AnthropicApi extends CommonApi<AnthropicMessage, AnthropicRequestBody>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): AnthropicMessage[]`
将 VS Code 消息转换为 Anthropic 格式。系统消息提取到 `_systemContent`。支持文本、图片、工具使用、工具结果、推理内容。使用 `content` 块数组格式。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。同时递归扫描 `AnthropicToolResultBlock.content` 中的图片一并存入（确保通过工具返回的图片也能被 `ask_image` 代理识别）。**连续工具结果合并（v1.8.0）**：for 循环外声明 `pendingToolResults` 缓冲区与 `flushPendingToolResults`；纯工具结果消息（user + 有 toolResults + 无文本/图片/历史）缓冲入区并 `continue`，其他消息类型前先 flush——保证同一 assistant `tool_use` 对应的全部 `tool_result` 输出为**单条** user 消息（Anthropic 协议要求，避免 400 "tool_use ids were found without tool_result blocks immediately after"）；循环结束后最后 flush 一次。**跨轮视觉历史恢复（v1.8.0）**：part 循环开头调用 `parseVisionToolHistoryPart`，在 `joinedText` 计算后、system 消息处理前用 `toAnthropicVisionToolMessages` 重建 `assistant tool_use → user tool_result` 序列（放在工具结果合并缓冲逻辑之前保证顺序正确）。

#### `prepareRequestBody(rb, um?, options?): AnthropicRequestBody`
构建 Anthropic 请求体。设置 max_tokens、system、thinking 模式（支持 `{ type: "enabled" }`、`{ type: "adaptive" }` 和 `{ type: "disabled" }`）、tools（转换为 Anthropic 格式）、tool_choice（auto/any/none）以及 extra 参数。**仅在 thinking 强制 enabled 时跳过 temperature/top_p**（2026-08-06 实测：`enabled` + temperature/top_p → 400"请求参数组合无效"，符合 Anthropic 协议 extended thinking 须省略 temperature 的规则；`adaptive`/`disabled` 与 temperature/top_p 组合均 200 通过，故保留温度控制）。保留 top_k。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 Anthropic SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，委托 `processAnthropicChunk()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调，防止多次调用 `processStreamingResponse` 时回调累积。

#### `private processAnthropicChunk(chunk, progress): Promise<void>`
处理 Anthropic 流式块。支持的事件类型：
- `ping` — 忽略
- `error` — 记录错误
- `message_start` — 消息元数据
- `message_delta` — 停止原因和用量
- `content_block_start` — 块开始（text/thinking/tool_use）
- `content_block_delta` — 增量内容（text_delta/thinking_delta/input_json_delta/signature_delta）
- `content_block_stop` / `message_stop` — 清空缓冲区

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式消息生成器（Anthropic 模式，用于 Git 提交生成）。注册取消回调：`signal.addEventListener("abort")` 时调用 `reader.cancel()` 立即中断流。

---

### 4.17 `src/responses/responsesTypes.ts`

#### `interface ResponsesContentBlock`
`{ type: "input_text" | "output_text" | "input_image"; text?; image_url?; annotations? }` — Responses 内容块（仅这三种类型被 TokenRhythm 端点接受）。

#### `interface ResponsesInputMessage`
`{ role: "user" | "assistant" | "system" | "developer"; content: string | ResponsesContentBlock[] }` — input 数组中的消息。

#### `interface ResponsesFunctionCallItem`
`{ type: "function_call"; id; call_id?; name; arguments; status? }` — 模型输出的工具调用条目。

#### `interface ResponsesReasoningItem`
`{ type: "reasoning"; id; summary?: [{ type: "summary_text"; text }] }` — 推理输出条目。

#### `interface ResponsesMessageItem`
`{ type: "message"; id; role; content: ResponsesContentBlock[] }` — 消息输出条目。

#### `interface ResponsesFunctionTool`
`{ type: "function"; name; description?; parameters? }` — Responses 格式的工具定义。

#### `interface ResponsesUsage`
`{ input_tokens; output_tokens; total_tokens; input_tokens_details?; output_tokens_details? }` — 用量信息。

#### `interface ResponsesResponse`
非流式响应对象：`{ id; object; model; status; output; output_text?; usage?; error?; cost_cny?; trace_id? }`。

#### `type ResponsesStreamEventType`
流式事件类型联合：`response.created` / `response.in_progress` / `response.completed` / `response.failed` / `response.output_item.added` / `response.output_item.done` / `response.content_part.added` / `response.content_part.done` / `response.output_text.delta` / `response.output_text.done` / `response.reasoning_summary_text.delta` / `response.reasoning_summary_text.done` / `response.function_call_arguments.delta` / `response.function_call_arguments.done` / `response.usage` / `error`。

---

### 4.18 `src/responses/responsesApi.ts`

#### `class ResponsesApi extends CommonApi<ResponsesInputMessage, Record<string, unknown>>`

#### `constructor(modelId: string)`
构造函数，传入模型 ID。

#### `convertMessages(messages, modelConfig): ResponsesInputMessage[]`
将 VS Code 消息转换为 Responses input 格式。系统消息提取到 `_systemContent`（用于 `instructions` 字段）。支持文本、图片（`input_image`）、历史工具调用/结果（**文本化回填**：assistant `[tool_call] name(args) [/tool_call]` + user `[tool_result] ... [/tool_result]`，因端点拒绝 function_call 块）。modelConfig 新增 `vision` 字段，非视觉模型时自动替换图片为文本引用并存储图片数据。

#### `prepareRequestBody(rb, um?, options?): Record<string, unknown>`
构建 Responses 请求体。设置 instructions（system）、temperature、top_p、max_output_tokens、reasoning（启用→`{ effort }`，禁用→`{ effort: "none" }`，adaptive→省略）、tools（Responses function 格式）、tool_choice（仅 `auto`/`none`，TokenRhythm 拒绝 object/required 形式）。**工具定义必须使用扁平格式** `{ type: "function", name, description, parameters }`（OpenAI 嵌套 `function` 格式被端点拒绝）。非视觉模型且存在图片时自动注入 `ask_image` 工具定义。

#### `processStreamingResponse(responseBody, progress, token): Promise<void>`
处理 Responses SSE 流式响应。逐行解析 `data:` 前缀的 SSE 事件，委托 `processResponsesEvent()`。注册取消回调：`token.onCancellationRequested` 时调用 `reader.cancel()` 立即中断流式读取。在 `finally` 块中 dispose 该回调。

#### `private processResponsesEvent(event, progress): Promise<void>`
处理单个流式事件：
- `response.output_item.added` — function_call 缓冲（按 output_index）
- `response.reasoning_summary_text.delta` — 推理内容（bufferThinkingContent）
- `response.output_text.delta` — 文本内容
- `response.function_call_arguments.delta/done` — 工具参数累积/发射
- `response.output_item.done` — function_call 完成时尝试发射
- `response.completed` — usage 统计（input_tokens/output_tokens/cached_tokens）
- `response.failed` — 抛出错误

#### `private tryEmitBufferedResponsesToolCall(outputIndex, progress): Promise<void>`
尝试发射缓冲的 function_call 为 LanguageModelToolCallPart。ask_image/ask_with_multi_image 被拦截存入 interceptedToolCall。

#### `private flushResponsesToolCalls(progress, throwOnInvalid): Promise<void>`
清空所有缓冲的 function_call，发射剩余工具调用（流结束时调用）。

#### `async *createMessage(model, systemPrompt, messages, baseUrl, apiKey, signal?): AsyncGenerator<{ type: "text"; text: string }>`
非流式消息生成器（Responses 模式，用于 Git 提交生成）。发送 POST /responses 后解析 `output_text` 并 yield。reasoning 禁用时传 `{ effort: "none" }`。

---

### 4.19 `src/gitCommit/commitMessageGenerator.ts`

#### `let commitGenerationAbortController: AbortController | undefined`
全局中止控制器。

#### `const DEFAULT_PROMPT`
默认提示词模板。包含 `system`（系统提示，强调直接输出 commit 信息、不包含任何前言和解释）、`user`（用户输入模板）、`styleReference`（风格参考模板，含语言匹配指令）。

#### `generateCommitMsg(secrets, scm?): Promise<void>`
入口函数。检测 Git 扩展和仓库，对多仓库场景进行选择，调用 `generateCommitMsgForRepository()`。

#### `orchestrateWorkspaceCommitMsgGeneration(secrets, repos): Promise<void>`
多仓库编排。筛选有变化的仓库，0/1/多仓库分别处理。

#### `filterForReposWithChanges(repos): Promise<any[]>`
筛选出有 Git 变更的仓库。

#### `promptRepoSelection(repos): Promise<any>`
弹出 QuickPick 让用户选择仓库（支持"全部生成"）。

#### `generateCommitMsgForRepository(secrets, repository): Promise<void>`
为单个仓库生成提交消息。显示进度条，支持取消。

#### `ensureApiKeyEntry(secrets): Promise<ApiKeyEntry | undefined>`
确保 API Key 存在（经 keyManager.getApiKeyStore）；无任何 key 时弹输入框引导添加第一个。

#### `performCommitMsgGeneration(secrets, gitDiff, inputBox, repoPath?): Promise<void>`
核心生成逻辑。构建 prompt（含自定义提示词、最近提交风格、用户输入、diff 内容），支持 `auto` 语言模式（由模型根据历史 commit 风格自动推断），创建 API 实例，流式输出提交消息到 InputBox。API 协议选择遵循 `tokenrhythm.apiMode` 设置（`auto` 跟随模型默认，或强制 `openai`/`anthropic`/`responses`；`enableResponsesApi` 关闭时 auto 模式下的 responses 模型回退 openai），并将生效的 apiMode 写回 `selectedModel.apiMode` 以确保 `createMessage()` 构造正确的请求头（anthropic 用 `x-api-key`，openai/responses 用 `Bearer`）。支持通过配置 `tokenrhythm.commitIncludeCommitDiff` 控制风格参考中是否包含历史提交的实际代码变更（默认关闭）。支持通过配置 `tokenrhythm.commitAttachContextFiles`（默认开启）控制是否将仓库根目录的 `AGENTS.md` 和 `README.md` 内容附加到 prompt 中作为额外上下文。**多 key 轮换循环**：生成器消费包 while 循环，`pickNextApiKey` → 余额预检（cookie）→ `createMessage` 流式消费；轮换错误换 key 重试（若已产生部分输出则不换 key，避免覆盖 InputBox 内容）；用户取消立即中止。

#### `abortCommitGeneration(): void`
中止提交消息生成。

#### `extractCommitMessage(str): string`
从生成的文本中提取提交消息（移除代码块标记）。

#### `removeThinkTags(text): string`
移除文本中的 `<think>...</think>` 标签。

---

### 4.20 `src/gitCommit/gitUtils.ts`

#### `interface GitCommit`
`{ hash, shortHash, subject, author, date }` — Git 提交信息。

#### `checkGitRepo(cwd): Promise<boolean>`
检查当前目录是否为 Git 仓库。

#### `checkGitInstalled(): Promise<boolean>`
检查 Git 是否已安装。

#### `checkGitRepoHasCommits(cwd): Promise<boolean>`
检查 Git 仓库是否有提交记录。

#### `searchCommits(query, cwd): Promise<GitCommit[]>`
搜索 Git 提交记录（支持 hash 回退搜索）。

#### `getGitDiff(repoPath): Promise<string | undefined>`
获取 Git Diff。优先 staged diff (`git diff --cached`)，回退 unstaged diff (`git diff`)，使用 `-U1` 减少上下文行数，限制最多 500 行。

#### `interface GetRecentCommitsOptions`
`{ includeDiff?: boolean; maxDiffLinesPerCommit?: number }` — 获取最近提交的选项。

#### `getRecentCommits(repoPath, count, options?): Promise<string>`
获取最近的提交标题作为风格参考。可通过 `options.includeDiff` 启用包含每次提交的实际代码变更（diff），通过 `options.maxDiffLinesPerCommit` 控制每个提交 diff 的最大行数（默认 50）。diff 使用 `-U1` 减少上下文行数，避免两处改动之间夹杂不必要的未变更内容。

#### `limitDiffLines(diff, maxLines): string`
限制 diff 行数，超出时添加截断标记。

---

### 4.21 `src/tokenizer/tokenizerManager.ts`

#### `class TokenCache`
简单 LRU 缓存。

| 属性/方法 | 说明 |
|-----------|------|
| `cache` | `Map<string, number>` — 缓存存储 |
| `maxSize` | 最大条目数 (5000) |
| `maxSizeBytes` | 最大字节数 (5MB) |
| `currentSize` | 当前大小 |
| `get(key)` | 获取缓存值，更新最近使用 |
| `set(key, value)` | 设缓存值，超出限制时驱逐最久未使用的条目 |

#### `class TokenizerManager`

| 静态方法 | 说明 |
|----------|------|
| `initialize(extensionPath)` | 设置扩展路径并获取单例 |
| `setExtensionPath(path)` | 设置扩展路径 |
| `getInstance()` | 获取单例实例 |

| 实例方法 | 说明 |
|----------|------|
| `getTokenizer()` | 获取或创建 tiktoken 分词器实例（o200k_base） |
| `countTokens(text)` | 使用缓存和分词器计算文本 Token 数 |

#### `export const tokenizerManager = TokenizerManager.getInstance()`
导出的单例实例。

---

### 4.22 `src/tokenizer/imageUtils.ts`

#### `getImageDimensions(base64): { width, height }`
从 Base64 图片字符串中获取尺寸。根据 MIME 类型分发到不同解析函数。

#### `getMimeType(base64): string`
通过读取文件头字节判断图片类型（JPEG/GIF/WebP/PNG）。

#### `getPngDimensions(base64): { width, height }`
解析 PNG 图片尺寸（读取 IHDR 块）。

#### `getGifDimensions(base64): { width, height }`
解析 GIF 图片尺寸（读取逻辑屏幕描述符）。

#### `getJpegDimensions(base64): { width, height }`
解析 JPEG 图片尺寸（扫描 SOF0/SOF1/SOF2 标记）。

#### `getWebPDimensions(base64String): { width, height }`
解析 WebP 图片尺寸（支持 VP8/VP8L/VP8X 格式）。

---

## 5. 编译与构建

### 5.1 编译命令

```bash
# TypeScript 编译
npm run compile
# 等效于: npx tsc -p ./

# scripts 目录独立编译（cookieApi 等独立脚本，输出到 scripts/out）
npx tsc -p scripts/tsconfig.json

# ESLint 检查
npm run lint

# 仅类型检查（无输出）
npx tsc --noEmit

# 持续监视模式
npm run watch

# 打包 VSIX
npm run build
# 等效于: npx @vscode/vsce package -o extension.vsix
```

> `npm run compile` 在 `tsc` 编译后自动运行 `scripts/build-info.mjs`，生成 `out/build-info.json`（版本号 + 编译时间，标注 IANA 时区与 UTC 偏移）并追加记录到 `.copilot/build-log.md`。详见 6.1b「编译产物元信息铁律」。

### 5.2 编译配置 (tsconfig.json)

| 选项 | 值 |
|------|-----|
| `module` | `Node16` |
| `target` | `ES2024` |
| `lib` | `["ES2024", "dom"]` |
| `strict` | `true` |
| `outDir` | `out` |
| `rootDir` | `src` |
| `exclude` | `["scripts", "node_modules", "out"]` |

> `scripts/` 目录有独立 `tsconfig.json`（`rootDir: "."`，`outDir: "out"`，仅包含 `cookieApi/**/*.ts`），用 `npx tsc -p scripts/tsconfig.json` 编译，输出到 `scripts/out/`。

### 5.3 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@microsoft/tiktokenizer` | ^1.0.10 | o200k_base 分词器 |
| `@eslint/js` | 9.39.4 | ESLint JavaScript 推荐规则 |
| `@types/node` | ^22 | Node.js 类型定义 |
| `@types/vscode` | ^1.116.0 | VS Code 类型定义 |
| `eslint` | 9.39.4 | 代码检查工具 |
| `typescript` | ^5.9.2 | TypeScript 编译器 |
| `typescript-eslint` | 8.60.1 | TypeScript ESLint 配置与解析器 |

---

## 6. 开发规范

### 6.1 **编译检查铁律**

> **所有代码更改必须通过以下编译检查，确保无错误：**
> ```bash
> npm run compile
> # 或
> npx tsc --noEmit
> ```
> 任何编译错误（包括类型错误）必须在提交前修复。

### 6.1b **编译产物元信息铁律**

> **每次编译产物必须包含版本号和编译时间（标注时区）。**
>
> `npm run compile` 会在 `tsc` 编译后自动运行 `scripts/build-info.mjs`，生成：
> - `out/build-info.json` —— 随扩展打包的编译元信息（`version` / `buildTime`（UTC ISO 8601）/ `buildTimeLocal` / `timezone`（IANA 时区）/ `timezoneOffset`（UTC 偏移）/ `buildTimeDisplay`（本地时间 + 时区 + UTC 偏移））
> - `.copilot/build-log.md` —— 开发者侧编译日志，每次编译追加一行（编译时间 + 版本号 + 时区）
>
> **时区标注规则**：时间必须同时标注 IANA 时区 ID（如 `Asia/Shanghai`）和 UTC 偏移（如 `UTC+08:00`），避免跨机器/跨时区追溯产物时产生歧义。
> 禁止手动编辑 `out/build-info.json` 和 `.copilot/build-log.md`（由脚本自动生成）。
> 若编译产物缺少元信息（`out/build-info.json` 不存在），视为编译未完成，不得打包发布。

### 6.2 **AGENTS.md 同步更新铁律**

> **每次代码更改后，必须同步更新 `AGENTS.md`，包括但不限于：**
> - 新增/修改/删除函数、类、接口 → 更新第 4 节（函数定义大全）
> - 新增/删除/重命名文件 → 更新第 3 节（程序文件索引）及第 3.2 节的目录结构和文件说明表
> - 新增/修改/删除模型定义 → 更新第 1.3 节（模型清单）
> - 修改核心逻辑流程 → 更新第 2 节（详细逻辑架构）中的流程图和文字描述
> - 修改编译配置、依赖、构建命令 → 更新第 5 节（编译与构建）
> - 修改开发规范 → 更新第 6 节（开发规范）
> 
> 任何提交中若包含代码变更但未同步更新本文档，视为不合规。

### 6.3 PR 内容规范

> **当用户要求生成 PR (Pull Request) 内容时，必须遵循以下模板风格。**

#### PR Title 格式

使用 Conventional Commit 风格：
```
<type>: <brief description>
```

type 取值：`feat` | `fix` | `refactor` | `docs` | `chore` | `improve` 等。

#### PR Body 模板

```markdown
### Changes

**1. <功能/改动标题>**
- <具体变更点 1>
- <具体变更点 2>
- <...>

**2. <下一个功能/改动标题>**
- <具体变更点>
- <...>

### Files Changed

| File | Change |
|------|--------|
| `<file path>` | <一句话说明改了什么> |
| `<file path>` | <一句话说明改了什么> |
```

#### 撰写规范

- Title 首字母小写，用英文撰写
- Body 使用英文，用 **粗体标题** 组织 major change areas
- Changes 部分用项目符号列出每个功能点的具体变更，每点以句号结尾
- Files Changed 表格只列关键文件，说明简洁（不需要行数、路径全称）
- 不包含"如何测试"、"如何回滚"等运维内容，除非用户特别要求
- 语气精炼、直接，聚焦"改了什么"而非"为什么改"
- **从整体上审视**：按功能/模块组织内容，而非按 commit 罗列。将多个 commit 中属于同一功能点的更改合并描述，避免逐条罗列 commit 标题

### 6.4 更新日志内容规范

> **当用户要求生成基于 Git tag 的更新日志（Changelog）时，必须遵循以下格式风格。**

#### 格式模板

```markdown
### <功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述，说明改了什么、为什么、影响范围等>
- **<下一个具体功能/改动点标题>**：<详细描述>
- <无标题的简单变更点直接用一句话描述>

### <下一个功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述>
- <简单变更点>
```

#### 撰写规范

- 以 `###` 三级标题组织 major change areas，标题用中文，概括该类别下的所有变更
- 每个 change area 下列出具体变更点，用 `-` 项目符号
- 需要强调的变更点使用 `**<标题>**：<描述>` 格式，无需要强调的简单变更直接用一句话
- 描述应说明改了什么、为什么改（如有必要）、对用户的影响，聚焦"改了什么"而非罗列 commit 标题
- 用中文撰写，风格专业、精炼
- 不包含 `Files Changed` 表格或技术实现细节
- **按功能类别而非按 commit 时间组织**：从整体上审视 PR，将多个 commit 中属于同一功能领域的变更合并归类，避免逐条罗列 commit 标题

#### 示例

```markdown
### Git 提交消息生成增强

- **自动语言检测**：`tokenrhythm.commitLanguage` 新增 `auto` 模式（默认）。启用后模型自动从仓库最近 10 条历史提交中推断使用的语言风格，无需手动指定目标语言。
- **历史提交代码变更参考**：新增配置项 `tokenrhythm.commitIncludeCommitDiff`（默认关闭）。开启后模型在生成提交消息时会参考历史提交的实际代码变更，帮助模型更好地学习提交风格。
- **项目背景知识注入**：新增配置项 `tokenrhythm.commitAttachContextFiles`（默认开启）。生成提交消息时自动将 AGENTS.md 和 README.md 内容附加到 prompt 中。

### Diff 生成优化

- **减少上下文行数**：将 diff 上下文从 3 行改为 1 行（`-U1`），避免大量未变更代码混入 prompt 中干扰模型。
```

### 6.5 代码风格

- 使用 TypeScript 严格模式 (`strict: true`)
- 遵循 ES2024 标准
- 使用 ESModule 模块系统 (`import`/`export`)
- 所有新的 API 函数需有 JSDoc 注释
- 导出的函数和类必须显式标注类型
- 使用 `satisfies` 操作符确保类型安全

### 6.6 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| 类 | PascalCase | `TokenRhythmChatModelProvider` |
| 接口 | PascalCase | `BuiltInModelDef`, `TokenRhythmModelItem` |
| 类型 | PascalCase | `OpenAIChatRole`, `ParsedModelId` |
| 函数 | camelCase | `getBuiltInModelConfig`, `countMessageTokens` |
| 变量 | camelCase | `requestTimeoutMs`, `apiKey` |
| 常量 | UPPER_SNAKE_CASE | `BASE_TOKENS_PER_MESSAGE`, `DEFAULT_CONTEXT_LENGTH` |
| 私有属性 | `_` 前缀 | `_lastRequestTime`, `_toolCallBuffers` |
| 文件 | camelCase | `provider.ts`, `commitMessageGenerator.ts` |

### 6.7 VS Code API 使用约束

- `LanguageModelChatProvider` — 必须实现 `provideLanguageModelChatResponse()` 和 `provideLanguageModelChatInformation()`；可选实现 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+）用于模型列表动态刷新（本项目在 `apiMode` 设置变化时触发）
- `LanguageModelResponsePart` — 使用 `LanguageModelTextPart`、`LanguageModelThinkingPart`、`LanguageModelToolCallPart`、`LanguageModelDataPart`
- `LanguageModelChatInformation.maxOutputTokens` — 必须填入模型真实输出上限，不能为 0；VS Code 原生 Token/Context Usage 指示器会在 `maxOutputTokens <= 0` 时隐藏
- `SecretStorage` — 用于安全存储 API Key
- `LogOutputChannel` — 用于结构化日志输出
- `Progress<LanguageModelResponsePart>` — 用于流式报告响应块

### 6.8 不依赖 VS Code Proposed API

- 本扩展不使用任何 `enabledApiProposals`，所有使用的 VS Code API 均为稳定版本（VS Code 1.116+）
- `LanguageModelChatProvider`、`LanguageModelDataPart`、`LanguageModelThinkingPart` 等类型均为 VS Code 稳定 API
- `languageModelDataPart.d.ts`、`chatProvider.d.ts`、`languageModelThinkingPart.d.ts` 等类型声明文件仅用于编译期类型补全，不影响运行时行为

### 6.9 错误处理策略

- 网络请求使用 `executeWithRetry()`（默认 3 次重试，指数退避）
- API 认证失败 → 弹出输入框提示用户输入
- 请求超时 → 友好的本地化错误消息
- 流式解析错误 → 记录日志，继续处理（不中断流）
- 所有未捕获错误由 `provider.ts` 的 `catch` 块统一处理

### 6.10 日志规范

所有日志使用 `logger` 单例，标签格式为 `category.subcategory`：
- `request.start/end` — 请求开始/结束
- `request.error/timeout/delay` — 请求错误/超时/延迟
- `models.loaded` — 模型加载
- `commit.start/end/error` — 提交消息生成
- `openai.stream.*` / `anthropic.stream.*` — 流式处理
- `apiKey.missing` — API Key 缺失
