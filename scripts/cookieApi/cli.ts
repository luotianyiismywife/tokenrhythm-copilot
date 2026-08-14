/**
 * TokenRhythm 用户中心查询 CLI（临时调试用）。
 *
 * 用法（编译后）：
 *   node out/cookieApi/cli.js <tr_session值> [startAt] [endAt]
 *
 * 示例：
 *   node out/cookieApi/cli.js sess_xxxx
 *   node out/cookieApi/cli.js sess_xxxx 2026-07-28T00:00:00.000Z 2026-08-05T00:00:00.000Z
 */

import {
    queryAllCallLogs,
    queryUsageSummary,
    summarizeCallLogs,
} from "./cookieApi";

function formatNumber(n: number): string {
    return n.toLocaleString("en-US");
}

function formatMoney(n: number | string, digits = 4): string {
    // 防御：API 金额字段可能以字符串返回（避免浮点精度问题），统一转 number
    const num = typeof n === "number" ? n : Number(n);
    return Number.isFinite(num) ? num.toFixed(digits) : "0";
}

function padRight(s: string, width: number): string {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main(): Promise<void> {
    const [, , cookie, startAtArg, endAtArg] = process.argv;
    if (!cookie) {
        console.error("用法: node out/cookieApi/cli.js <tr_session值> [startAt] [endAt]");
        process.exit(1);
    }

    const startAt = startAtArg ?? "2026-07-28T00:00:00.000Z";
    const endAt = endAtArg ?? "2026-08-05T00:00:00.000Z";

    // 1. 余额汇总
    const summary = (await queryUsageSummary(cookie)).data;
    console.log("=".repeat(100));
    console.log(
        `账号汇总: 调用 ${summary.calls} 次 (成功 ${summary.successCalls} / 错误 ${summary.errorCalls} / 中止 ${summary.abortedCalls})`,
    );
    console.log(
        `累计成本: ¥${formatMoney(summary.costCny, 2)} | 余额: ¥${formatMoney(summary.balanceCny)} | ` +
        `可用: ¥${formatMoney(summary.availableBalanceCny)} | 冻结: ¥${formatMoney(summary.frozenBalanceCny, 2)}`,
    );
    console.log(
        `输入Token: ${formatNumber(summary.inputTokens)} | 输出Token: ${formatNumber(summary.outputTokens)}`,
    );
    console.log("=".repeat(100));

    // 2. 调用日志
    console.log(`时间范围: ${startAt} ~ ${endAt}`);
    const logs = await queryAllCallLogs(cookie, startAt, endAt, { pageSize: 100, maxPages: 5 });
    console.log(`共拉取 ${logs.length} 条日志`);
    console.log();

    // 明细表格（最多显示 50 条）
    const hdr =
        padRight("#", 4) +
        padRight("时间(UTC)", 22) +
        padRight("模型", 24) +
        padRight("Key", 16) +
        padRight("状态", 6) +
        padRight("耗时ms", 9) +
        padRight("输入", 10) +
        padRight("输出", 8) +
        padRight("成本¥", 12) +
        "finishReason";
    console.log(hdr);
    console.log("-".repeat(hdr.length));
    let pageCost = 0;
    for (const [i, log] of logs.slice(0, 50).entries()) {
        pageCost += log.costCny;
        console.log(
            padRight(String(i + 1), 4) +
            padRight(log.requestAt, 22) +
            padRight(log.model, 24) +
            padRight(log.keyName, 16) +
            padRight(String(log.status), 6) +
            padRight(String(log.latencyMs), 9) +
            padRight(formatNumber(log.inputTokens), 10) +
            padRight(formatNumber(log.outputTokens), 8) +
            padRight(formatMoney(log.costCny), 12) +
            log.finishReason,
        );
    }
    console.log("-".repeat(hdr.length));
    console.log(`本页合计成本: ¥${formatMoney(pageCost, 4)}`);
    console.log();

    // 3. 统计汇总
    const stats = summarizeCallLogs(logs);
    console.log("--- 按模型 ---");
    for (const item of stats.byModel) {
        console.log(`${padRight(item.model, 26)} ${String(item.count).padStart(4)} 次  成本 ¥${formatMoney(item.costCny, 2)}`);
    }
    console.log();
    console.log("--- 按状态 ---");
    for (const item of stats.byStatus) {
        console.log(`HTTP ${padRight(item.status, 6)} ${item.count} 次`);
    }
    console.log();
    console.log("--- 按 Key ---");
    for (const item of stats.byKey) {
        console.log(`${padRight(item.keyName, 20)} ${item.count} 次`);
    }
    console.log();
    console.log(`全部日志合计成本: ¥${formatMoney(stats.totalCostCny, 2)}`);
}

main().catch((err: unknown) => {
    console.error("查询失败:", err instanceof Error ? err.message : err);
    process.exit(1);
});
