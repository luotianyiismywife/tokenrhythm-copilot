# TokenRhythm API 测试

三协议完整测试脚本，用于验证 TokenRhythm 平台 API 的兼容性。

## 运行

```bash
node test/api-tests.mjs <API_KEY> [openai|anthropic|responses|all]
```

- `<API_KEY>`: TokenRhythm API key（`sk_tr_...`）
- filter 可选: `openai` | `anthropic` | `responses` | `all`（默认 `all`）

## 覆盖场景

| 协议 | 编号 | 场景 |
|------|------|------|
| OpenAI | 1 | 非流式对话（含 reasoning_content / usage） |
| OpenAI | 2 | 流式对话（text + reasoning + usage chunk） |
| OpenAI | 3 | 流式工具调用（tool_calls） |
| OpenAI | 4 | 多轮工具回填（tool_calls + tool role） |
| OpenAI | 5 | thinking 参数（enabled/disabled）、GLM reasoning_effort |
| Anthropic | 6 | 非流式对话（thinking + text blocks） |
| Anthropic | 7 | 流式对话（SSE 事件序列） |
| Anthropic | 8 | 流式工具调用（tool_use） |
| Anthropic | 9 | thinking 参数（adaptive/disabled） |
| Responses | 10 | 非流式对话（output_text + usage） |
| Responses | 11 | 流式对话（三模型：qwen3.7-max / deepseek-v4-flash-0731 / qwen3.8-max） |
| Responses | 12 | 流式工具调用（function_call，扁平工具格式） |
| Responses | 13 | 工具调用文本化回填 |
| Responses | 14 | reasoning 参数（effort none/high） |
| Responses | 15 | 图片输入（qwen3.8-max） |
| 公共 | 16 | 错误处理（无效模型 / 协议不支持的模型） |

## 2026-08-03 实测结果

| 部分 | 结果 |
|------|------|
| OpenAI | ✅ 13/13 通过 |
| Anthropic | ✅ 13/13 通过 |
| Responses | ✅ 18+6 通过（修正工具格式后全通过） |

## 关键发现（平台差异，插件已适配）

1. **Responses 端点工具格式与 OpenAI 不同（现存扁平化问题）**：
   - OpenAI: `{"type":"function","function":{"name","description","parameters"}}`（嵌套）
   - Responses: `{"type":"function","name","description","parameters"}`（**扁平**）
   - 如果按 OpenAI 格式传给 Responses 端点，会报：
     `InvalidParameter: The parameters, when provided as a dict, must confirm to a valid openai-compatible JSON schema. Please check the schema definition for tool`
   - 插件 `ResponsesApi.prepareRequestBody` 已使用扁平格式 ✅
   - 本测试脚本第 12/13 项使用 `FLAT_TOOLS`（扁平格式）

2. **qwen3.8-max 图片限制**：图片尺寸必须 >= 10x10 像素（1x1 测试图被拒绝，报 `height:1 or width:1 must be larger than 10`）

3. **推理事件类型因模型而异**：
   - qwen3.7-max / qwen3.8-max: `response.reasoning_summary_text.delta`
   - deepseek-v4-flash-0731: `response.reasoning_text.delta`
   - 插件已兼容两种 ✅

4. **Anthropic 协议非全量**：qwen3.7-max、kimi-k2.7-code 不支持（supports_anthropic=false）

5. **Responses 端点其他差异**：
   - 拒绝 function_call / function_call_output 内容块 → 需文本化回填 `[tool_call]` / `[tool_result]`
   - tool_choice 仅接受 `auto` / `none`（`required`/对象形式在思考模式下被拒）
   - 多轮工具调用参数拼接通过 `function_call_arguments.delta/done` 事件
