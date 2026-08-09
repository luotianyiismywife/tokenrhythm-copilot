---
description: "Use when: 需要操作浏览器（市场上传/审核、GitHub Release 创建等网页操作）、配置或排查 VS Code MCP（Model Context Protocol）、查看开发环境约定（VS Code 版本/Profile 架构/常用命令），以及文档需随现实变化同步更新时参考"
---

# VS Code 开发经验 · 通用手册

> **用途**：记录 VS Code 开发环境的通用经验，包括**浏览器自动化操作**（市场上传、GitHub Release 等）、**MCP 配置与排障**、以及**文档同步更新约定**。本项目可能同时在多台机器上开发，本文档内容应保持**机器无关**，不要写入具体机器相关的路径/版本。
> **更新原则**：现实环境变化（VS Code 升级、市场审核流程变化、MCP 服务器新增/删除、Profile 结构变化等）后，必须同步修改本文档。

---

## 一、浏览器自动化操作经验（Copilot 内置浏览器工具）

> Copilot 在 VS Code 中有内置浏览器（`open_browser_page` / `click_element` / `type_in_page` / `run_playwright_code` 等工具），可用于登录第三方网站、上传扩展、创建 Release 等操作。

### 1.1 通用操作要点

| 要点 | 说明 |
|------|------|
| **登录页需用户手动** | 涉及账号密码（GitHub / Microsoft）的登录**必须由用户亲自完成**，Copilot 不能代输密码（安全红线）。Copilot 打开页面后，提示用户登录，登录完再继续 |
| **登录态不跨页面共享** | 每次 `open_browser_page` 新开的浏览器页**不保留**之前的登录 cookie。切换页面（如市场→GitHub）需要重新登录。**例外（已验证 2026-08-09）**：同一会话内 GitHub 与市场登录态共享，市场页点"使用 GitHub 登录"可直接登录（见 1.2） |
| **元素点击超时** | 微软/谷歌系页面（marketplace、reCAPTCHA）的按钮常因动画/iframe 导致 `click_element` 超时。**解决方案**：用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发 JS 点击 |
| **iframe 内元素** | reCAPTCHA 验证框、部分对话框在 iframe 内，快照里可见但需用户手动交互（如"选择包含小轿车的图片"） |
| **文件上传** | 优先用 `page.setInputFiles('input[type=file]', '绝对路径')` 直接设文件（如市场上传 VSIX）。GitHub Release 附件用 `waitForEvent('filechooser')` + `chooser.setFiles()` |
| **上传后状态** | 市场上传后显示 `Verifying <版本>`，需等待审核（通常数小时）；reCAPTCHA 验证通过后上传自动继续 |
| **reCAPTCHA 依赖 google.com 可达性** | 市场上传的 reCAPTCHA 验证需要访问 `www.google.com/recaptcha/...`。**中国大陆网络无法直接访问 google.com**，会报 `无法连接到 reCAPTCHA 服务` / `net::ERR_ABORTED` / `ERR_BLOCKED_BY_ORB`（console 另见 CSP `connect-src` 拦截，均指向 google.com 不可达）。此时**内置浏览器刷新无效**，需：① 开代理后重试，或 ② 直接用外部浏览器（Chrome/Edge，已配代理插件）手动上传 |

### 1.2 VS Code 市场（Marketplace）上传流程

1. 打开 `https://marketplace.visualstudio.com/manage/publishers/<publisherId>` → 用户登录 Microsoft 账号
2. 在扩展列表行点 **More Actions...**（`button[aria-label="More Actions..."]`）→ **Update**
3. 上传对话框出现：`page.setInputFiles('#file-upload', 'xxx.vsix')`
4. 点击 **Upload** → 出现 reCAPTCHA 验证（**需用户手动完成**）→ 验证后自动上传
5. 列表显示 `Verifying <新版本>` → 等待审核通过

> ✅ **已验证（2026-08-09）：市场登录页点 "使用 GitHub 登录" 会自动登录，无需再输凭据**——Microsoft 登录页（`login.microsoftonline.com`，URL 带 `githubsi=true`）有 `使用 GitHub 登录` 按钮，点击后若该 GitHub 账号已绑定 Microsoft 账号（如 `azhe-hjm@outlook.com`），会直接进入"保持登录状态?"确认页 → 点"是"即登录成功，跳转管理页。**与浏览器自动化 1.1 的"登录态不跨页面共享"不同**：GitHub（github.com）与市场（marketplace.visualstudio.com）在同一浏览器会话内登录态**共享**，GitHub 登录后市场无需再次登录。但新开浏览器页/新会话仍可能要求重新登录。

