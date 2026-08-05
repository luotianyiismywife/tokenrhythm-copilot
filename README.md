<div align="center">

# TokenRhythm Provider for Copilot

[English](#english) | [中文](#中文)

</div>

## English

> [!IMPORTANT]
> **This is not affiliated with, officially maintained by, or endorsed by TokenRhythm.**

Integrate [TokenRhythm](https://tokenrhythm.studio) models into GitHub Copilot Chat as a VS Code extension.

### Usage

1. **Set API Key**: `Ctrl+Shift+P` → `TokenRhythm: Set TokenRhythm API Key`
2. **Show Models**: Click the settings icon in the model picker → **Language Models** panel → set your desired models to Visible
3. **Select Model**: In the Copilot Chat bottom model picker, choose a "TokenRhythm" model
4. **Start chatting**

### Advanced Token Usage Indicator

Once installed, the status bar shows the current context usage and cumulative input/output token counts for TokenRhythm models. DeepSeek models and models that return cache metrics via the OpenAI-compatible format also display the **cumulative cache hit count** and **cache hit rate** in the tooltip.

The status bar only appears while you are actually using a TokenRhythm model: it stays hidden on startup and when other chat model providers are in use, and auto-hides after 60 seconds of inactivity.

You can control this indicator via the `tokenrhythm.enableThirdPartyTokenIndicator` setting (default: `true`). When disabled, only the native Copilot token indicator remains visible.

> [!NOTE]
> Whether non-DeepSeek models display cache data depends on whether the model API returns cache metrics in an OpenAI-compatible format. This does not indicate whether the model supports caching — caching support depends on TokenRhythm.

### Git Commit Messages

Click the **magic wand** button in the Source Control (SCM) panel to auto-generate a commit message.

You can configure the model, language, number of recent commits to reference, and whether to attach context files.

### Model Temperature Presets

Quickly switch temperature presets via `Ctrl+Shift+P` → `TokenRhythm: Set Model Temperature Preset`.

Built-in presets:

| Preset | Temperature |
|--------|-------------|
| Precise | 0.0 |
| Balanced | 1.0 |
| Creative | 1.2 |
| Extra Creative | 1.7 |

You can also configure `tokenrhythm.temperature` and `tokenrhythm.top_p` directly in `settings.json` (requires `tokenrhythm.modelPreset` set to `"custom"`).

### Extended Vision Understanding

This extension adds **extended vision understanding** capability to **text-only models** that do not natively support vision. When you send a message with an image to these models, they can call a vision-capable model to describe the image, and then answer based on that description.

You can configure the default vision model and whether to enable thinking when describing images. By default, Kimi K2.6 is used to describe images.

### Model List

The extension ships with built-in definitions for the following TokenRhythm chat models (sourced from the [model page](https://tokenrhythm.studio/models)):

| Model ID | Context | Max Output | Vision | Responses API |
|----------|---------|-----------|--------|--------------|
| `deepseek-v4-pro` | 1M | 384K | ❌ | ❌ |
| `deepseek-v4-flash` | 1M | 384K | ❌ | ❌ |
| `deepseek-v4-flash-0731` | 1M | 384K | ❌ | ✅ |
| `glm-5.2` | 1M | 128K | ❌ | ❌ |
| `glm-5.1` | 200K | 128K | ❌ | ❌ |
| `glm-5` | 1M | 128K | ❌ | ❌ |
| `kimi-k2.7-code`¹ | 256K | 128K | ✅ | ❌ |
| `kimi-k2.6` | 256K | 128K | ✅ | ❌ |
| `kimi-k2.5` | 256K | 64K | ✅ | ❌ |
| `mimo-v2.5-pro` | 256K | 256K | ❌ | ❌ |
| `minimax-m2.7` | 200K | 192K | ❌ | ❌ |
| `minimax-m2.5` | 200K | 200K | ❌ | ❌ |
| `qwen3.7-max`² | 1M | 131.1K | ❌ | ✅ |
| `qwen3.8-max`³ | 1M | 131.1K | ✅ | ✅ |

> All models support the OpenAI-compatible protocol. The **Responses API** column shows which models additionally support the Responses protocol (supports_responses=true); most models also support Anthropic (supports_anthropic=true). Protocol capability is **detected dynamically** at startup from `GET /v1/models` — no model IDs are hardcoded. In `auto` mode, priority: Responses (if `enableResponsesApi` enabled) > Anthropic (if `enableAnthropicApi` enabled) > OpenAI.
> ¹ `kimi-k2.7-code` does not support temperature/top_p parameters.
> ² `qwen3.7-max` does not support the Anthropic protocol (supports_anthropic=false).
> ³ `qwen3.8-max` (in testing) supports text + image input and the Responses protocol natively.

> [!TIP]
> Automatic model discovery is enabled by default: the extension fetches the live model list from `GET /v1/models` and hides models that are not available on your account. Image-generation models (`qwen-image-2.0`, `wan2.7-image`) are excluded from the picker.

### Configuration

Available in `settings.json`:

```json
{
  "tokenrhythm.apiMode": "auto",
  "tokenrhythm.commitLanguage": "auto",
  "tokenrhythm.commitModel": "deepseek-v4-flash",
  "tokenrhythm.commitMessagePrompt": "",
  "tokenrhythm.requestTimeout": 600000,
  "tokenrhythm.recentCommitsCount": 10,
  "tokenrhythm.commitIncludeCommitDiff": false,
  "tokenrhythm.commitAttachContextFiles": true,
  "tokenrhythm.enableAutoModelDiscovery": true,
  "tokenrhythm.syncModelsOnStartup": true,
  "tokenrhythm.maxInputTokensRatio": 1.0,
  "tokenrhythm.enableThirdPartyTokenIndicator": true,
  "tokenrhythm.enableResponsesApi": false,
  "tokenrhythm.enableAnthropicApi": false
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `tokenrhythm.commitLanguage` | `auto` | Language for Git commit messages. When set to `auto`, the language is detected from recent commit history (defaults to English if no history exists). |
| `tokenrhythm.commitModel` | `deepseek-v4-flash` | Model ID used for commit message generation. |
| `tokenrhythm.commitMessagePrompt` | `""` | Custom system prompt for commit message generation. |
| `tokenrhythm.requestTimeout` | `600000` | Maximum time (ms) for a single API request. Default is 600000 (10 minutes). Increase if long responses time out. |
| `tokenrhythm.recentCommitsCount` | `10` | Number of recent commits to analyze for style reference when generating commit messages. Set to 0 to disable. |
| `tokenrhythm.commitIncludeCommitDiff` | `false` | Include the actual code changes (diff) of recent commits in the style reference, helping the model generate messages that better match the project's commit style. |
| `tokenrhythm.commitAttachContextFiles` | `true` | Attach the content of AGENTS.md and README.md from the repository root as additional context for commit message generation, helping the model better understand the project. |
| `tokenrhythm.visionProxyModel` | `kimi-k2.6` | Vision model used by the `ask_image` tool when the selected model does not support vision. |
| `tokenrhythm.visionProxyThinking` | `false` | Enable thinking/reasoning in the vision proxy model when answering image queries. |
| `tokenrhythm.enableAutoModelDiscovery` | `true` | Automatically fetch the live model list from `GET /v1/models` and hide models unavailable on your account. |
| `tokenrhythm.syncModelsOnStartup` | `true` | Check for new TokenRhythm models on startup, at most once per day. Every sync event is recorded in the workspace `.copilot/model-sync-log.md` (falls back to the extension's global storage when no workspace folder is open). |
| `tokenrhythm.maxInputTokensRatio` | `1.0` | Ratio of the real context window declared as `maxInputTokens` (0.1 - 1.0). VS Code's agent auto-compaction triggers at ~90% of the declared value. **Recommended: 0.8** so compaction fires at ~72% of the real window, preventing context overflow on large-window BYOK models. The `context_length` sent in API requests always uses the real value. |
| `tokenrhythm.enableThirdPartyTokenIndicator` | `true` | Show the advanced token counter in the status bar while using TokenRhythm models. |
| `tokenrhythm.enableResponsesApi` | `false` | Use the Responses API protocol in `auto` mode for models detected as supports_responses=true at startup (from `GET /v1/models` — dynamic, no hardcoded model IDs). **Disabled by default**: the TokenRhythm Responses endpoint is still evolving (inconsistent stream event types across models, unstable tool calling, non-standard multi-round tool backfill), so models fall back to the more mature OpenAI-compatible format. Enable only to try the Responses protocol. |
| `tokenrhythm.enableAnthropicApi` | `false` | Use the Anthropic Messages protocol in `auto` mode for models detected as supports_anthropic=true at startup (dynamic, no hardcoded model IDs). **Disabled by default**. In auto mode, priority: Responses (if enabled) > Anthropic > OpenAI. |
| `tokenrhythm.apiMode` | `auto` | API protocol for requests: `auto` (follow each model's default; models with supports_responses=true use the Responses API automatically), `openai` (force OpenAI format), `anthropic` (force Anthropic format), or `responses` (force Responses API). Applies to both chat and Git commit generation. |

> [!NOTE]
> Models with switchable thinking (e.g., DeepSeek, Qwen) provide reasoning effort levels such as `Disabled`/`High`/`Maximum`.

### Build

```bash
npm install
npm run compile
npm run build      # packages extension.vsix
```

### License

AGPL-3.0 License. This project builds upon the architecture of [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

---

## 中文

> [!IMPORTANT]
> **本插件与 TokenRhythm 无关，也未获得其官方维护或认可。**

将 [TokenRhythm](https://tokenrhythm.studio) 模型集成到 GitHub Copilot Chat 的 VS Code 插件。

### 使用

1. **设置 API Key**：`Ctrl+Shift+P` → `TokenRhythm: Set TokenRhythm API Key`
2. **显示模型**：在模型选择器中点击设置图标 → **语言模型** 面板 → 将需要使用的模型显示
3. **选择模型**：在 Copilot Chat 底部模型选择器中选择 "TokenRhythm" 下的模型
4. **开始对话**

### 高级 Token 用量指示器

安装后，使用 TokenRhythm 提供的模型时，状态栏会显示当前上下文用量与累计输入/输出 Token 量。DeepSeek 和通过 OpenAI 格式返回缓存用量的模型还会显示**累计缓存命中量**与**缓存命中率**。

状态栏**仅在您实际使用 TokenRhythm 模型时显示**：启动时隐藏、使用其他模型提供商的模型时不显示，停止使用（空闲 60 秒）后自动隐藏。

可通过 `tokenrhythm.enableThirdPartyTokenIndicator` 设置（默认 `true`）控制此高级 Token 指示器。关闭后仅显示 Copilot 原生 Token 指示器。

> [!NOTE]
> 非 DeepSeek 的模型是否显示缓存数据取决于模型接口是否通过 OpenAI 格式返回缓存数据，这并不代表此模型是否支持缓存。模型对于缓存的支持情况取决于 TokenRhythm。

### Git 提交消息

在源代码管理（SCM）面板中点击魔法棒按钮，自动生成 Git 提交消息。

可在配置里配置使用的模型、语言、参考的最近提交数量以及是否附加上下文文件。

### 扩展视觉理解

本插件为**不支持视觉理解**的**纯文本模型**添加了**扩展视觉理解**功能，当你向这些模型发送带有图片的信息时，他们可以调用支持视觉理解的模型为图片输出描述，然后再回答。

通过配置文件可更改默认使用的模型以及是否在描述图片时启用思考。默认情况下，将使用 Kimi K2.6 描述图片。

### 模型列表

扩展内置了以下 TokenRhythm Chat 模型定义（来源：[模型页](https://tokenrhythm.studio/models)）：

| 模型 ID | 上下文 | 最大输出 | 视觉 | Responses API |
|---------|--------|---------|------|--------------|
| `deepseek-v4-pro` | 1M | 384K | ❌ | ❌ |
| `deepseek-v4-flash` | 1M | 384K | ❌ | ❌ |
| `deepseek-v4-flash-0731` | 1M | 384K | ❌ | ✅ |
| `glm-5.2` | 1M | 128K | ❌ | ❌ |
| `glm-5.1` | 200K | 128K | ❌ | ❌ |
| `glm-5` | 1M | 128K | ❌ | ❌ |
| `kimi-k2.7-code`¹ | 256K | 128K | ✅ | ❌ |
| `kimi-k2.6` | 256K | 128K | ✅ | ❌ |
| `kimi-k2.5` | 256K | 64K | ✅ | ❌ |
| `mimo-v2.5-pro` | 256K | 256K | ❌ | ❌ |
| `minimax-m2.7` | 200K | 192K | ❌ | ❌ |
| `minimax-m2.5` | 200K | 200K | ❌ | ❌ |
| `qwen3.7-max`² | 1M | 131.1K | ❌ | ✅ |
| `qwen3.8-max`³ | 1M | 131.1K | ✅ | ✅ |

> 所有模型均支持 OpenAI 兼容协议。**Responses API** 列标注哪些模型额外支持 Responses 协议（supports_responses=true）；大多数模型也支持 Anthropic（supports_anthropic=true）。协议能力在启动时从 `GET /v1/models` **动态探测**——不硬编码模型 ID。auto 模式下优先级：Responses（若开启 `enableResponsesApi`）> Anthropic（若开启 `enableAnthropicApi`）> OpenAI。
> ¹ `kimi-k2.7-code` 不支持设置 Temperature/Top-p 参数。
> ² `qwen3.7-max` 不支持 Anthropic 协议（supports_anthropic=false）。
> ³ `qwen3.8-max`（测试中）支持文本与图像输入，原生支持 Responses 协议。

> [!TIP]
> 自动模型发现默认开启：扩展会从 `GET /v1/models` 拉取实时模型列表，隐藏你账号下不可用的模型。图片生成模型（`qwen-image-2.0`、`wan2.7-image`）不会出现在选择器中。

### 调整模型温度

通过 `Ctrl+Shift+P` → `TokenRhythm: Set Model Temperature Preset` 快速切换温度预设。

内置 4 个预设档位：

| 档位 | 温度 |
|------|------|
| 精确 | 0.0 |
| 均衡 | 1.0 |
| 创意 | 1.2 |
| 极具创意 | 1.7 |

也可在 `settings.json` 中直接配置 `tokenrhythm.temperature` 和 `tokenrhythm.top_p`（需将 `tokenrhythm.modelPreset` 设为 `"custom"`）。

### 配置

可在 `settings.json` 中配置：

```json
{
  "tokenrhythm.apiMode": "auto",
  "tokenrhythm.commitLanguage": "auto",
  "tokenrhythm.commitModel": "deepseek-v4-flash",
  "tokenrhythm.commitMessagePrompt": "",
  "tokenrhythm.requestTimeout": 600000,
  "tokenrhythm.recentCommitsCount": 10,
  "tokenrhythm.commitIncludeCommitDiff": false,
  "tokenrhythm.commitAttachContextFiles": true,
  "tokenrhythm.enableAutoModelDiscovery": true,
  "tokenrhythm.syncModelsOnStartup": true,
  "tokenrhythm.maxInputTokensRatio": 1.0,
  "tokenrhythm.enableThirdPartyTokenIndicator": true,
  "tokenrhythm.enableResponsesApi": false,
  "tokenrhythm.enableAnthropicApi": false
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `tokenrhythm.commitLanguage` | `auto` | 提交消息语言。设为 `auto` 时将根据历史提交自动检测语言（无历史时默认英语）。 |
| `tokenrhythm.commitModel` | `deepseek-v4-flash` | 用于生成提交消息的模型。 |
| `tokenrhythm.commitMessagePrompt` | `""` | 生成提交消息的自定义系统提示词。 |
| `tokenrhythm.requestTimeout` | `600000` | 单个 API 请求的最大等待时间（毫秒）。默认 600000（10 分钟）。生成长内容超时时可增大此值。 |
| `tokenrhythm.recentCommitsCount` | `10` | 生成提交消息时参考的近期提交数量，用于学习仓库提交风格。设为 0 可禁用。 |
| `tokenrhythm.commitIncludeCommitDiff` | `false` | 在风格参考中包含历史提交的实际代码变更（diff），帮助模型生成更符合项目提交风格的消息。 |
| `tokenrhythm.commitAttachContextFiles` | `true` | 将仓库根目录的 AGENTS.md 和 README.md 作为额外上下文附加到提交消息生成中，帮助模型更好地理解项目。 |
| `tokenrhythm.visionProxyModel` | `kimi-k2.6` | 用于 ask_image 工具的视觉模型 ID。当所选模型不支持视觉时，该模型用于回答图片相关问题。 |
| `tokenrhythm.visionProxyThinking` | `false` | 在视觉代理模型回答图片查询时启用思考/推理功能。 |
| `tokenrhythm.enableAutoModelDiscovery` | `true` | 自动从 `GET /v1/models` 拉取实时模型列表，隐藏你账号下不可用的模型。 |
| `tokenrhythm.syncModelsOnStartup` | `true` | 启动时自动检查是否有新的 TokenRhythm 模型（每日最多一次）。每次同步事件记录在工作区的 `.copilot/model-sync-log.md` 文件中（无工作区时回退到扩展的全局存储目录）。 |
| `tokenrhythm.maxInputTokensRatio` | `1.0` | 每个模型声明为 `maxInputTokens` 的真实上下文窗口比例（0.1 - 1.0）。VS Code 的 agent 自动压缩约在声明的 maxInputTokens 的 90% 处触发。**建议设为 0.8** —— 可使压缩在真实窗口约 72% 处触发，防止 BYOK 大窗口模型上下文溢出。API 请求体中的 context_length 始终使用真实值。 |
| `tokenrhythm.enableThirdPartyTokenIndicator` | `true` | 使用 TokenRhythm 模型时在状态栏显示高级 Token 计数器。 |
| `tokenrhythm.enableResponsesApi` | `false` | 当 `apiMode` 为 `auto` 时，为启动时探测到 supports_responses=true 的模型（来自 `GET /v1/models`——动态探测，不硬编码模型 ID）使用 Responses 协议。**默认关闭**：TokenRhythm 的 Responses 端点仍在演进中（不同模型流式事件类型不一致、工具调用不稳定、多轮工具回填非常规），默认回退到更成熟的 OpenAI 兼容格式。仅在希望尝试 Responses 协议时开启。 |
| `tokenrhythm.enableAnthropicApi` | `false` | 当 `apiMode` 为 `auto` 时，为启动时探测到 supports_anthropic=true 的模型（动态探测，不硬编码模型 ID）使用 Anthropic Messages 协议。**默认关闭**。auto 模式下优先级：Responses（若开启）> Anthropic > OpenAI。 |
| `tokenrhythm.apiMode` | `auto` | 请求使用的 API 协议：`auto`（跟随各模型默认格式；supports_responses=true 的模型自动使用 Responses API）、`openai`（强制 OpenAI 格式）、`anthropic`（强制 Anthropic 格式）、`responses`（强制 Responses API 格式）。对聊天请求和 Git 提交消息生成均生效。 |

> [!NOTE]
> 支持切换思考模式的模型（如 DeepSeek、Qwen）提供`禁用思考`/`高`/`极高`等推理强度选项。

### 编译

```bash
npm install
npm run compile
npm run build      # 打包为 extension.vsix
```

### 许可

AGPL-3.0 许可。本项目基于 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）的架构实现。
