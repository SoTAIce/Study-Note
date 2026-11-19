import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appStamp,
  BUILD_STAMP_FILE,
  DEPS_STAMP_FILE,
  depsStamp,
  preparePlan,
  stampFiles,
  writeStampFile,
} from "../app-stamp.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 一个最小的「仓库」：server/、web/、依赖清单，外加不该算进指纹的东西 */
function mkRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-stamp-"));
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, "utf8");
  };
  put("package.json", '{"name":"x"}\n');
  put("pnpm-lock.yaml", "lockfileVersion: 9\n");
  put("vite.config.ts", "export default {};\n");
  put("server/main.ts", "console.log(1);\n");
  put("server/tests/a.test.ts", "// test\n");
  put("server/README.md", "# 说明\n");
  put("web/index.html", "<!doctype html>\n");
  put("web/src/App.tsx", "export default 1;\n");
  put("web/src/lib/x.test.ts", "// test\n");
  put("data/notes/a.md", "笔记\n");
  put("node_modules/pkg/index.js", "x\n");
  put("dist/index.html", "old\n");
  return root;
}

test("stampFiles：只算运行时代码，测试、文档、数据、依赖、构建产物都不算", () => {
  const root = mkRepo();
  assert.deepEqual(stampFiles(root), [
    "package.json",
    "pnpm-lock.yaml",
    "server/main.ts",
    "vite.config.ts",
    "web/index.html",
    "web/src/App.tsx",
  ]);
});

test("appStamp：改源码就变；改测试、文档、笔记不变；depsStamp 只跟依赖清单走", () => {
  const root = mkRepo();
  const first = appStamp(root);
  const deps = depsStamp(root);
  assert.match(first, /^[0-9a-f]{16}$/);
  fs.appendFileSync(path.join(root, "server/tests/a.test.ts"), "// more\n");
  fs.appendFileSync(path.join(root, "server/README.md"), "more\n");
  fs.appendFileSync(path.join(root, "data/notes/a.md"), "more\n");
  assert.equal(appStamp(root), first);
  fs.appendFileSync(path.join(root, "web/src/App.tsx"), "// changed\n");
  const second = appStamp(root);
  assert.notEqual(second, first);
  assert.equal(depsStamp(root), deps, "改源码不影响依赖指纹");
  fs.appendFileSync(path.join(root, "pnpm-lock.yaml"), "# changed\n");
  assert.notEqual(depsStamp(root), deps);
  assert.notEqual(appStamp(root), second);
});

test("preparePlan：没记过指纹就装 + 建；都记好了就都跳过；只改代码只重建；改依赖清单两样都做", () => {
  const root = mkRepo();
  let plan = preparePlan(root);
  assert.deepEqual([plan.install, plan.build], [true, true], "老版本升级上来：没有指纹文件");
  writeStampFile(root, DEPS_STAMP_FILE, plan.deps);
  writeStampFile(root, BUILD_STAMP_FILE, plan.app);
  plan = preparePlan(root);
  assert.deepEqual([plan.install, plan.build], [false, false]);

  fs.appendFileSync(path.join(root, "server/main.ts"), "// pulled\n");
  plan = preparePlan(root);
  assert.deepEqual([plan.install, plan.build], [false, true], "git pull 带来新代码");
  writeStampFile(root, BUILD_STAMP_FILE, plan.app);

  fs.appendFileSync(path.join(root, "package.json"), "\n");
  plan = preparePlan(root);
  assert.deepEqual([plan.install, plan.build], [true, true], "依赖清单变了");

  fs.rmSync(path.join(root, "dist"), { recursive: true });
  writeStampFile(root, DEPS_STAMP_FILE, plan.deps);
  assert.equal(preparePlan(root).build, true, "dist 被删了要重建");
});

test("prestart 脚本：按需调用包管理器、构建后写指纹、最后一行输出 STAMP；第二次什么都不做", () => {
  const root = mkRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sn-fakepm-"));
  const log = path.join(bin, "calls.log");
  // 假的包管理器：记下调用；build 时像 vite 一样清空 dist 再写 index.html
  fs.writeFileSync(
    path.join(bin, "fake-pm.mjs"),
    `import fs from "node:fs"; import path from "node:path";
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "run" && process.argv[3] === "build") {
  fs.rmSync(path.join(process.cwd(), "dist"), { recursive: true, force: true });
  fs.mkdirSync(path.join(process.cwd(), "dist"));
  fs.writeFileSync(path.join(process.cwd(), "dist", "index.html"), "new");
}
if (process.argv[2] === "install") fs.mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true });
`,
  );
  let pm: string;
  if (process.platform === "win32") {
    pm = path.join(bin, "fake-pm.cmd");
    fs.writeFileSync(pm, `@"${process.execPath}" "%~dp0fake-pm.mjs" %*\r\n`);
  } else {
    pm = path.join(bin, "fake-pm");
    fs.writeFileSync(pm, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-pm.mjs" "$@"\n`);
    fs.chmodSync(pm, 0o755);
  }
  const prestart = () =>
    spawnSync(process.execPath, [path.join(repo, "scripts", "prestart.ts"), "--root", root, "--pm", pm], { encoding: "utf8" });

  const first = prestart();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(fs.readFileSync(log, "utf8"), "install\nrun build\n");
  const lines = first.stdout.trim().split(/\r?\n/);
  assert.equal(lines.at(-1), `STAMP=${appStamp(root)}`);
  assert.equal(fs.readFileSync(path.join(root, BUILD_STAMP_FILE), "utf8").trim(), appStamp(root), "构建清空 dist 之后再写指纹");

  const second = prestart();
  assert.equal(second.status, 0);
  assert.equal(fs.readFileSync(log, "utf8"), "install\nrun build\n", "没变化时不再调用包管理器");
  assert.match(second.stdout, /前端已是最新/);
});
