# 更新日志（Changelog）

## v1.8.1 (2026-08-14)

### API Key 管理余额显示崩溃修复

- **修复「管理 API Keys」界面打开即报错**：绑定 `tr_session` cookie 的 key 在余额展示时抛 `TypeError: balance.toFixed is not a function`，导致管理界面无法使用。根因：TokenRhythm 用户中心 API 的 `availableBalanceCny` 金额字段由 `number` 变更为**字符串**返回（金额类字段用字符串可避免 JSON 浮点精度问题），而旧代码从上线起假设该字段为 `number`（`?? 0` 兜底只挡 `null`/`undefined`，挡不住字符串），API 返回类型变更后 `toFixed()` 直接崩溃。
- **余额解析防御性加固**：`queryAccountBalance` 返回前对 `availableBalanceCny` 强制 `Number()` 转换，非法值兜底 `0`；管理界面两处余额展示（主列表与检测二级界面）增加 `typeof balance === "number"` 类型守卫，异常类型回退显示"余额未知"而非崩溃。
- **CLI 工具同步加固**：`scripts/cookieApi/cli.ts` 的 `formatMoney` 参数类型放宽为 `number | string`（CLI 查余额走同一条 API，同样会命中字符串金额），统一转 `number` 后格式化，非法值兜底 `"0"`。
- **测试与开发环境隔离（设计说明）**：扩展运行时余额查询（`src/balanceCheck.ts`，依赖 `vscode`）与 CLI 调试工具余额查询（`scripts/cookieApi/`，纯 Node 独立编译单元）保持**两套独立实现**——运行时出问题时可用 CLI 单独复现、对比排查（本次即通过 CLI 确认了 API 字段类型变化），互不耦合。

## v1.8.0 (2026-08-13)

### 跨轮视觉历史持久化

- **模型跨轮记住看过的图片**：此前 `ask_image` 图片代理的历史只在单次请求内有效，用户发完图片对话一轮后再发新消息，模型会忘记之前看过的图片，可能重复调用 `ask_image` 或答非所问。v1.8.0 起，每轮视觉代理完成后会向响应流输出一个私有 MIME（`application/vnd.opencodego.vision-tool-history+json`）的数据部分，VS Code 自动把它带入下一轮对话；下次请求时 OpenAI / Anthropic 两个消息转换器识别该数据并重建标准的 tool call + tool result 消息，模型跨轮记住图片内容。
- **DeepSeek 兼容**：重建的 assistant tool_call 消息保留 `reasoning_content`（取自本轮视觉代理捕获的推理内容），满足 DeepSeek thinking 模式对每个 assistant 消息必须回传该字段的要求。

### Anthropic 连续工具结果合并

- **修复 400 "tool_use ids were found without tool_result blocks immediately after"**：Anthropic 协议要求一条 assistant `tool_use` 消息对应的全部 `tool_result` 必须放在紧随的同一条 user 消息中，但 VS Code 可能把每个工具结果作为独立消息传入。v1.8.0 起消息转换器会把连续的工具结果缓冲并合并为单条 user 消息输出（多轮对话并行工具调用场景），单个工具结果行为不变，文本+工具结果混合消息不合并。

### 新增测试脚本

- **跨轮视觉历史编解码 + 双 API 转换器闭环测试**（`scripts/test-vision-history.mjs`）：验证序列化/反序列化、OpenAI/Anthropic 消息重建顺序、DeepSeek 空 `reasoning_content` 回归用例。
- **Anthropic 工具结果合并测试**（`scripts/test-anthropic-tool-result-merge.mjs`）：验证 3 个并行 tool_use 结果合并、单结果不合并、混合消息不缓冲。
- 两个测试均源自上游 opencode-go-copilot v1.9.2，运行前需 `npm run compile`。

## v1.7.0 (2026-08-11)

### 模型同步不再写工作区文件

- **同步结果改为输出通道一行日志**：启动模型同步不再写入工作区 `.copilot/model-sync-log.md`（该文件会被 git 追踪并污染用户仓库，见 issue #1），改为以一行日志输出到「TokenRhythm」输出通道（`models.sync` 标签，含状态/说明）。已存在的 `model-sync-log.md` 可手动删除，后续不会再生。

### DeepSeek thinking 模式多轮对话 400 修复

- **reasoning_content 必须回传**：修复 OpenAI 兼容模式下 DeepSeek 等 thinking 模型多轮对话报 400（`The reasoning_content in the thinking mode must be passed back to the API`）。根因：VS Code 回传历史消息时**不包含** `LanguageModelThinkingPart`，导致转换后的 assistant 历史消息缺失 `reasoning_content` 字段；DeepSeek 要求 thinking 模式下每个 assistant 消息必须携带该字段（即使空字符串）。修复：`includeReasoningInRequest=true` 时始终设置 `reasoning_content`（有真实推理内容用内容，否则空字符串兜底），与代码注释中"even if empty string, DeepSeek requires round-tripping"的设计意图一致。

### API Key 管理界面余额显示

- **主界面与检测二级界面均显示余额**：「管理 API Keys」列表与「检测可用性」二级界面为每个绑定了 `tr_session` cookie 的 key 显示实时余额——余额高于阈值显示 `$(coin) ¥X.XX`，余额 ≤ `minBalanceCny`（默认 0，即余额 ≤ 0）显示 `$(error) ¥X.XX`（这类 key 在轮询模式下会被主动跳过），查询失败显示"余额未知"，未绑定 cookie 不显示余额。余额经 TTL 缓存查询，不会频繁请求接口。
- **余额不足提示使用实际阈值**：检测可用性时"余额不足"提示改用 `getMinBalanceCny()` 显示用户实际配置的阈值（原先硬编码为 0）。

### 轮询余额预检增强

