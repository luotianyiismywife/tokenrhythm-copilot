# 多 API Key 轮询与余额自动切换 — 完整设计方案

> 状态：待实施 | 日期：2026-08-09 | 适用范围：聊天请求、Git 提交消息生成、模型列表、启动同步、手动检测
>
> **2026-08-09 实测确认（用户提供 cookie + 对应 key）：**
> - `GET /api/usage-summary`（cookie 认证）：余额为负时返回 `code:0` + `availableBalanceCny:-0.0447`，**可正常查询**
> - `GET /v1/models`（Bearer key 认证）：余额 -0.04 时返回 **HTTP 200**，**模型列表不受余额影响**
> - `POST /v1/chat/completions`（余额不足）：返回 **HTTP 402** + `{"code":"INSUFFICIENT_BALANCE","message":"余额不足","traceId":"..."}`，**请求被余额校验拦截，不消耗 token**
> - 结论：**被动检测错误签名 = 402 + `INSUFFICIENT_BALANCE` + "余额不足"**；**手动检测不能用 `/v1/models`（余额<0 也 200）**，改用最小真实聊天请求

---

## 1. 功能概述

支持添加多个 TokenRhythm API Key（SecretStorage 加密存储），提供两种使用模式：

| 模式 | 行为 |
|------|------|
| `rotation`（默认） | 请求轮流使用各 key（轮询），自动跳过不可用的 key |
| `single` | 仅使用用户指定的"当前 key"；不可用时按 `tokenrhythm.singleKeyFallback` 设置决定：`error`（默认，直接报错不切换）或 `switch`（自动切换到下一个可用 key，并右下角弹窗提示） |

**余额管理核心机制：**

- **主动预检（核心）**：每个 key 可绑定一个 `tr_session` cookie（**一个 cookie 可绑定多个 key**，共享余额）。请求前调用 `GET /api/usage-summary` 查询 cookie 余额，余额 ≤ `minBalanceCny`（设置可调，默认 0）时自动跳过该 key 并切换到下一个。
- **被动检测（兜底）**：cookie 缺失 / 失效 / 网络失败时，无法预检；改为在请求失败后根据 HTTP 状态码（**402 余额不足** / 401 无效 Key / 429 限流）和错误文本模式判定 key 失效并切换。**已实测 402 错误体：`{"code":"INSUFFICIENT_BALANCE","message":"余额不足"}`**。
- **手动检测（自愈）**：QuickPick 管理中提供"检测可用性"按钮，对选中 key 执行"查 cookie 余额 + **最小真实聊天请求**（`say ok`、`max_tokens=8`；余额不足时被 402 拦截不耗 token）"，通过后标记为可用（充值后无需手动改状态）。**不使用 `/v1/models` 校验**（余额 < 0 也能返回 200，无法作为可用性判据）。

---

## 2. 数据模型

### 2.1 SecretStorage 存储

```jsonc
// key: "tokenrhythm.apiKeys"
{
  "keys": [
    {
      "value": "sk_xxxx...",          // API Key（必填）
      "label": "工作号",               // 备注（可选）
      "cookie": "sess_xxxx...",        // tr_session cookie（可选，可多个 key 共享同一值）
      "available": true,               // 可用性: true=可用 / false=不可用(余额不足或失效) / null=未检测
      "lastCheckedAt": 1723190400000   // 最近一次检测时间戳（可选）
    }
  ],
  "activeIndex": 0                     // single 模式下的"当前使用" key 下标
}

// key: "tokenrhythm.apiKey"（旧版，迁移后删除）
"sk_xxxx..."  // 字符串
```

### 2.2 内存态（不持久化，重启重置）

```ts
// 轮询游标：模块级，跨请求共享，保证顺序轮换
let rotationIndex = 0;

// 瞬态失效表：429 限流等"可能恢复"的失效，带冷却时间
// Map<keyValue, { exhaustedAt: number; reason: "rate_limited" }>
const transientExhausted = new Map<string, TransientExhausted>();

// 余额查询 TTL 缓存：Map<cookie, { availableBalanceCny: number; checkedAt: number }>
const balanceCache = new Map<string, BalanceCacheEntry>();
```

