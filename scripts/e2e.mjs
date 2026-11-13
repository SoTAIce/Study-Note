#!/usr/bin/env node
/**
 * 端到端冒烟测试：在临时数据目录起一个真服务，用真浏览器把主流程走一遍。
 *
 * 用法：pnpm build && pnpm e2e
 *   E2E_KEEP=1      结束后不删临时数据目录（排查用）
 *   E2E_HEADED=1    有界面运行
 *
 * 覆盖：首页（含加载占位）→ 新建笔记 → 编辑自动保存 → 搜索 → 历史版本（对比 / 恢复 / 撤销恢复）
 *      → 外部编辑同步（改标题、自动载入、冲突、外部删除进回收站）
 *      → 主题切换并记住 → 窄屏抽屉不横向溢出；全程不允许出现页面报错。
 * 截图写到 e2e-artifacts/（已 gitignore），作为验证证据。
 *
 * 需要 Playwright。云端会话已预装；本机没有时：npm i -g playwright && npx playwright install chromium
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "e2e-artifacts");
const require = createRequire(import.meta.url);

function fail(message, fix) {
  console.error(`\n✖ ${message}`);
  if (fix) console.error(`  怎么修：${fix}`);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  fail("找不到 playwright", "npm i -g playwright && npx playwright install chromium（云端会话已预装，无需安装）");
}

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  fail("前端还没构建（dist/index.html 不存在）", "先运行 pnpm build");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// —— 准备临时数据：两篇互相链接的笔记 ——
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-e2e-"));
const notesDir = path.join(dataDir, "notes");
fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(
  path.join(notesDir, "alpha.md"),
  "---\nid: e2ealpha\ntitle: 阿尔法笔记\ntags: [测试]\ngroup: 冒烟\n---\n# 阿尔法笔记\n\n第一段内容，参见 [[贝塔笔记]]。\n",
);
fs.writeFileSync(
  path.join(notesDir, "beta.md"),
  "---\nid: e2ebeta0\ntitle: 贝塔笔记\ntags: []\n---\n# 贝塔笔记\n\n回到 [[阿尔法笔记]]。\n",
);
fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, "server", "main.ts")], {
  cwd: root,
  env: { ...process.env, STUDY_DATA: dataDir, STUDY_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitHealthy() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`服务 10 秒内没起来。日志：\n${serverLog}`, "单独运行 STUDY_PORT=7790 node server/main.ts 看报错");
}

const steps = [];
let browser;
let currentStep = "";
async function step(name, fn) {
  currentStep = name;
  const started = Date.now();
  await fn();
  steps.push(`✔ ${name} (${Date.now() - started}ms)`);
  console.log(`✔ ${name}`);
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const pageErrors = [];
function watch(page) {
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
}

let exitCode = 0;
try {
  await waitHealthy();
  browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "1" });

  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  watch(page);
  const api = (u) => page.evaluate(async (url) => (await fetch(url)).json(), u);

  await step("首页加载中显示占位，不显示 0 或「还没有笔记」", async () => {
    // 把时间流接口扣住，模拟数据还没到的那一刻
    let release;
    const held = new Promise((r) => (release = r));
    await page.route("**/api/timeline*", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(base);
    await page.locator(".welcome").waitFor();
    const values = await page.locator(".stat-card__value").allTextContents();
    expect(values.every((v) => v === "—"), `加载中统计应为占位，实际 ${values.join(",")}`);
    expect((await page.locator(".welcome__empty").count()) === 0, "加载中不应显示「还没有笔记」");
    release(); // 之后的请求直接放行（路由保留，但不再等待）
  });

  await step("首页加载，显示统计与最近更新", async () => {
    await page.locator(".welcome__recentitem").nth(1).waitFor();
    const total = await page.locator(".stat-card__value").first().textContent();
    expect(total === "2", `全部笔记计数应为 2，实际 ${total}`);
    expect((await page.locator(".welcome__recentitem").count()) === 2, "最近更新应有 2 张卡片");
    await page.screenshot({ path: path.join(artifacts, "01-home.png") });
  });

  await step("新建笔记并进入编辑", async () => {
    await page.locator(".new-note-entry").click();
    await page.locator(".compose__title").fill("冒烟新建");
    await page.locator(".compose__body").fill("新建的正文 #冒烟");
    await page.keyboard.press("Control+Enter");
    await page.locator(".editor__title").waitFor();
    expect((await page.locator(".editor__title").inputValue()) === "冒烟新建", "编辑器标题应为「冒烟新建」");
    const list = await api("/api/notes");
    expect(list.items.length === 3, `应有 3 篇笔记，实际 ${list.items.length}`);
  });

  await step("编辑后自动保存并落盘", async () => {
    await page.locator(".note-row__text", { hasText: /^阿尔法笔记$/ }).click();
    await page.locator(".editor__title").waitFor();
    const ta = page.locator(".editor__textarea");
    await ta.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n追加一行 E2E");
    await page.locator(".save-state--saved").waitFor({ timeout: 5000 });
    const raw = fs.readFileSync(path.join(notesDir, "alpha.md"), "utf8");
    expect(raw.includes("追加一行 E2E"), "alpha.md 应包含刚输入的内容");
    await page.screenshot({ path: path.join(artifacts, "02-editor.png") });
  });

  await step("搜索能找到笔记", async () => {
    await page.keyboard.press("Control+k");
    await page.locator(".palette__input").fill("贝塔");
    await page.locator(".palette").getByText("贝塔笔记").first().waitFor();
    await page.keyboard.press("Escape");
  });

  await step("历史版本：打开后第一次保存存了一份，可对比、恢复、撤销恢复", async () => {
    const history = await api("/api/notes/e2ealpha/history");
    expect(history.items.length === 1 && history.items[0].reason === "edit", "第一次保存后应正好有 1 份 edit 版本");
    await page.keyboard.press("Control+Shift+H");
    await page.locator(".history").waitFor();
    await page.locator(".history__item").first().click();
    await page.locator(".diff__line--add").first().waitFor();
    await page.screenshot({ path: path.join(artifacts, "03-history-diff.png") });
    await page.getByRole("button", { name: "恢复到此版本" }).click();
    await page.getByRole("button", { name: "确认恢复" }).click();
    await page.locator(".history").waitFor({ state: "detached" });
    const ta = page.locator(".editor__textarea");
    expect(!(await ta.inputValue()).includes("追加一行 E2E"), "恢复后正文不应再有追加的那行");
    // 撤销恢复：最新一份是「恢复前」
    await page.getByLabel("历史版本").click();
    await page.locator(".history__reason--restore").first().waitFor();
    await page.locator(".history__item").first().click();
    await page.getByRole("button", { name: "恢复到此版本" }).click();
    await page.getByRole("button", { name: "确认恢复" }).click();
    await page.locator(".history").waitFor({ state: "detached" });
    expect((await ta.inputValue()).includes("追加一行 E2E"), "撤销恢复后追加的那行应回来");
  });

  // —— 外部编辑同步（sync-001）：模拟 VS Code / Obsidian 直接改 data/notes 里的文件 ——
  const alphaPath = path.join(notesDir, "alpha.md");
  const betaPath = path.join(notesDir, "beta.md");
  const editExternally = (file, from, to) => {
    const raw = fs.readFileSync(file, "utf8");
    expect(raw.includes(from), `${path.basename(file)} 里应有「${from}」`);
    fs.writeFileSync(file, raw.replace(from, to), "utf8");
  };

  await step("外部改了另一篇的标题：左栏几秒内更新", async () => {
    editExternally(betaPath, "title: 贝塔笔记", "title: 贝塔（外部改过）");
    await page.locator(".note-row__text", { hasText: /^贝塔（外部改过）$/ }).waitFor({ timeout: 5000 });
  });

  await step("当前这篇没有未保存修改：外部修改自动载入", async () => {
    await page.locator(".save-state--saved").waitFor({ timeout: 5000 });
    editExternally(alphaPath, "第一段内容", "第一段内容（外部编辑器写的）");
    await page.waitForFunction(
      () => document.querySelector(".editor__textarea")?.value.includes("外部编辑器写的"),
      null,
      { timeout: 5000 },
    );
    await page.getByText("已载入外部修改").waitFor({ timeout: 3000 });
    expect((await page.locator(".conflict").count()) === 0, "干净时不应出冲突提示");
  });

  await step("有未保存修改时：出冲突提示，磁盘上的外部版本不被覆盖", async () => {
    const ta = page.locator(".editor__textarea");
    await ta.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n本地还没保存");
    editExternally(alphaPath, "第一段内容（外部编辑器写的）", "第一段内容（外部又改了一次）");
    await page.locator(".conflict").waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(artifacts, "04-sync-conflict.png") });
    await page.waitForTimeout(1500); // 冲突期间自动保存必须停住
    const disk = fs.readFileSync(alphaPath, "utf8");
    expect(disk.includes("外部又改了一次"), "磁盘上应保留外部版本");
    expect(!disk.includes("本地还没保存"), "冲突期间不能把本地修改写到磁盘");
    await page.locator(".conflict").getByRole("button", { name: "重新加载" }).click();
    await page.locator(".conflict").waitFor({ state: "detached" });
    const value = await ta.inputValue();
    expect(value.includes("外部又改了一次") && !value.includes("本地还没保存"), "重新加载后应是外部版本");
  });

  await step("正打开的笔记在外部被删：内容存进回收站并关闭", async () => {
    await page.locator(".note-row__text", { hasText: /^贝塔（外部改过）$/ }).click();
    await page.waitForFunction(
      () => document.querySelector(".editor__title")?.value === "贝塔（外部改过）",
      null,
      { timeout: 5000 },
    );
    const errorsBefore = pageErrors.length;
    fs.rmSync(betaPath);
    await page.getByText("已在外部删除，编辑器里的内容已存进回收站").waitFor({ timeout: 8000 });
    // 判断「被删了」靠的就是 GET /api/notes/:id 返回 404，浏览器会把它记成一条资源加载错误。
    // 只在这一步、只放过这一种；其他任何报错照样让最后一步失败。
    const during = pageErrors.splice(errorsBefore);
    const unexpected = during.filter((e) => !/status of 404 \(Not Found\)/.test(e));
    pageErrors.push(...unexpected);
    expect((await page.locator(".note-tab", { hasText: "贝塔（外部改过）" }).count()) === 0, "贝塔的标签页应已关闭");
    const trash = await api("/api/trash");
    expect(trash.items.some((item) => item.origPath === "beta.md"), "回收站里应有 beta.md");
    // 放回去，后面的窄屏步骤还要用它
    const name = trash.items.find((item) => item.origPath === "beta.md").name;
    const restored = await page.evaluate(
      async (n) => (await fetch(`/api/trash/${encodeURIComponent(n)}/restore`, { method: "POST" })).status,
      name,
    );
    expect(restored === 200, `从回收站恢复应成功，实际 ${restored}`);
    await page.locator(".note-row__text", { hasText: /^贝塔（外部改过）$/ }).waitFor({ timeout: 5000 });
  });

  await step("主题切换并在刷新后保持", async () => {
    const toggle = page.getByLabel(/切换主题/);
    await toggle.click(); // system → light
    await toggle.click(); // light → dark
    await page.reload();
    await page.locator(".sidebar").waitFor();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme === "dark", `刷新后主题应为 dark，实际 ${theme}`);
    await page.screenshot({ path: path.join(artifacts, "05-dark.png") });
  });

  await step("窄屏：抽屉导航可用，页面不横向溢出", async () => {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch(mobile);
    await mobile.goto(base);
    await mobile.getByLabel("打开导航").click();
    await mobile.locator(".sidebar.is-open").waitFor();
    await mobile.locator(".note-row__text", { hasText: /^贝塔（外部改过）$/ }).click();
    await mobile.locator(".editor__title").waitFor();
    const width = await mobile.evaluate(() => document.documentElement.scrollWidth);
    expect(width <= 390, `页面宽度 ${width} 超过视口 390`);
    await mobile.screenshot({ path: path.join(artifacts, "06-mobile.png") });
  });

  await step("全程没有页面报错", async () => {
    expect(pageErrors.length === 0, `页面报错：\n  ${pageErrors.join("\n  ")}`);
  });

  console.log(`\nE2E 通过：${steps.length} 步，截图在 e2e-artifacts/`);
} catch (err) {
  exitCode = 1;
  console.error(`\n✖ E2E 失败于「${currentStep}」：${err.message}`);
  console.error("  怎么查：E2E_HEADED=1 E2E_KEEP=1 pnpm e2e 有界面重跑并保留数据目录；e2e-artifacts/ 里有已完成步骤的截图");
  try {
    const pages = browser ? browser.contexts().flatMap((c) => c.pages()) : [];
    if (pages[0]) await pages[0].screenshot({ path: path.join(artifacts, "failure.png") });
  } catch {
    // 截图失败不掩盖原错误
  }
} finally {
  if (browser) await browser.close();
  server.kill();
  if (process.env.E2E_KEEP === "1") console.log(`数据目录保留在：${dataDir}`);
  else fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
