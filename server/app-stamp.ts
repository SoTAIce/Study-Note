/**
 * 代码指纹（repo-003）：一键启动用它判断「要不要重新构建前端」「正在跑的服务是不是旧版本」。
 *
 * - appStamp：运行时代码（server/、web/、构建配置、依赖清单）的内容哈希。服务启动时算一次，
 *   /api/health 带出去；启动脚本在磁盘上再算一次，对不上就说明服务是旧代码起来的。
 * - depsStamp：package.json + 锁文件的哈希，变了就要重新安装依赖。
 *
 * 测试文件、文档、数据目录不算：改了它们不需要重建、也不需要重启。
 * 只用 Node 内置模块：依赖还没装的时候启动脚本也要能跑。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 参与指纹的目录（相对仓库根） */
const CODE_DIRS = ["server", "web"];
/** 参与指纹的单个文件 */
const CODE_FILES = ["package.json", "pnpm-lock.yaml", "package-lock.json", "vite.config.ts", "tsconfig.json"];
/** 依赖指纹只看这几个 */
const DEPS_FILES = ["package.json", "pnpm-lock.yaml", "package-lock.json"];
const SKIP_DIRS = new Set(["node_modules", "dist", "data", "tests", ".git"]);

/** 测试文件、说明文档不影响运行 */
function counts(name: string): boolean {
  return !/\.test\.[cm]?[jt]sx?$/.test(name) && !/\.md$/i.test(name);
}

/** 列出参与指纹的文件（相对路径，统一用 / 分隔，排好序：Windows 和 Linux 算出来一样） */
export function stampFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
      } else if (entry.isFile() && counts(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const dir of CODE_DIRS) walk(dir);
  for (const file of CODE_FILES) if (fs.existsSync(path.join(root, file))) out.push(file);
  return out.sort();
}

function hashFiles(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const rel of files) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(root, ...rel.split("/")));
    } catch {
      continue;
    }
    hash.update(rel).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function appStamp(root: string): string {
  return hashFiles(root, stampFiles(root));
}

export function depsStamp(root: string): string {
  return hashFiles(
    root,
    DEPS_FILES.filter((file) => fs.existsSync(path.join(root, file))),
  );
}

/** 构建 / 安装完成后写下的指纹放在哪（build 会清空 dist，所以构建完再写） */
export const BUILD_STAMP_FILE = path.join("dist", ".study-build-stamp");
export const DEPS_STAMP_FILE = path.join("node_modules", ".study-deps-stamp");

export function readStampFile(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeStampFile(root: string, rel: string, value: string): void {
  fs.writeFileSync(path.join(root, rel), `${value}\n`, "utf8");
}

/**
 * 启动前要做什么：
 * - 没有 node_modules，或依赖清单变了：安装；
 * - 没有 dist/index.html，或代码变了（指纹和上次构建时记下的不同）：构建。
 */
export function preparePlan(root: string): { install: boolean; build: boolean; app: string; deps: string } {
  const app = appStamp(root);
  const deps = depsStamp(root);
  const install = !fs.existsSync(path.join(root, "node_modules")) || readStampFile(root, DEPS_STAMP_FILE) !== deps;
  const build =
    install ||
    !fs.existsSync(path.join(root, "dist", "index.html")) ||
    readStampFile(root, BUILD_STAMP_FILE) !== app;
  return { install, build, app, deps };
}
