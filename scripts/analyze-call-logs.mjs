/**
 * 分析导出的调用日志 CSV，输出统计摘要。
 * 用法: node scripts/analyze-call-logs.mjs [csv路径]
 */
import fs from "node:fs";

const csvPath = process.argv[2] ?? "call-logs-export.csv";
const raw = fs.readFileSync(csvPath, "utf8").trim().split("\n");
const header = raw[0].split(",");
const logs = raw.slice(1).map((line) => {
    // 简单解析（本 CSV 无复杂转义字段）
    const parts = line.split(",");
    const o = {};
    header.forEach((h, i) => (o[h] = parts[i]));
    return o;
});

const num = (v) => Number(v) || 0;
const cost = (v) => num(v);

// 汇总
const totalCost = logs.reduce((s, l) => s + cost(l.costCny), 0);
const totalInput = logs.reduce((s, l) => s + num(l.inputTokens), 0);
const totalOutput = logs.reduce((s, l) => s + num(l.outputTokens), 0);
const totalCache = logs.reduce((s, l) => s + num(l.cacheReadTokens), 0);

console.log("=".repeat(70));
console.log(`调用总数: ${logs.length} 条`);
console.log(`总成本: ¥${totalCost.toFixed(2)}`);
console.log(`总输入Token: ${totalInput.toLocaleString()}`);
console.log(`总输出Token: ${totalOutput.toLocaleString()}`);
console.log(`总缓存读Token: ${totalCache.toLocaleString()}`);
console.log("=".repeat(70));

// 按模型
const byModel = {};
for (const l of logs) {
    byModel[l.model] ??= { count: 0, cost: 0, input: 0, output: 0 };
    byModel[l.model].count++;
    byModel[l.model].cost += cost(l.costCny);
    byModel[l.model].input += num(l.inputTokens);
    byModel[l.model].output += num(l.outputTokens);
}
console.log("\n── 按模型 ──");
for (const [m, v] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`${m.padEnd(26)} ${String(v.count).padStart(5)} 次  ¥${v.cost.toFixed(2).padStart(8)}  输入${v.input.toLocaleString()} 输出${v.output.toLocaleString()}`);
}

// 按 Key
const byKey = {};
for (const l of logs) {
    byKey[l.keyName] ??= { count: 0, cost: 0 };
    byKey[l.keyName].count++;
    byKey[l.keyName].cost += cost(l.costCny);
}
console.log("\n── 按 Key ──");
for (const [k, v] of Object.entries(byKey).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`${k.padEnd(24)} ${String(v.count).padStart(5)} 次  ¥${v.cost.toFixed(2)}`);
}

// 按状态
const byStatus = {};
for (const l of logs) {
    byStatus[l.status] ??= 0;
    byStatus[l.status]++;
}
console.log("\n── 按状态 ──");
for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`HTTP ${s.padEnd(5)} ${c} 次`);
}

// 按协议
const bySurface = {};
for (const l of logs) {
    bySurface[l.apiSurface] ??= 0;
    bySurface[l.apiSurface]++;
}
console.log("\n── 按协议 ──");
for (const [s, c] of Object.entries(bySurface).sort((a, b) => b[1] - a[1])) {
    console.log(`${s.padEnd(12)} ${c} 次`);
}

// 按小时分布（取 requestAt 的小时）
const byHour = {};
for (const l of logs) {
    const h = (l.requestAt || "").slice(11, 13);
    byHour[h] ??= { count: 0, cost: 0 };
    byHour[h].count++;
    byHour[h].cost += cost(l.costCny);
}
console.log("\n── 按小时分布（UTC）──");
for (const [h, v] of Object.entries(byHour).sort()) {
    console.log(`${h}:00  ${String(v.count).padStart(4)} 次  ¥${v.cost.toFixed(2)}`);
}

// 单次最高成本
const top = [...logs].sort((a, b) => cost(b.costCny) - cost(a.costCny)).slice(0, 5);
console.log("\n── 单次成本 TOP5 ──");
for (const l of top) {
    console.log(`${l.requestAt}  ${l.model.padEnd(24)} ¥${cost(l.costCny).toFixed(4)}  输入${num(l.inputTokens).toLocaleString()} 输出${num(l.outputTokens).toLocaleString()}  ${l.finishReason}`);
}