> ⚠️ **教训（2026-08-10 v1.6.3）**：市场上传的 reCAPTCHA 验证**必须能访问 google.com**。中国大陆网络下内置浏览器会报"无法连接到 reCAPTCHA 服务"（`google.com/recaptcha/api2/clr` 被 CSP `connect-src` 拦截 + `ERR_ABORTED`/`ERR_BLOCKED_BY_ORB`），**刷新无效**。此时应**改用外部浏览器（Chrome/Edge，配代理插件）手动上传**，或开代理后重试内置浏览器。

> ⚠️ **关键教训**：vsix 打包必须**包含 dependencies**！用 `npx vsce package`（**不要加 `--no-dependencies`**），否则插件装不上 node_modules，用户激活直接崩溃（报"命令未找到"）。打包后务必 `npx vsce ls` 确认 `node_modules/` 在包内。

### 1.3 GitHub Release 创建流程

1. 打开 `https://github.com/<owner>/<repo>/releases/new?tag=vX.Y.Z&title=vX.Y.Z` → 用户登录 GitHub
2. 填好 tag / 标题 / 描述（URL 参数可预填）
3. 二进制附件上传（vsix 等）：
   ```js
   const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
   // 点击 "Attach binaries by dropping them here or selecting them" 按钮
   const chooser = await chooserPromise;
   await chooser.setFiles('绝对路径\\xxx.vsix');
   ```
   > ⚠️ **注意**：vsix 不能拖进正文编辑器（GitHub 不支持该类型作为正文附件），必须走**二进制附件区**。
4. 点击 **Publish release**

### 1.4 版本号与发布命名规则（重要）

> **历史教训（2026-08-09）**：曾打包为 `extension.vsix`（vsce 默认输出名），但正确的发布产物命名必须是 **`<扩展名>-<版本号>.vsix`**（如 `tokenrhythm-copilot-1.6.0.vsix`），否则与历史 release 下载链接的附件名不一致。

| 项目 | 规则 |
|------|------|
| **打包输出名** | 固定为 **`<name>-<version>.vsix`**（如 `tokenrhythm-copilot-1.6.0.vsix`）：`npx vsce package -o tokenrhythm-copilot-<version>.vsix`。**不要用 vsce 默认的 `extension.vsix`** |
| **name/version 来源** | `package.json` 的 `name` 字段（`tokenrhythm-copilot`）+ `version` 字段（如 `1.6.0`） |
| **GitHub Release 附件** | 上传 `<name>-<version>.vsix`，下载链接即 `.../releases/download/<tag>/<name>-<version>.vsix` |
| **tag 格式** | `vX.Y.Z`（如 `v1.6.0`），指向对应版本提交 |
| **版本号语义** | 功能新增 → bump minor（1.5.0 → 1.6.0）；bugfix → bump patch；不向后兼容 → bump major |
| **版本号占用检查** | 打包/发布前必须确认：`git tag -l "v*"` 看最新 tag，**不能在已发布的 tag 上重复发布同版本**（市场拒绝同版本重复上传；GitHub Release 可覆盖但不应依赖） |
| **发布后产物位置** | 本地根目录 `<name>-<version>.vsix`（`.gitignore` 已忽略，不入库）；release 附件由浏览器流程上传 |

### 1.4b 发布检查清单（每次发布前）

```bash
# 0. 同步仓库（必须先做！）：提交并推送所有源码/文档改动，避免 tag/release 指向不完整代码
git status --short            # 确认无未提交改动（.copilot/build-log.md 例外，脚本自动生成不入库）
git add <改动的文件> && git commit -m "..." && git push origin main
# 1. 确认版本号未被占用（对比 package.json version 与最新 tag）
git tag -l "v*" | Sort-Object -Descending | Select-Object -First 3
# 2. 检查远端是否已有同名 tag（本地可能滞后）
git ls-remote --tags origin | Select-String "<version>"
# 3. 打包并验证内容（输出名必须为 <name>-<version>.vsix）
npm run compile
npx vsce package -o tokenrhythm-copilot-<version>.vsix
npx vsce ls   # 确认 node_modules/ 与 out/ 齐全
# 4. 打 tag 并推送（确保 tag 指向含完整实现的提交）
git tag v<version> && git push origin v<version>
# 5. 发布（浏览器流程）
#    - GitHub: releases/new?tag=vX.Y.Z，附件用 tokenrhythm-copilot-<version>.vsix
#    - 市场: 上传 tokenrhythm-copilot-<version>.vsix
```