### 2.3 Key 状态机

```
                    ┌────────────────────────────────────────────┐
                    │                                            ▼
 [null] 未检测 ──手动检测通过──▶ [true] 可用 ◀──请求成功(自愈)────┐
    │  ▲                          │  │                          │
    │  │                          │  │ 预检余额≤阈值 / 请求402    │
    │  │  手动检测失败             │  ▼                          │
    │  └───────────────────────▶ [false] 不可用                  │
    │                             │  原因: balance / invalid     │
    │                             │                              │
    └────── 手动检测(余额不足/401) ┘                              │
                                                                 │
    [true] 可用 ──请求429──▶ (内存) 冷却中 ──冷却到期自动恢复──▶ [true]
    [true] 可用 ──请求401──▶ [false] invalid（持久化）
    [false] 不可用 ──手动检测通过 / 预检余额恢复(自愈)──▶ [true]
    [false] 不可用 ──重置失效状态命令──▶ [null] 未检测
```

- `available=false` 是**持久化**的（SecretStorage），重启保留。
- 429 是**瞬态冷却**（内存 + 冷却时间 `apiKeyExhaustedCooldownMin`，默认 10 分钟），到期自动恢复，不写持久化。
- **自愈**：预检发现余额充足或请求成功时，自动把该 key 恢复为 `available=true`。

---

## 3. 关键函数设计

### 3.1 `src/keyManager.ts`（新建）

| 函数 | 签名 | 职责 |
|------|------|------|
| `getApiKeyStore(secrets)` | `(secrets) => Promise<ApiKeyStore>` | 读取并缓存 store；自动迁移旧 `tokenrhythm.apiKey`；JSON 损坏时回退修复 |
| `saveApiKeyStore(secrets, store)` | `(secrets, store) => Promise<void>` | 写新格式；成功后删除旧 key（幂等） |
| `getPrimaryApiKey(secrets)` | `(secrets) => Promise<ApiKeyEntry \| undefined>` | 模型列表/同步用：single→active；rotation→第一个可用的（跳过冷却与不可用） |
| `pickNextApiKey(secrets, mode)` | `(secrets, mode) => Promise<ApiKeyEntry \| undefined>` | 轮询/单 key 选择逻辑（见 3.2） |
| `markApiKeyExhausted(secrets, key, reason)` | 异步 | 持久化 `available=false` + reason；429 额外记录瞬态冷却 |
| `markApiKeyAvailable(secrets, key)` | 异步 | 置 `available=true`，清冷却（自愈/手动检测通过） |
| `resetExhaustedKeys(secrets)` | 异步 | 清空瞬态冷却；可选将所有 `available=false` 重置为 `null` |
| `updateKeyAvailability(secrets, key, available, reason?)` | 异步 | 通用状态更新 |
| `isApiKeyEligible(entry)` | 同步 | 判断是否可被选中（非冷却中、非 `available=false`） |
| `isKeyRotationError(err)` | 同步 | 匹配状态码 `[401]/[402]/[429]` 或错误文本 patterns → 判定是否应切换 |
| `maskApiKey(key)` | 同步 | `sk_****abcd` 脱敏显示 |
| `maskCookie(cookie)` | 同步 | `sess_****abcd` 脱敏显示 |
| `addApiKey(secrets, entry)` | 异步 | 添加 key（校验重复）；可选附带 label/cookie |
| `removeApiKey(secrets, index)` | 异步 | 删除；调整 activeIndex 与轮询游标 |
| `setActiveKey(secrets, index)` | 异步 | 设置 single 模式的当前 key |
| `setKeyCookie(secrets, index, cookie?)` | 异步 | 绑定/更新/清除指定 key 的 cookie |

### 3.2 `pickNextApiKey` 选择逻辑

