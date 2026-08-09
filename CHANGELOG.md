# 更新日志（Changelog）

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
