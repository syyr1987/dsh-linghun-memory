/**
 * 同步海马体 vendor 副本（发布自包含用）。
 *
 * 背景：dsh-linghun-memory 发布期保持自包含（零 npm 依赖、零包名引用），
 * 海马体核心代码以 vendor/hippocampus.js 副本打入发布包；
 * 开发期仍以 ../dsh-hippocampus/index.js 为唯一真源，本脚本保证副本同步。
 *
 * 用法：node scripts/sync-vendor.mjs [--check]
 *   --check  仅校验副本是否最新（供 CI/发布前检查），不写入；不一致时退出码 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "..", "dsh-hippocampus", "index.js");
const dst = join(root, "vendor", "hippocampus.js");

const HEADER = `/**
 * dsh-hippocampus — 海马体（三方公共共享的记忆巩固层）
 *
 * 【vendor 副本 · 自动生成】本文件由 scripts/sync-vendor.mjs 从
 * ../dsh-hippocampus/index.js 同步，请勿手改；发布包自包含依赖此副本。
 * 真源在 dsh-hippocampus/index.js，改动后必须重跑同步并过全量测试。
 * 校验：node scripts/sync-vendor.mjs --check
 */
`;

const body = readFileSync(src, "utf8").replace(/^\/\*\*[\s\S]*?\*\/\n/, "").trimStart();
const content = HEADER + body;

if (process.argv.includes("--check")) {
  const cur = readFileSync(dst, "utf8");
  if (cur !== content) {
    console.error("[sync-vendor] 副本过期！请运行 node scripts/sync-vendor.mjs");
    process.exit(1);
  }
  console.log("[sync-vendor] 副本最新 ✓");
  process.exit(0);
}

writeFileSync(dst, content);
console.log(`[sync-vendor] 已同步 → vendor/hippocampus.js (${content.split("\n").length} 行)`);