```
pickNextApiKey(secrets, mode):
  store = await getApiKeyStore(secrets)
  if store.keys.length == 0: return undefined

  if mode == "single":
    entry = store.keys[store.activeIndex] ?? 第一个
    if isApiKeyEligible(entry): return entry
    // 不可用时由调用方（provider）决定：
    //   fallback=error  → 直接报错，不切换
    //   fallback=switch → 以 rotation 模式再次调用本函数选择下一个可用 key
    return undefined

  // rotation：从 rotationIndex 开始顺序查找第一个 eligible 的 key
  for i in 0..keys.length-1:
    idx = (rotationIndex + i) % keys.length
    entry = keys[idx]
    if isApiKeyEligible(entry):
      rotationIndex = (idx + 1) % keys.length   // 游标前移到下一个，保证下次从下一个开始
      return entry
  return undefined   // 全部不可用或冷却中
```

### 3.3 `src/balanceCheck.ts`（新建，独立实现，不依赖 scripts/cookieApi）

| 函数 | 签名 | 职责 |
|------|------|------|
| `queryAccountBalance(cookie)` | `(cookie) => Promise<number>` | `GET https://tokenrhythm.studio/api/usage-summary`，头 `Cookie: tr_session=<value>`，20s 超时；返回 `availableBalanceCny`；401 抛"cookie 失效" |
| `getBalanceCached(cookie, ttlSec)` | 异步 | **按 cookie 粒度** TTL 缓存；命中直接返回，未命中刷新 |
| `isKeyBalanceSufficient(cookie, minBalanceCny, ttlSec)` | 异步 | 余额 > minBalanceCny → true；查询失败（网络/401/code≠0）→ 记日志、返回 `true`（**不阻塞请求**，回退被动） |
| `testKeyAvailability(entry, baseUrl, minBalanceCny)` | 异步 | 手动检测：有 cookie 先查余额（≤ 阈值 → `{ok:false, reason:"balance"}`）→ **发最小真实聊天请求**（`say ok`、`max_tokens=8`）：402/INSUFFICIENT_BALANCE → `{ok:false, reason:"balance"}`，401 → `{ok:false, reason:"invalid"}`，200 → `{ok:true}`；网络/超时 → `{ok:null}` 无法确定 |

> 手动检测"请求一次"为什么用真实聊天请求而非 `/v1/models`：**实测余额 -0.04 时 `/v1/models` 仍返回 200**（模型列表不校验余额），无法区分"余额不足"与"正常可用"；而真实请求在余额不足时被 402 拦截，**不消耗 token**，语义明确。

---

## 4. 完整情况覆盖矩阵（100%）

