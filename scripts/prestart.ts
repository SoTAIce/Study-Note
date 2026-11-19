/**
 * 一键启动前的准备（repo-003），由 bin/start.ps1 调用：
 *   node scripts/prestart.ts --pm pnpm
 *
 * - 依赖清单变了（或还没装）：<pm> install；
 * - 代码变了（或还没构建）：<pm> run build；
 * - 做完把指纹写下来，下次没变就跳过；
 * - 最后一行输出 `STAMP=<代码指纹>`，启动脚本拿它和正在跑的服务比，对不上就换成新的。
 *
 * 只用 Node 内置模块（依赖还没装时也要能跑）。退出码非 0 表示失败，启动脚本据此停下。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_STAMP_FILE, DEPS_STAMP_FILE, preparePlan, writeStampFile } from "../server/app-stamp.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

// --root 只给测试用（在临时目录里走一遍）；平时就是仓库根
const root = path.resolve(arg("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const pm = arg("--pm") ?? "pnpm";

function run(args: string[]): boolean {
  // Windows 上 pnpm / npm 是 .cmd，要经过 shell：拼成一条命令（参数是写死的，不含用户输入；
  // 直接把参数数组交给 shell 会触发 Node 的 DEP0190 警告）
  const result =
    process.platform === "win32"
      ? spawnSync(`"${pm}" ${args.join(" ")}`, { cwd: root, stdio: "inherit", shell: true })
      : spawnSync(pm, args, { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

const plan = preparePlan(root);

if (plan.install || plan.build) {
  if (!pm || pm === "none") {
    console.log("[x] 没找到 pnpm 或 npm，无法安装依赖 / 构建前端。");
    process.exit(1);
  }
}

if (plan.install) {
  console.log(`[*] 依赖有变化（或还没装）：${pm} install ...`);
  if (!run(["install"])) {
    console.log("[x] 依赖安装失败。");
    process.exit(1);
  }
  writeStampFile(root, DEPS_STAMP_FILE, plan.deps);
}

if (plan.build) {
  console.log(`[*] 代码有更新（或还没构建）：${pm} run build ...`);
  if (!run(["run", "build"])) {
    console.log("[x] 前端构建失败。");
    process.exit(1);
  }
  writeStampFile(root, BUILD_STAMP_FILE, plan.app);
} else {
  console.log("[=] 前端已是最新，不用重新构建。");
}

console.log(`STAMP=${plan.app}`);
