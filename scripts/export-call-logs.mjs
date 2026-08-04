/**
 * 导出全部调用日志为 CSV。
 * 用法：
 *   $env:TR_SESSION="<cookie值>"; node scripts/export-call-logs.mjs [startAt] [endAt] [outFile]
 * 示例：
 *   $env:TR_SESSION="sess_xxx"; node scripts/export-call-logs.mjs
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://tokenrhythm.studio";
const cookie = process.env.TR_SESSION;
if (!cookie) {
    console.error("错误：请先设置环境变量 TR_SESSION（登录 cookie 值）");
    process.exit(1);
}

const startAt = process.argv[2] ?? "2026-08-03T00:00:00.000Z";
const endAt = process.argv[3] ?? "2026-08-05T00:00:00.000Z";
const outFile = process.argv[4] ?? path.resolve("call-logs-export.csv");

async function fetchPage(page, pageSize) {
    const url = `${BASE}/api/call-logs/page?startAt=${encodeURIComponent(startAt)}&endAt=${encodeURIComponent(endAt)}&page=${page}&pageSize=${pageSize}`;
    const resp = await fetch(url, {
        headers: { Cookie: `tr_session=${cookie}`, Accept: "application/json" },
    });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
}

const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// 第一页拿 total
const first = await fetchPage(1, 100);
const total = first.data?.total ?? first.data?.list?.length ?? 0;
const pageCount = Math.max(1, Math.ceil(total / 100));
console.log(`总数: ${total} 条，共 ${pageCount} 页`);

const all = [...(first.data?.list ?? [])];
for (let p = 2; p <= pageCount; p++) {
    const j = await fetchPage(p, 100);
    all.push(...(j.data?.list ?? []));
    process.stdout.write(`\r拉取中: ${all.length}/${total}`);
}
console.log();

const header = ["#", "requestAt", "model", "keyName", "status", "latencyMs", "inputTokens", "outputTokens", "cacheReadTokens", "reasoningTokens", "costCny", "apiSurface", "finishReason", "traceId", "clientApp", "stream", "retryCount"];
const lines = [header.join(",")];
all.forEach((log, i) => {
    lines.push([
        i + 1, esc(log.requestAt), esc(log.model), esc(log.keyName), log.status, log.latencyMs,
        log.inputTokens, log.outputTokens, log.cacheReadTokens ?? "", log.reasoningTokens ?? 0,
        log.costCny, esc(log.apiSurface), esc(log.finishReason), esc(log.traceId), esc(log.clientApp), log.stream, log.retryCount,
    ].join(","));
});

fs.writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`已导出 ${all.length} 条 → ${outFile} (${fs.statSync(outFile).size} bytes)`);