### 4.1 聊天请求主流程（provider.ts）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| A1 | 无任何 key | 弹输入框引导添加第一个（现有 `ensureApiKey` 行为）；取消 → 报错 | ✅ |
| A2 | single 模式 activeIndex 越界（key 被删） | 回退到第一个 key；仍无 → A1 | ✅ |
| A3 | rotation 模式 key 列表为空 | 同 A1 | ✅ |
| A4 | 所有 key 均不可用（持久化 false 或冷却中） | 报"所有 API Key 均不可用"，附各 key 失败原因（脱敏） | ✅ |
| A5 | 部分 key 冷却中（429） | 跳过，选下一个 | ✅ |
| A6 | 部分 key 持久化不可用（余额/401） | 跳过，选下一个 | ✅ |
| A7 | 轮询游标越界（删除 key 后） | 取模回绕，不越界 | ✅ |
| A8 | single 模式 active 不可用，fallback=`error` | 直接报错，不切换 | ✅ |
| A9 | single 模式 active 不可用，fallback=`switch` | 降级为 rotation 选择下一个可用 key；成功后右下角通知"当前 Key 不可用（原因），已切换到 sk_****abcd" | ✅ |
| A10 | single fallback=`switch` 且所有 key 均不可用 | 按 A4 汇总报错，不弹切换通知 | ✅ |
| B1 | 预检：cookie 有效，余额 > minBalanceCny | 使用该 key | ✅ |
| B2 | 预检：cookie 有效，余额 ≤ minBalanceCny | 标记不可用（持久化），跳过换下一个 | ✅ |
| B3 | 预检：cookie 失效（401） | 记日志，**回退被动检测**，仍尝试请求 | ✅ |
| B4 | 预检：用户中心网络错误/超时 | 回退被动检测，仍尝试请求 | ✅ |
| B5 | 预检：余额查询本身被限流（429） | 回退被动检测 | ✅ |
| B6 | 预检：缓存命中（interval 内） | 直接用缓存值，不重复查询 | ✅ |
| B7 | 预检：缓存过期 | 重新查询 | ✅ |
| B8 | key 无 cookie | 跳过预检直接请求，靠被动兜底 | ✅ |
| B9 | `balanceCheckEnabled=false` | 全部跳过预检，纯被动 | ✅ |
| B10 | 预检余额充足但请求实际 402（竞态：余额刚被其他请求花光） | 被动检测捕获 402 → 切换 | ✅ |
| B11 | 曾标记不可用的 key，预检发现余额恢复 | **自愈**：标记 `available=true`，正常使用 | ✅ |
| C1 | 请求成功 | 若该 key 曾不可用 → 自愈置 true；break 轮换循环 | ✅ |
| C2 | 402 余额不足 | 匹配轮换错误 → 标记不可用(balance)，换下一个 | ✅ |
| C3 | 401 无效 Key | 匹配轮换错误 → 标记不可用(invalid)，换下一个 | ✅ |
| C4 | 429 限流 | 匹配轮换错误 → **瞬态冷却**（不持久化），换下一个 | ✅ |
| C5 | 400 参数错误 | 不轮换（配置/模型问题，换 key 无效），直接抛错 | ✅ |
| C6 | 403 权限 | 不轮换，直接抛错 | ✅ |
| C7 | 404/405 等 | 不轮换，直接抛错 | ✅ |
| C8 | 500/502/503 服务端错误 | 不轮换（平台问题），由 `executeWithRetry` 重试 | ✅ |
| C9 | 网络错误（fetch 失败） | 不轮换（同一平台，换 key 无效），由重试机制处理 | ✅ |
| C10 | 超时 | 不轮换，走现有超时友好提示 | ✅ |
| C11 | 用户取消 | 不轮换，重新抛出原始错误 | ✅ |
| C12 | IMAGE_SENSITIVE | 不轮换（内容问题），抛友好错误 | ✅ |
| C13 | 流解析中途错误 | 不轮换（流已开始），抛错 | ✅ |
| C14 | 状态码在配置列表但文本不匹配 | 按状态码匹配 → 轮换 | ✅ |
| C15 | 状态码不在列表但文本匹配 patterns | 按文本匹配 → 轮换 | ✅ |
| C16 | 所有 key 尝试后全部失败 | 报"所有 API Key 均不可用"，汇总各 key 失败原因 | ✅ |
| C17 | 轮换过程中部分 key 成功 | 正常返回，成功 key 游标前移 | ✅ |

### 4.2 视觉代理（ask_image 第二轮及后续请求）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| D1 | 视觉代理请求（第二轮） | 复用主请求选中的 key 与 headers，**不重新轮换**（主请求已成功，tool 上下文已建立） | ✅ |
| D2 | 视觉代理请求 402/401/429 | **不触发 key 切换**（主请求已成功，切换会打乱 tool 上下文）；记录日志并抛错，提示用户重试整个请求 | ✅ |
| D3 | 视觉代理请求其他错误 | 同 D2 | ✅ |

> 设计理由：轮换循环只覆盖"主请求"阶段。主请求成功后模型已产出 tool_call，消息上下文（含图片）绑定在 API 实例内，中途换 key 重试视觉代理会引入不一致。失败时直接报错，用户重试即可（重试时重新走完整轮换）。

