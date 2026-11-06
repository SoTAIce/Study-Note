#!/usr/bin/env node
/**
 * 一次性迁移：把旧笔记归入某个分组（只补 frontmatter 的 group 一行，正文不动）。
 *
 * 用法：
 *   node bin/migrate-groups.mjs --group "Go 学习" --dir backend-go          # dry-run
 *   node bin/migrate-groups.mjs --group "Go 学习" --dir backend-go --apply  # 真写
 *
 * 具体逻辑在 server/migrate-groups.ts（那边有测试）。
 */
import { main } from "../server/migrate-groups.ts";

main();