- **预检返回余额值并记录日志**：`balanceCheck.ts` 新增 `checkKeyBalance(cookie)` 返回 `{ sufficient, balance? }`，聊天请求与 Git 提交生成两处轮换循环的余额预检均改用它，并在 `key.rotation` / `commit.key.rotation` 日志中记录具体余额值，便于排查 key 被跳过的原因。
- **轮询跳过余额 ≤ 0 的 key**：默认 `minBalanceCny=0` 时，绑定了 cookie 且余额 ≤ 0（含 0 与负数）的 key 在轮询时会被主动预检跳过，避免发请求后收到 402 才被动切换。

## v1.6.2 (2026-08-09)

### 视觉代理模型设置增强

- **设置页下拉选择**：`tokenrhythm.visionProxyModel` 设置项改为静态下拉（6 个已知视觉模型：`kimi-k2.5` / `kimi-k2.6` / `kimi-k2.7-code` / `qwen3.8-max` / `seed-2.1-turbo` / `seed-2.1-pro`，各带能力描述），无需手填模型 ID。描述注明**以命令面板动态选择为准**（新发布的视觉模型可在 `TokenRhythm: 选择视觉代理模型` 命令中实时加载）。
- **命令面板能力描述**：`TokenRhythm: 选择视觉代理模型` QuickPick 与设置页一致显示各模型能力（如 `kimi-k2.7-code` 标注"支持视觉，不支持 temperature/top_p"）。

### 温度参数防御性加固

- **top_p 保护**：补齐 5 处请求体构建点（OpenAI / Anthropic / Responses 的 `prepareRequestBody` + provider 视觉代理多轮 ×2）的 `supportsTemperature` 检查——`supportsTemperature=false` 的模型（如 `kimi-k2.7-code`）不再可能发送 `top_p`，与 `temperature` 行为一致，杜绝参数泄露导致的 400。已实测三协议端口 + 编译产物静态验证（5/5 全保护）。

## v1.6.1 (2026-08-09)

### 视觉代理模型动态选择

- **`TokenRhythm: 选择视觉代理模型` 命令**：新增命令面板命令，从 `/v1/models` 动态加载 `supports_vision=true` 的视觉模型列表（实测含 `kimi-k2.5` / `kimi-k2.6` / `kimi-k2.7-code` / `qwen3.8-max` / `seed-2.1-turbo` / `seed-2.1-pro`），通过 QuickPick 下拉选择代替手填模型 ID。当前使用的模型带 ✓ 标记，列表末尾保留"自定义（手动输入）"兜底；API 不可用时自动回退为仅手填。
- **适用范围文档说明**：README 补充视觉代理边界说明——`ask_image` 代理作用于用户手动粘贴的图片，不覆盖 VS Code 内置截图工具（后者由 Copilot Chat 框架内部视觉模型处理，第三方无法接管）。

## v1.6.0 (2026-08-09)

### 多 API Key 轮询与余额自动切换

- **多 Key 支持**：支持添加多个 TokenRhythm API Key（SecretStorage 加密存储），新增「管理 API Keys」命令面板 QuickPick：添加/删除 Key、设为当前使用、绑定或清除 `tr_session` Cookie、重置失效状态、检测可用性。旧版单 Key 自动迁移为多 Key 格式。
- **两种使用模式**：`rotation`（默认，请求轮流使用各 key，自动跳过不可用的）与 `single`（仅用当前 key；不可用时可按设置直接报错，或自动切换到下一个可用 key 并右下角弹窗提示）。
- **主动余额预检**：每个 key 可绑定 `tr_session` cookie（一个 cookie 可绑定多个 key，余额按 cookie 粒度查询并缓存）。请求前自动查询余额，可用余额 ≤ `minBalanceCny`（可调，默认 0）时跳过该 key 切换到下一个；曾标记不可用的 key 在余额恢复后自动恢复可用。
- **被动检测兜底**：cookie 缺失/失效/网络失败时，根据请求错误自动判定并切换——402 余额不足 / 401 Key 无效（确定性失效，持久化标记）、429 限流 / 503 服务端繁忙（瞬态失效，冷却 10 分钟后自动恢复，可配置）。状态码与错误文本模式均可配置。
- **手动检测可用性**：管理页面可对单个 key 执行检测（查余额 + 最小真实聊天请求 `say ok`，余额不足时被 402 拦截不消耗 token），通过后标记为可用。
- **全部 key 用尽提示**：所有 key 均不可用时，报错列出每个 key 的失败原因（脱敏），并区分"瞬态失败请稍后重试"与"确定性失败请使用管理命令检测"。
- **全覆盖**：聊天请求、Git 提交消息生成、模型列表/启动同步均支持多 key 轮换；模型列表实测不受余额影响（余额 < 0 也可查询），用任意有效 key 即可。

## v1.5.0 (2026-08-06)

### API 模式模型过滤

- **按 API 模式过滤模型列表**：`tokenrhythm.apiMode` 切换时自动过滤模型选择器——`anthropic` 仅显示支持 Anthropic 协议的模型，`responses` 仅显示支持 Responses 的模型（能力标记动态探测自 `/v1/models`，不硬编码模型 ID），**无需重载窗口**即时生效。

### Anthropic 协议兼容性修复

- **temperature/top_p 冲突修复**：修复 Anthropic 端点"强制思考 + temperature/top_p"返回 400「请求参数组合无效」的问题——仅在思考强制启用时跳过温度参数，自适应/关闭思考时保留温度控制（实测 4 种组合验证）。

### 测试与质量

- **三协议回归测试**：新增 OpenAI/Anthropic/Responses 三协议完整测试脚本，覆盖生产环境 400 错误回归用例，记录平台差异（Responses 扁平化、DeepSeek tool_choice 等）。