### 4.3 Git 提交消息生成（commitMessageGenerator.ts）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| E1 | 无 key | 弹输入框添加（现有行为） | ✅ |
| E2 | rotation 模式 | 与聊天相同：预检 + 轮换循环 | ✅ |
| E3 | single 模式，fallback=`error` | 用指定 key，不可用直接报错不切换 | ✅ |
| E9 | single 模式，fallback=`switch` | 降级为 rotation 选下一个可用 key，弹窗提示（同 A9） | ✅ |
| E10 | single fallback=`switch` 且全部不可用 | 按 E7 汇总报错 | ✅ |
| E4 | 402/401 | 标记不可用，换下一个 key 重试 | ✅ |
| E5 | 429 | 冷却，换下一个 key 重试 | ✅ |
| E6 | 用户取消（abortGeneration） | 不重试，中止 | ✅ |
| E7 | 所有 key 失败 | 报错，附失败原因 | ✅ |
| E8 | 生成中途流式输出已开始（部分文本已写入 InputBox） | 换 key 重试会覆盖输入框内容——**策略：若已产生部分输出则不再换 key，直接报错**（避免用户看到半截内容被覆盖）；仅在"请求失败且尚无任何输出"时换 key 重试 | ✅ |

### 4.4 模型列表 / 启动同步（provideModel.ts / modelSync.ts）

> **实测确认**：`/v1/models` 余额 < 0 时仍返回 200，模型列表**不校验余额**。因此模型列表/同步用任意**有效** key 即可，**无需关心余额**；仅需跳过 401 无效 key。

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| F1 | 正常 | 用主 key（single→active；rotation→第一个**有效** key，余额不足不跳过） | ✅ |
| F2 | 主 key 无效（401） | 用下一个有效 key | ✅ |
| F3 | 全部无效 / 无 key | 回退内置模型列表（现有行为，静默降级） | ✅ |
| F4 | 不做轮换 | 仅一次请求，失败即回退 | ✅ |

### 4.5 手动检测可用性（QuickPick 按钮）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| G1 | 有 cookie，余额 ≤ minBalanceCny | 标记不可用（balance），提示"余额不足" | ✅ |
| G2 | 有 cookie，余额 > minBalanceCny | 继续请求校验 | ✅ |
| G3 | 无 cookie | 跳过余额检查，只做请求校验 | ✅ |
| G4 | 请求校验 401 | 标记不可用（invalid），提示"Key 已失效" | ✅ |
| G5 | 请求校验成功（最小聊天请求 200） | 标记可用，提示"检测通过" | ✅ |
| G6 | 请求校验 402 / INSUFFICIENT_BALANCE | 标记不可用（balance），提示"余额不足" | ✅ |
| G7 | 网络错误 / 超时（无法区分 key 问题或网络问题） | **保留原状态**，提示"无法确定，请稍后重试" | ✅ |
| G8 | cookie 失效（401 from usage-summary） | 提示"cookie 已失效请重新绑定"，但仍执行请求校验（无 cookie 也能校验 key） | ✅ |
| G9 | 检测中用户取消 | 不改变状态 | ✅ |
| G10 | 检测后 | 刷新 QuickPick 列表 | ✅ |

### 4.6 QuickPick 管理（manageApiKeys）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| H1 | 空列表 | 仅显示"添加 Key"动作 | ✅ |
| H2 | 添加 key | 输入 key（可附带 label、cookie）；重复值提示已存在 | ✅ |
| H3 | 删除 key | 二次确认；删除 active → 调整 activeIndex；清空 → H1 | ✅ |
| H4 | 设为当前使用 | 更新 activeIndex（single 模式生效） | ✅ |
| H5 | 绑定/更新 cookie | 选择 key → 输入 cookie | ✅ |
| H6 | 清除 cookie | 置空（下次预检跳过该 key 的余额检查） | ✅ |
| H7 | 重置失效状态 | 清瞬态冷却 + 所有 `available=false` → `null` | ✅ |
| H8 | 检测可用性 | 见 4.5 矩阵 | ✅ |
| H9 | 状态显示 | `✓ 可用` / `✗ 不可用(余额不足/Key失效)` / `? 未检测` / `★ 当前使用` / `🔑 cookie 已绑定` | ✅ |
| H10 | 重复添加同一 key 值 | 提示已存在，不添加 | ✅ |
| H11 | key 值格式 | 不强制 `sk_` 前缀，允许任意值（平台可能调整格式） | ✅ |