> ⚠️ **教训（2026-08-09 v1.6.1）**：曾只提交 `package.json`+`CHANGELOG.md` 就 push tag，导致 tag 指向不含实现源码的提交（`src/extension.ts` 等 6 个文件漏提交）。**必须先 `git status` 确认所有源码已提交**，再打 tag 发布。

### 1.5 常见问题排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 点击无反应/超时 | 微软系页面按钮事件绑定在 React 上 | `page.evaluate(() => 元素.click())` |
| 找不到元素 | 快照 ref 过期（页面已变） | 重新 `read_page` 获取新 ref |
| reCAPTCHA 卡住 | 反机器人验证必须真人操作 | 提示用户在 iframe 中完成图片验证 |
| 上传失败 | vsix 缺依赖 / 版本号冲突 / 附件名不符合规则 | 检查 `vsce ls`；市场不能重复上传同版本；附件名必须是 `<name>-<version>.vsix`（见 1.4） |

---

## 二、VS Code MCP（Model Context Protocol）

> MCP 让 VS Code / Copilot 通过标准协议接入外部工具服务器（GitHub、数据库、文件系统等）。

### 2.1 MCP 配置文件位置

| 级别 | 位置 | 说明 |
|------|------|------|
| 用户级 | `%APPDATA%\Code\User\mcp.json` | 全用户生效（一般各机器独立配置） |
| 工作区级 | `<项目>/.vscode/mcp.json` | 仅当前工作区生效（随仓库同步，多机器一致） |
| 设置项 | `chat.mcp.gallery.enabled` | VS Code 设置中的 MCP 市场开关（按需开启） |

### 2.2 MCP 配置格式（参考）

```jsonc
// .vscode/mcp.json 或 用户 mcp.json
{
  "servers": {
    "my-server": {
      "type": "stdio",                 // stdio | sse | http
      "command": "npx",                // 启动命令
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" }        // 可选环境变量
    }
  }
}
```

### 2.3 排障要点

1. **配置了但 Copilot 不识别**：检查文件是否在正确位置（`.vscode/mcp.json`），VS Code 可能需要重载窗口（`Developer: Reload Window`）
2. **stdio 服务器启动失败**：在终端手动运行 `command args` 看报错；确认 `npx` / `node` 在 PATH 中
3. **环境变量不生效**：`env` 里不要放敏感信息（API key 等）到共享文件；确认变量名大小写
4. **MCP 工具未出现在工具列表**：确认 VS Code 版本支持（1.100+ 完善支持），检查输出面板的 MCP 日志
5. **本项目（inherit-profile-plus）**：默认未配置任何 MCP 服务器；若某台机器新增，需在**本节登记**并同步更新依赖清单（`.copilot/instructions/Dependencies of the plugin.instructions.md`），多机器间保持一致

---

## 三、文档同步更新约定（重要）

> **现实环境变化后，必须同步修改本文档及相关指令文件**，保持文档与真实环境一致。

### 触发时机

- VS Code 大版本升级（如 1.131 → 1.132）
- 市场上传/审核结果变化（新版本通过/被拒）
- MCP 服务器新增/删除/迁移
- Profile 结构变化（新增/删除 profile、扩展增减）
- 依赖升级（`@types/vscode`、`sql.js` 等）
- 浏览器自动化流程变化（marketplace 改版等）

### 需要同步更新的文件

| 文件 | 更新内容 |
|------|---------|
| 本文档（`vscode开发经验.instructions.md`） | 浏览器流程、MCP、文档同步约定、本表 |
| `Dependencies of the plugin.instructions.md` | 依赖清单、检查记录表追加 |
| `结构.instructions.md` | 源码结构变更后同步 |
| `vscode-dependency-check.instructions.md` | 检查流程变化时 |

### 流程

1. 现实变化发生 → 立即记录到本文档对应小节
2. 涉及源码/依赖 → 同步更新其他指令文件
3. Profile 变化 → 更新 `vscode配置文件及其配置明细(开发者自用).md`（项目根目录，若存在）
4. 更新后告知用户"文档已同步"
