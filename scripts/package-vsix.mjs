/**
 * package-vsix.mjs — VSIX 打包脚本（npm run build）
 *
 * 输出名固定为 `tokenrhythm-copilot-<version>.vsix`（如 tokenrhythm-copilot-1.10.0.vsix），
 * 与 GitHub Release 附件命名规范及历史发布产物保持一致
 * （见 .copilot/vscode开发经验.instructions.md §1.4）。
 * 注意：发布名用短前缀 `tokenrhythm-copilot`，不用 package.json 的完整包名
 * `tokenrhythm-copilot-provider`；也不使用 vsce 默认的 extension.vsix。
 *
 * 用法：npm run build
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const outFile = `tokenrhythm-copilot-${pkg.version}.vsix`;

console.log(`[package-vsix] packaging ${pkg.name} v${pkg.version} → ${outFile}`);
execSync(`npx @vscode/vsce package -o ${outFile}`, { stdio: "inherit" });