### 4.7 迁移与兼容（extension.ts / keyManager.ts）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| I1 | 旧 `tokenrhythm.apiKey` 存在、新格式不存在 | 迁移为单元素列表 `{keys:[{value}], activeIndex:0}` | ✅ |
| I2 | 新格式已存在 | 以新格式为准，忽略旧 key | ✅ |
| I3 | 新格式 JSON 损坏 | 回退旧 key；重写修复 | ✅ |
| I4 | 迁移后删除旧 key | 删除成功才视为完成；失败则下次读取时重试（幂等） | ✅ |
| I5 | 空字符串 key | 忽略/剔除 | ✅ |
| I6 | 旧 `setApiKey` 命令 | 保留：写入新格式单元素列表（覆盖行为），兼容旧用户习惯 | ✅ |

### 4.8 配置边界（package.json 设置）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| J1 | `apiKeyMode` 非法值 | 回退 `rotation` | ✅ |
| J10 | `singleKeyFallback` 非法值 | 回退 `error` | ✅ |
| J2 | `apiKeyRotationStatusCodes` 空数组 | 仅按文本 patterns 匹配 | ✅ |
| J3 | `apiKeyRotationErrorPatterns` 空数组 | 仅按状态码匹配 | ✅ |
| J4 | 两者都空 | 禁用被动轮换（仅主动预检） | ✅ |
| J5 | `minBalanceCny` 为负 | 夹取到 0 | ✅ |
| J6 | `apiKeyExhaustedCooldownMin = 0` | 429 冷却立即恢复（仍换 key，但可立即再用） | ✅ |
| J7 | `balanceCheckIntervalSec = 0` | 每次请求都查询余额，不缓存 | ✅ |
| J8 | `balanceCheckEnabled = false` | 跳过所有预检，纯被动 | ✅ |
| J9 | 并发聊天请求 | 轮询游标为模块级变量，JS 单线程保证原子性；SecretStorage 以内存缓存为准，变更时写回 | ✅ |

### 4.9 持久化与内存（keyManager.ts）

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| K1 | `available` 状态 | 持久化（SecretStorage），重启保留 | ✅ |
| K2 | 429 冷却状态 | 内存，重启丢失（重启后自动重新检测，可接受） | ✅ |
| K3 | 轮询游标 | 内存，重启从头开始 | ✅ |
| K4 | 余额 TTL 缓存 | 内存，重启失效重新查询 | ✅ |

### 4.10 日志与错误信息

| # | 情况 | 处理 | 覆盖 |
|---|------|------|------|
| L1 | 每次轮换切换 | 日志 `key.rotation`：脱敏 key + 原因 | ✅ |
| L2 | 所有 key 不可用 | 错误信息列出各 key 失败原因（脱敏） | ✅ |
| L3 | 预检查询失败回退 | 日志 `key.balanceCheck` 记录原因（cookie 失效/网络） | ✅ |
| L4 | 自愈恢复 | 日志 `key.recovered` | ✅ |
| L5 | 日志中任何 key/cookie 值 | 一律脱敏（`sk_****abcd` / `sess_****abcd`） | ✅ |

---

## 5. 设置项（package.json configuration）

