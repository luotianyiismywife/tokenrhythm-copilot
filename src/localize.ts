import * as vscode from "vscode";

const zhCN: Record<string, string> = {
	// statusBar
	"Token Count": "Token 计数",
	"Current model token usage": "当前模型 token 使用量",
	"Token Usage": "Token 使用量",
	"Ready": "就绪",

	// extension.ts - API key prompts
	"TokenRhythm Provider API Key": "TokenRhythm 提供商 API 密钥",
	"Update your TokenRhythm API key": "更新您的 TokenRhythm API 密钥",
	"Enter your TokenRhythm API key": "输入您的 TokenRhythm API 密钥",
	"TokenRhythm API key cleared.": "TokenRhythm API 密钥已清除。",
	"TokenRhythm API key saved.": "TokenRhythm API 密钥已保存。",

	// provider.ts
	"TokenRhythm API key not found": "未找到 TokenRhythm API 密钥",
	"Invalid base URL configuration.": "无效的 Base URL 配置。",

	// statusBar cache tooltip
	"Cache": "缓存",
	"({0} cached, {1}%)": "(已缓存 {0}, 命中率 {1}%)",
	"No changes found in any workspace repositories.": "在任何工作区仓库中均未发现更改。",
	"Git extension not found": "未找到 Git 扩展",
	"No Git repositories available": "没有可用的 Git 仓库",
	"Repository not found for provided SCM": "未找到指定 SCM 对应的仓库",
	"No models configured for commit message generation. Please set 'useForCommitGeneration' to true for at least one model in your configuration.":
		"未配置用于生成提交消息的模型。请在配置中将至少一个模型的 'useForCommitGeneration' 设为 true。",
	"{0} is no longer available as a free model. Please use a different model.": "{0} 已结束免费使用，请使用其他模型。",
"Failed to generate commit message:": "生成提交消息失败：",
	"[Commit Generation Failed]": "[提交生成失败]",
	"empty API response": "API 返回为空",

	// Timeout error
	"Request timed out. The generation took too long. You can increase the timeout in settings (tokenrhythm.requestTimeout).":
		"请求超时，生成内容过长。您可以在设置中增加超时时间（tokenrhythm.requestTimeout）。",
	"The connection was closed by the server. The generation took too long. Please try again or request shorter content.":
		"服务端连接被关闭，生成内容过长时间过长。请重试或请求较短的内容。",

	// reasoning effort labels (keys are English fallback text)
	"Disabled": "禁用思考",
	"Adaptive": "自动",
	"Thinking": "思考",
	"Low": "低",
	"Medium": "中",
	"High": "高",
	"Maximum": "极高",

	// reasoning effort descriptions (keys are English fallback text)
	"Do not enable thinking": "不启用思考",
	"Automatically decide when to think": "自动决定何时思考",
	"Enable thinking": "启用思考",
	"Reduce thinking, faster response": "减少思考，响应更快",
	"Balance thinking and speed": "平衡思考与速度",
	"Deeper thinking, slower response": "更深入的思考，但速度较慢",
	"Maximum thinking depth, slowest response": "最大思考深度，速度最慢",

	// reasoning effort title (key is English fallback text)
	"Reasoning Effort": "推理强度",

	// vision proxy
	"Querying vision model: \"{0}\"": "正在根据图片提问：{0}",
	"The image you sent was flagged as sensitive by the content moderation system. Please try a different image.": "您发送的图片被内容审核系统判定为敏感，请尝试更换图片。",

	// extension.ts - model preset (setModelPreset command)
	"Custom (manual input)": "自定义 (手动输入)",
	" (current)": " (当前)",
	"(current, temperature: {0}, top_p: {1})": "(当前, 温度: {0}, top_p: {1})",
	"Set Model Preset": "设置模型预设",
	"Select a preset": "选择一个档位",
	"Enter custom temperature": "输入自定义温度",
	"Enter a single number for temperature only (<=2), or two comma-separated numbers for temperature and top_p (temp<=2, top_p<=1), e.g.: 0.7 or 0.7,0.95": "输入一个数字只设温度 (<=2), 输入两个数字用英文逗号分隔同时设温度和 top_p (温度<=2, top_p<=1), 如: 0.7 或 0.7,0.95",
	"Please enter at least temperature value": "请至少输入一个温度值",
	"Please enter at most two numbers separated by a comma": "最多输入两个数值, 用英文逗号分隔",
	"Temperature must be between 0.0 and 2.0": "温度必须在 0.0 到 2.0 之间",
	"top_p must be between 0.0 and 1.0": "top_p 必须在 0.0 到 1.0 之间",
	"Precise": "精确",
	"Balanced": "均衡",
	"Creative": "创意",
	"Extra Creative": "极具创意",
	"Set to temperature: {0} ({1})": "已设为温度 {0} ({1})",
	"Set to temperature: {0} (custom)": "已设为温度 {0} (自定义)",
	"Set to temp: {0}, top_p: {1} (custom)": "已设为温度 {0}, top_p {1} (自定义)",

	// keyManager.ts - API Key management
	"Available": "可用",
	"Unavailable": "不可用",
	"Not checked": "未检测",
	"Cooldown ({0}s)": "冷却中 ({0} 秒)",
	"Cooldown": "冷却中",
	"Back": "返回",
	"Select a key to check, or check all": "选择要检测的 Key，或检测全部",
	"Current": "当前使用",
	"Pinned": "当前固定",
	"Cookie bound": "Cookie 已绑定",
	"Cookie not bound": "未绑定 Cookie",
	"Balance unknown": "余额未知",
	"Recharge": "充值",
	"Gift": "赠送",
	" (until {0})": "（至 {0}）",
	"Add API Key": "添加 API Key",
	"Import API Keys (batch)": "批量导入 API Keys",
	"No entries yet — click below to add a triple": "暂无条目 — 点击下方添加三元组",
	"Add a triple (key/cookie/label)": "添加三元组（key/cookie/备注）",
	"Finish import": "完成导入",
	"Remove entry": "删除条目",
	"Cancel import": "取消导入",
	"Add triples, then finish import": "添加三元组后完成导入",
	"Enter the API key": "输入 API Key",
	"Enter the tr_session cookie (optional)": "输入 tr_session cookie（可选）",
	"Enter an optional label (optional)": "输入可选备注（可选）",
	"Imported {0} API keys ({1} cookies updated)": "已导入 {0} 个 API Key（更新 {1} 个 cookie）",
	"No changes (keys already exist with same cookies)": "无变更（key 已存在且 cookie 相同）",
	"Delete API Key": "删除 API Key",
	"Edit API Key": "编辑 API Key",
	"Edit the API key value (leave unchanged to keep)": "编辑 API Key 值（保持不变则不修改）",
	"Edit the tr_session cookie (empty to clear)": "编辑 tr_session cookie（留空清除）",
	"Edit the label (empty to clear)": "编辑备注（留空清除）",
	"API key updated": "API Key 已更新",
	"API key value conflicts with another existing key": "API Key 值与另一个已存在的 key 冲突",
	"Failed to update API key": "更新 API Key 失败",
	"Set as Current": "设为当前使用",
	"Reset Exhausted States": "重置失效状态",
	"Check Availability": "检测可用性",
	"Check All Availability": "全部检测可用性",
	"Checking availability of all keys...": "正在检测全部 Key 的可用性...",
	"Checking {0}/{1}: {2}": "正在检测 {0}/{1}：{2}",
	"Availability check done: {0} available, {1} unavailable, {2} unknown": "检测完成：{0} 可用，{1} 不可用，{2} 无法确定",
	"Bind/Update Cookie": "绑定/更新 Cookie",
	"Clear Cookie": "清除 Cookie",
	"Enter an optional label for this key": "为该 key 输入可选备注（可留空）",
	"Enter the tr_session cookie for this key (optional)": "输入该 key 的 tr_session cookie（可选，可多个 key 共享同一 cookie）",
	"API key already exists": "该 API Key 已存在",
	"API key added": "API Key 已添加",
	"Select an API key to manage": "选择要管理的 API Key",
	"Confirm delete API key {0}?": "确认删除 API Key {0}？",
	"API key deleted": "API Key 已删除",
	"Set as current API key": "已设为当前 API Key",
	"Set as Current is only valid in single mode (apiKeyMode=single)": "「设为当前使用」仅在 single 模式下有效（apiKeyMode=single）",
	"Reset exhausted key states": "已重置失效状态",
	"Enter the tr_session cookie": "输入 tr_session cookie",
	"Enter the tr_session cookie value for this key": "输入该 key 对应的 tr_session cookie 值（留空清除）",
	"Cookie updated": "Cookie 已更新",
	"Cookie cleared": "Cookie 已清除",
	"Select Vision Proxy Model": "选择视觉代理模型",
	"Enter the vision model ID": "输入视觉模型 ID",
	"Vision proxy model set to {0}": "视觉代理模型已设置为 {0}",
	"Kimi K2.5 — vision-capable": "Kimi K2.5 — 支持视觉",
	"Kimi K2.6 — vision-capable (default)": "Kimi K2.6 — 支持视觉（默认）",
	"Kimi K2.7 Code — vision-capable, no temperature/top_p": "Kimi K2.7 Code — 支持视觉，不支持 temperature/top_p",
	"Qwen3.8 Max — text + image input, 1M context": "Qwen3.8 Max — 支持文本与图像输入，1M 上下文",
	"Seed 2.1 Turbo — vision-capable": "Seed 2.1 Turbo — 支持视觉",
	"Seed 2.1 Pro — vision-capable": "Seed 2.1 Pro — 支持视觉",
	"Checking availability...": "正在检测可用性...",
	"Key is available": "检测通过：Key 可用",
	"Key balance is insufficient (≤ {0} CNY)": "余额不足（≤ {0} 元），Key 标记为不可用",
	"Key is invalid (401)": "Key 无效（401），标记为不可用",
	"Cookie invalid, please re-bind": "Cookie 已失效，请重新绑定（仍执行了请求校验）",
	"Unable to determine availability, please retry later": "无法确定可用性，请稍后重试",
	"All API keys are unavailable": "所有 API Key 均不可用",
	"All API keys are temporarily unavailable ({0}). Please retry later.": "所有 API Key 暂时不可用（{0}），请稍后重试。",
	"All API keys are unavailable ({0}). Use the Manage API Keys command to check availability.": "所有 API Key 均不可用（{0}）。请使用「管理 API Keys」命令检测可用性。",
	"Balance insufficient": "余额不足",
	"Key invalid": "Key 无效",
	"Rate limited (429)": "限流 (429)",
	"Server error (503)": "服务端繁忙 (503)",
	"API error": "API 错误",
	"Current API key is unavailable, switched to {0}": "当前 API Key 不可用，已切换到 {0}",
	"No API keys configured": "未配置 API Key",
	"Empty input ignored": "空输入已忽略",
};

/**
 * Get the localized string for the given key.
 * Falls back to the key itself if no translation is available.
 */
export function l10n(key: string): string {
	const language = vscode.env.language;
	if (language.toLowerCase() === "zh-cn" || language.toLowerCase().startsWith("zh")) {
		if (zhCN[key]) {
			return zhCN[key];
		}
	}
	return key;
}

/**
 * Format a localized string with replacements.
 * Usage: l10nFormat("Token Usage: {0} / {1}", "12.5K", "1M")
 */
export function l10nFormat(template: string, ...args: (string | number)[]): string {
	let str = l10n(template);
	for (let i = 0; i < args.length; i++) {
		str = str.replace(`{${i}}`, String(args[i]));
	}
	return str;
}