```jsonc
"tokenrhythm.apiKeyMode": { "type": "string", "enum": ["rotation", "single"], "default": "rotation" },
"tokenrhythm.singleKeyFallback": {
  "type": "string", "enum": ["error", "switch"], "default": "error",
  "description": "single 模式下当前 key 不可用时的行为：error=直接报错不切换；switch=自动切换到下一个可用 key 并右下角弹窗提示"
},
"tokenrhythm.apiKeyRotationStatusCodes": { "type": "array", "items": { "type": "number" }, "default": [401, 402, 429] },
"tokenrhythm.apiKeyRotationErrorPatterns": {
  "type": "array", "items": { "type": "string" },
  "default": ["余额不足", "insufficient balance", "INSUFFICIENT_BALANCE", "balance", "RATE_LIMITED", "UPSTREAM_RATE_LIMITED"]
},
"tokenrhythm.apiKeyExhaustedCooldownMin": { "type": "number", "default": 10, "minimum": 0 },
"tokenrhythm.balanceCheckEnabled": { "type": "boolean", "default": true },
"tokenrhythm.minBalanceCny": { "type": "number", "default": 0, "minimum": 0 },
"tokenrhythm.balanceCheckIntervalSec": { "type": "number", "default": 60, "minimum": 0 }
```

## 6. 命令与 UI

| 命令 | 用途 |
|------|------|
| `tokenrhythm.manageApiKeys`（新增） | 打开 Key 管理 QuickPick（增删改查 + 检测可用性 + cookie 管理） |
| `tokenrhythm.setApiKey`（保留） | 兼容旧版：设置单一 key（写入新格式单元素列表） |
| `tokenrhythm.setModelPreset` 等 | 不变 |

## 7. 实施步骤（Phase 顺序）

1. **Phase 1** `src/keyManager.ts`：数据模型 + 迁移 + 状态管理 + 选择逻辑
2. **Phase 2** `src/balanceCheck.ts`：余额查询 + TTL 缓存 + 手动检测
3. **Phase 3** `package.json` 设置 + 命令 + `package.nls*.json` + `localize.ts`
4. **Phase 4** `extension.ts`：注册 `manageApiKeys` 命令（QuickPick 全部动作）
5. **Phase 5** `provider.ts`：聊天请求轮换循环接入（核心）
6. **Phase 6** `commitMessageGenerator.ts`：Git 提交轮换接入
7. **Phase 7** `provideModel.ts` + `modelSync.ts`：主 key 接入
8. **Phase 8** 文档：AGENTS.md + Walkthrough
9. **Phase 9** 验证（见下）

## 8. 验证计划

| # | 场景 | 预期 |
|---|------|------|
| V1 | `npm run compile` + `npx tsc --noEmit` | 零错误 |
| V2 | key A（有效+cookie）+ key B（余额≤0+cookie），rotation 聊天 | 预检跳过 B 用 A，成功响应；日志含脱敏 key |
| V3 | `manageApiKeys` 显示 | B 显示"不可用(余额不足)"，A 显示"可用" |
| V4 | 对 B 检测可用性 | 余额不足 → 保持不可用 |
| V5 | B 充值后检测可用性 | 标记可用（自愈） |
| V6 | `minBalanceCny` 调到高于 A 余额 | A 在预检中被跳过，自动用其他 key |
| V7 | single 模式指向不可用 key | 报错且不切换 |
| V8 | 无 cookie 的 key + 构造 402 | 被动检测切换 |
| V9 | cookie 失效 | 回退被动，请求仍能发出 |
| V10 | Git 提交生成（rotation） | 正常轮换 |
| V11 | 旧版单 key 迁移 | 自动迁移，旧 key 生效 |
| V12 | 所有 key 不可用 | 友好报错列出原因 |

## 9. 边界与已知限制

1. **余额竞态**：预检与请求之间存在时间差（余额刚被其他请求花光），被动检测兜底。
2. **cookie 会话过期**：QuickPick 显示绑定状态并允许更新；检测时提示重新绑定。
3. **429 可能为账号级限流**：换 key 不一定有效，但尝试切换无害。
4. **不改造 `scripts/cookieApi`**：独立 tsconfig，`src/balanceCheck.ts` 独立实现。
5. **不引入 VS Code proposed API**。
6. **手动检测的"请求一次"用最小真实聊天请求**（`say ok` + `max_tokens=8`）：余额不足时被 402 拦截不消耗 token；`/v1/models` 不校验余额（余额 < 0 也 200），无法作为可用性判据。
7. **视觉代理轮内失败不轮换**：见 4.2 D2 设计理由。
