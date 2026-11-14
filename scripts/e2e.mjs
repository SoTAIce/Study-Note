#!/usr/bin/env node
/**
 * 端到端冒烟测试：在临时数据目录起一个真服务，用真浏览器把主流程走一遍。
 *
 * 用法：pnpm build && pnpm e2e
 *   E2E_KEEP=1      结束后不删临时数据目录（排查用）
 *   E2E_HEADED=1    有界面运行
 *   E2E_PDF_BROWSER=system  导出 PDF 用服务自己找到的 Edge / Chrome（默认用 Playwright 的 Chromium）
 *
 * 覆盖：首页（含加载占位）→ 新建笔记 → 编辑自动保存 → 搜索 → 历史版本（对比 / 恢复 / 撤销恢复）
 *      → 外部编辑同步（改标题、自动载入、冲突、外部删除进回收站）
 *      → 阅览模式 → 导出 PDF → 回收站（自动清理过期、清空二次确认）→ 分组里新建 → 编辑器快捷操作 → AI 改动可撤回 → 编辑器第二批
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
} catch (err) {
  fail(
    `找不到 playwright（${err instanceof Error ? err.message.split("\n")[0] : err}；NODE_PATH=${process.env.NODE_PATH ?? "未设置"}）`,
    "npm i -g playwright && npx playwright install chromium（云端会话已预装，无需安装）",
  );
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

/**
 * 导出 PDF 用哪个浏览器：默认用 Playwright 自带的 Chromium，结果不依赖这台机器装没装 Edge / Chrome；
 * E2E_PDF_BROWSER=system 时让服务自己去找（CI 的 Windows 上就是系统自带的 Edge）。
 */
function pdfBrowserEnv() {
  if (process.env.E2E_PDF_BROWSER === "system") return {};
  return { STUDY_PDF_BROWSER: chromium.executablePath() };
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, "server", "main.ts")], {
  cwd: root,
  env: { ...process.env, STUDY_DATA: dataDir, STUDY_PORT: String(port), ...pdfBrowserEnv() },
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
  browser = await chromium.launch({
    headless: process.env.E2E_HEADED !== "1",
    // 系统没设 UTF-8 语言环境时（容器、CI），Chromium 会把中文下载文件名换成 "download"
    env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" },
  });

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
    // perf-001：停手 5 秒才自动保存，2 秒时应还没存
    await page.waitForTimeout(2000);
    expect((await page.locator(".save-state--dirty").count()) === 1, "停手 2 秒时不应已经自动保存");
    await page.locator(".save-state--saved").waitFor({ timeout: 8000 });
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

  await step("只改正文时一次保存只发 1 个请求；加了标签才刷新左栏", async () => {
    const seen = [];
    const record = (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/events") seen.push(`${req.method()} ${url.pathname}`);
    };
    const ta = page.locator(".editor__textarea");
    await ta.click();
    await page.keyboard.press("Control+End");
    page.on("request", record);
    await page.keyboard.type("\n只改正文");
    await page.keyboard.press("Control+s");
    await page.locator(".save-state--saved").waitFor({ timeout: 3000 });
    await page.waitForTimeout(1200); // 等推送通道的回声（300ms 合并窗口）到达并被忽略
    expect(
      seen.length === 1 && seen[0] === "PUT /api/notes/e2ealpha",
      `只改正文应只有 1 个保存请求，实际：${seen.join(", ") || "无"}`,
    );

    seen.length = 0;
    await page.keyboard.type(" #性能");
    const tagsRefreshed = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/tags", { timeout: 3000 });
    await page.keyboard.press("Control+s");
    await page.locator(".save-state--saved").waitFor({ timeout: 3000 });
    const tags = await (await tagsRefreshed).json();
    expect(tags.items.some((t) => t.tag === "性能"), "左栏标签应出现「性能」");
    await page.waitForTimeout(800);
    page.off("request", record);
    expect(seen.includes("GET /api/tags"), `加了标签应刷新左栏标签，实际：${seen.join(", ")}`);
    expect(!seen.includes("GET /api/backlinks/e2ealpha"), `链接没变不应刷新反链，实际：${seen.join(", ")}`);

    // 自动保存间隔变长了：切走窗口时要立刻存
    await page.keyboard.type(" 切走前");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.locator(".save-state--saved").waitFor({ timeout: 1500 });
    expect(fs.readFileSync(path.join(notesDir, "alpha.md"), "utf8").includes("切走前"), "切走窗口后应已落盘");
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

  await step("阅览模式：目录跳转、上一篇 / 下一篇、记住读到的位置、窄屏目录收起", async () => {
    const para = "这一段用来把页面撑长，方便测试滚动、目录高亮和阅读位置。".repeat(6);
    const sections = ["第一节", "第二节", "第三节"].map((h) => `## ${h}\n\n${para}\n\n${para}\n\n${para}`).join("\n\n");
    const longCode = `\`\`\`\n${"x".repeat(300)}\n\`\`\``;
    const created = await page.evaluate(
      async (body) =>
        (
          await fetch("/api/notes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "阅览测试", body }),
          })
        ).json(),
      `# 阅览测试\n\n${sections}\n\n${longCode}\n`,
    );
    expect(created.id, "应能创建阅览测试笔记");
    // 推送通道会让列表自己出现这篇（sync-001）
    await page.locator(".note-row__text", { hasText: /^阅览测试$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "阅览测试", null, {
      timeout: 5000,
    });

    await page.getByLabel("阅览模式").click();
    await page.locator(".reader").waitFor();
    const items = await page.locator(".reader__toc-item").allTextContents();
    expect(
      JSON.stringify(items) === JSON.stringify(["阅览测试", "第一节", "第二节", "第三节"]),
      `目录应为 4 项，实际 ${JSON.stringify(items)}`,
    );
    const scroller = page.locator(".reader__scroll");
    const hScroll = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(!hScroll, "长代码行应自动换行，不出横向滚动");

    await page.locator(".reader__toc-item", { hasText: "第三节" }).click();
    await page.locator(".reader__toc-item.is-active", { hasText: "第三节" }).waitFor({ timeout: 3000 });
    await page.screenshot({ path: path.join(artifacts, "07-reading.png") });

    // 读到一半退出，再进来应回到那里
    await scroller.evaluate((el) => el.scrollTo({ top: (el.scrollHeight - el.clientHeight) / 2 }));
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".reader").waitFor();
    const ratio = await scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight));
    expect(Math.abs(ratio - 0.5) < 0.05, `重新进入应回到读到的位置（约 0.5），实际 ${ratio.toFixed(3)}`);

    // 下一篇 / 上一篇：按中间列表的顺序
    const order = await page.locator(".note-row__text").allTextContents();
    const at = order.indexOf("阅览测试");
    const nextTitle = order[at + 1];
    expect(nextTitle, `列表里「阅览测试」后面应还有笔记，列表：${order.join(" / ")}`);
    await page.keyboard.press("ArrowRight");
    await page.locator(".reader__title", { hasText: nextTitle }).waitFor({ timeout: 5000 });
    await page.keyboard.press("ArrowLeft");
    await page.locator(".reader__title", { hasText: "阅览测试" }).waitFor({ timeout: 5000 });
    await page.keyboard.press("e");
    await page.locator(".reader").waitFor({ state: "detached" });

    // 窄屏：目录默认收起，点按钮才出来，页面不横向溢出
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".reader").waitFor();
    expect((await page.locator(".reader__toc").count()) === 0, "窄屏进入时目录应收起");
    await page.locator(".reader").getByLabel("目录").click();
    await page.locator(".reader__toc").waitFor();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width <= 390, `阅览模式页面宽度 ${width} 超过视口 390`);
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  await step("导出手机可读 PDF：先保存再导出，纸张 100×178mm、有书签；阅览模式里也能导出；没浏览器时改用打印", async () => {
    await page.locator(".reader").waitFor({ state: "detached" });
    const ta = page.locator(".editor__textarea");
    await ta.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n导出前刚写的一行");
    const order = [];
    const record = (req) => {
      const url = new URL(req.url());
      if (req.method() !== "GET" && url.pathname.startsWith("/api/")) order.push(`${req.method()} ${url.pathname}`);
    };
    page.on("request", record);
    await page.locator(".editor").getByLabel("导出 PDF").click();
    await page.locator(".export-dialog").waitFor();
    expect(await page.getByLabel("手机阅读").isChecked(), "默认应选手机阅读版式");
    const downloading = page.waitForEvent("download", { timeout: 30000 });
    // 生成失败时面板上会显示原因：先出现就直接报出来，不要干等超时
    const failed = page
      .locator(".export-dialog__error")
      .waitFor({ timeout: 30000 })
      .then(async () => `导出失败：${await page.locator(".export-dialog__error").textContent()}`)
      .catch(() => null);
    await page.locator(".export-dialog").getByRole("button", { name: "导出" }).click();
    const download = await Promise.race([downloading, failed.then((message) => Promise.reject(new Error(message ?? "没等到下载")))]);
    page.off("request", record);
    expect(download.suggestedFilename() === "阅览测试.pdf", `文件名应为「阅览测试.pdf」，实际 ${download.suggestedFilename()}`);
    const putAt = order.findIndex((entry) => entry.startsWith("PUT /api/notes/"));
    const exportAt = order.indexOf("POST /api/export/pdf");
    expect(putAt !== -1 && exportAt > putAt, `应先保存再导出，实际顺序：${order.join(", ")}`);
    const pdfPath = path.join(artifacts, "08-export-phone.pdf");
    await download.saveAs(pdfPath);
    const raw = fs.readFileSync(pdfPath).toString("latin1");
    expect(raw.startsWith("%PDF"), "下载的应是 PDF");
    const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(raw);
    expect(
      box && Math.abs(Number(box[1]) - 283) < 2 && Math.abs(Number(box[2]) - 505) < 2,
      `纸张应约 283×505pt（100×178mm），实际 ${box ? `${box[1]}×${box[2]}` : "读不到"}`,
    );
    expect(raw.includes("/Outlines"), "应有书签（标题目录）");
    await page.locator(".export-dialog").waitFor({ state: "detached" });
    await page.getByText("已导出：阅览测试.pdf").waitFor({ timeout: 3000 });

    // 阅览模式里打开导出面板：面板在阅览之上，Esc 先关面板、再退出阅览
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".reader").waitFor();
    await page.locator(".reader").getByLabel("导出 PDF").click();
    await page.locator(".export-dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".export-dialog").waitFor({ state: "detached" });
    expect((await page.locator(".reader").count()) === 1, "关掉导出面板后应还在阅览模式里");

    // 电脑上没有 Edge / Chrome：改用浏览器的打印对话框，版式一样
    await page.route("**/api/export/pdf", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "没找到 Edge 或 Chrome", code: "no-browser" }),
      }),
    );
    // 模拟的 503 会被浏览器记成一条资源加载错误：只在这里、只放过这一种
    const errorsBefore = pageErrors.length;
    // 无界面浏览器里打印对话框立刻结束、打印框随即被移除：出现时就记下它的内容
    await page.evaluate(() => {
      window.__printSrc = null;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLIFrameElement && node.classList.contains("print-frame")) window.__printSrc = node.srcdoc;
      }).observe(document.body, { childList: true });
    });
    await page.locator(".reader").getByLabel("导出 PDF").click();
    await page.locator(".export-dialog").getByRole("button", { name: "导出" }).click();
    await page.getByText("已打开打印对话框").waitFor({ timeout: 5000 });
    const frameHtml = await page.evaluate(() => window.__printSrc);
    expect(frameHtml && frameHtml.includes("size: 100mm 178mm"), "打印兜底应用同样的手机版式");
    await page.unroute("**/api/export/pdf");
    const during = pageErrors.splice(errorsBefore);
    pageErrors.push(...during.filter((e) => !/status of 503/.test(e)));
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
  });

  await step("回收站：过期条目自动清理，清空要二次确认，取消不删", async () => {
    const ids = [];
    for (const title of ["回收甲", "回收乙"]) {
      const created = await page.evaluate(
        async (t) =>
          (
            await fetch("/api/notes", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: t, body: "要删的" }),
            })
          ).json(),
        title,
      );
      ids.push(created.id);
    }
    for (const id of ids) {
      const status = await page.evaluate(async (i) => (await fetch(`/api/notes/${i}`, { method: "DELETE" })).status, id);
      expect(status === 200, `删除应成功，实际 ${status}`);
    }
    // 一条 40 天前进回收站的条目：打开回收站时应被自动清理
    const trashDir = path.join(dataDir, ".trash");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(trashDir, "expired-e2e.md"), "过期");
    fs.writeFileSync(path.join(trashDir, "expired-e2e.md.json"), JSON.stringify({ origPath: "expired-e2e.md", deletedAt: old }));

    await page.locator(".sidebar").getByRole("button", { name: "回收站" }).first().click();
    const rows = page.locator(".trash__item");
    await rows.first().waitFor({ timeout: 5000 });
    expect((await page.locator(".trash__item", { hasText: "expired-e2e.md" }).count()) === 0, "过期条目不应出现");
    expect(!fs.existsSync(path.join(trashDir, "expired-e2e.md")), "过期条目应已从磁盘删除");
    expect(
      (await page.locator(".trash__item", { hasText: "30 天后自动清理" }).count()) >= 2,
      "刚删的条目应显示 30 天后自动清理",
    );
    const count = await rows.count();

    const emptyBtn = page.getByRole("button", { name: "清空回收站" });
    await emptyBtn.click();
    const confirm = page.getByRole("alertdialog", { name: "确认清空回收站" });
    await confirm.waitFor();
    expect((await confirm.textContent()).includes(`${count} 篇`), "确认框应写明篇数");
    await page.screenshot({ path: path.join(artifacts, "12-trash-confirm.png") });
    await confirm.getByRole("button", { name: "取消" }).click();
    await confirm.waitFor({ state: "detached" });
    expect((await rows.count()) === count, "取消后条目都还在");

    await emptyBtn.click();
    await confirm.getByRole("button", { name: "永久删除" }).click();
    await page.getByText("回收站是空的。").waitFor({ timeout: 5000 });
    expect(await emptyBtn.isDisabled(), "空回收站时清空按钮应不可点");
    const after = await api("/api/trash");
    expect(after.items.length === 0, `清空后接口应返回空，实际 ${after.items.length}`);
    expect(fs.readdirSync(trashDir).length === 0, "回收站目录应为空");
    await page.getByRole("button", { name: "返回笔记" }).click();
    await page.locator(".trash").waitFor({ state: "detached" });
  });

  await step("在分组里新建：分组栏自动填好，可以改", async () => {
    const groupRow = page.locator(".group-row__main", { hasText: "冒烟" });
    await groupRow.click();
    await page.locator(".new-note-entry").click();
    const groupInput = page.locator(".compose__group-input");
    await groupInput.waitFor();
    expect((await groupInput.inputValue()) === "冒烟", `分组栏应预填「冒烟」，实际「${await groupInput.inputValue()}」`);
    await page.locator(".compose__title").fill("分组里新建");
    await page.keyboard.press("Control+Enter");
    await page.locator(".editor__title").waitFor();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "分组里新建", null, { timeout: 5000 });
    const list = await api("/api/notes");
    const made = list.items.find((n) => n.title === "分组里新建");
    expect(made && made.group === "冒烟", `新笔记应在「冒烟」分组，实际 ${made && made.group}`);
    expect((await page.locator(".group-row.is-active", { hasText: "冒烟" }).count()) === 1, "新建后应仍停在「冒烟」分组");

    // 误选了：改成别的分组
    await page.locator(".new-note-entry").click();
    await groupInput.waitFor();
    expect((await groupInput.inputValue()) === "冒烟", "再次新建时仍预填当前分组");
    await groupInput.fill("改过的组");
    await page.locator(".compose__title").fill("改了分组");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const after = await api("/api/notes");
    const moved = after.items.find((n) => n.title === "改了分组");
    expect(moved && moved.group === "改过的组", `改了分组后应放进「改过的组」，实际 ${moved && moved.group}`);

    // 在全部笔记下新建：分组栏是空的
    await page.locator(".sidebar").getByRole("button", { name: /全部笔记/ }).first().click();
    await page.locator(".new-note-entry").click();
    await groupInput.waitFor();
    expect((await groupInput.inputValue()) === "", "全部笔记下新建分组栏应为空");
    await page.keyboard.press("Escape");
    await page.locator(".compose").waitFor({ state: "detached" });
  });

  await step("编辑器：列表续行、Tab 缩进、Ctrl+B / Ctrl+K，Ctrl+Z 能撤回", async () => {
    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    await ta.fill("");
    await ta.focus();
    const kb = page.keyboard;
    await kb.type("- 苹果");
    await kb.press("Enter");
    await kb.type("香蕉");
    await kb.press("Enter");
    await kb.press("Tab");
    await kb.type("小香蕉");
    await kb.press("Enter");
    await kb.press("Enter"); // 空的子项：退一级
    await kb.type("橙子");
    await kb.press("Enter");
    await kb.press("Enter"); // 空的顶层项：结束列表
    await kb.type("1. 一");
    await kb.press("Enter");
    await kb.type("二");
    await kb.press("Enter");
    await kb.press("Enter");
    let value = await ta.inputValue();
    expect(
      value === "- 苹果\n- 香蕉\n  - 小香蕉\n- 橙子\n1. 一\n2. 二\n",
      `列表续行 / 缩进结果不对：${JSON.stringify(value)}`,
    );
    expect(await ta.evaluate((el) => document.activeElement === el), "按 Tab 后焦点应留在正文框");

    await kb.type("重点");
    await kb.press("Shift+ArrowLeft");
    await kb.press("Shift+ArrowLeft");
    await kb.press("Control+b");
    value = await ta.inputValue();
    expect(value.endsWith("**重点**"), `Ctrl+B 应加粗：${JSON.stringify(value)}`);
    await kb.press("Control+z");
    value = await ta.inputValue();
    expect(value.endsWith("\n重点") , `Ctrl+Z 应撤回加粗：${JSON.stringify(value)}`);

    await kb.press("End");
    await kb.type(" 链接");
    await kb.press("Shift+ArrowLeft");
    await kb.press("Shift+ArrowLeft");
    await kb.press("Control+k");
    await kb.type("https://example.com");
    value = await ta.inputValue();
    expect(value.endsWith("重点 [链接](https://example.com)"), `Ctrl+K 应生成链接：${JSON.stringify(value)}`);
    expect((await page.locator(".palette").count()) === 0, "选中文字时 Ctrl+K 不应打开搜索");
    await kb.press("Control+k");
    await page.locator(".palette").waitFor({ timeout: 3000 });
    await kb.press("Escape");
    await page.locator(".palette").waitFor({ state: "detached" });
    await page.getByText("已保存").first().waitFor({ timeout: 10000 });
  });

  await step("AI 插入 / 整篇替换后 Ctrl+Z 能撤回", async () => {
    // 用假的 AI 接口：配置显示「已配置」，生成接口直接回一段固定文字
    await page.route("**/api/config", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: { baseUrl: "", model: "mock-model", apiKeyMasked: "****", maxTokens: 1000, temperature: 0.3, configured: true },
          })
        : route.fallback(),
    );
    const sse = (text) =>
      `data: ${JSON.stringify({ delta: text })}\n\nevent: done\ndata: ${JSON.stringify({ callId: null })}\n\n`;
    await page.route("**/api/ai/continue", (route) =>
      route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse("AI 续写的一句。") }),
    );
    await page.route("**/api/ai/polish", (route) =>
      route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse("AI 润色后的全文。") }),
    );
    await page.reload();
    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    await ta.fill("原文。");
    await ta.focus();
    await page.keyboard.press("End");
    const original = await ta.inputValue();

    await page.keyboard.press("Control+j");
    const ai = page.locator("section.ai");
    await ai.getByRole("button", { name: "续写", exact: true }).click();
    await ai.locator(".ai__output", { hasText: "AI 续写的一句。" }).waitFor({ timeout: 5000 });
    await ai.getByRole("button", { name: "插入光标处" }).click();
    await page.waitForFunction(() => document.querySelector(".editor__textarea")?.value.includes("AI 续写的一句。"), null, { timeout: 3000 });
    expect((await ta.inputValue()) === `${original}AI 续写的一句。`, `应插在光标处：${JSON.stringify(await ta.inputValue())}`);
    await ta.focus();
    await page.keyboard.press("Control+z");
    expect((await ta.inputValue()) === original, `Ctrl+Z 应撤回 AI 插入：${JSON.stringify(await ta.inputValue())}`);

    await ai.getByRole("button", { name: "润色", exact: true }).click();
    await ai.locator(".ai__output", { hasText: "AI 润色后的全文。" }).waitFor({ timeout: 5000 });
    await ai.getByRole("button", { name: "整篇替换" }).click();
    await page.waitForFunction(() => document.querySelector(".editor__textarea")?.value === "AI 润色后的全文。", null, { timeout: 3000 });
    await ta.focus();
    await page.keyboard.press("Control+z");
    expect((await ta.inputValue()) === original, `Ctrl+Z 应撤回整篇替换：${JSON.stringify(await ta.inputValue())}`);
    await page.keyboard.press("Control+Shift+z");
    expect((await ta.inputValue()) === "AI 润色后的全文。", "Ctrl+Shift+Z 应重做整篇替换");
    await page.keyboard.press("Control+z");

    // 撤回后的内容要真的存到磁盘
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      async () => {
        const list = await (await fetch("/api/notes")).json();
        const item = list.items.find((n) => n.title === "改了分组");
        if (!item) return false;
        const note = await (await fetch(`/api/notes/${item.id}`)).json();
        return note.body === "原文。";
      },
      null,
      { timeout: 8000 },
    );
    await page.unroute("**/api/config");
    await page.unroute("**/api/ai/continue");
    await page.unroute("**/api/ai/polish");
  });

  await step("编辑器第二批：保持缩进、粘贴网址成链接、预览勾任务、[[ 补全、切回位置、长笔记预览防抖、分栏同步滚动", async () => {
    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    const kb = page.keyboard;
    const value = () => ta.inputValue();

    // editor-008：代码块里回车保持缩进，不续列表
    await ta.fill("");
    await ta.focus();
    await kb.type("```");
    await kb.press("Enter");
    await kb.type("    a = 1");
    await kb.press("Enter");
    await kb.type("- b");
    await kb.press("Enter");
    await kb.type("c");
    expect((await value()) === "```\n    a = 1\n    - b\nc" || (await value()) === "```\n    a = 1\n    - b\n    c", `缩进行回车应保持缩进：${JSON.stringify(await value())}`);
    expect((await value()).endsWith("\n    c"), `代码块里不续列表、保持缩进：${JSON.stringify(await value())}`);

    // editor-007：选中文字粘贴网址
    await ta.fill("看这篇文章");
    await ta.evaluate((el) => {
      el.focus();
      el.setSelectionRange(1, 3);
      const data = new DataTransfer();
      data.setData("text/plain", "https://example.com/post");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    expect((await value()) === "看[这篇](https://example.com/post)文章", `粘贴网址应变链接：${JSON.stringify(await value())}`);

    // 切到分栏
    const toolbar = page.locator(".segmented").first();
    const initialMode = await toolbar.locator("[aria-pressed=true]").getAttribute("aria-label");
    await page.getByRole("button", { name: "分栏", exact: true }).click();

    // editor-006：预览里点任务框
    await ta.fill("- [ ] 买牛奶\n- [x] 写笔记");
    const boxes = page.locator(".split__pane--preview input.task-check");
    await boxes.nth(1).waitFor();
    await boxes.first().click();
    await page.waitForFunction(() => document.querySelector(".editor__textarea")?.value === "- [x] 买牛奶\n- [x] 写笔记", null, { timeout: 3000 });
    await boxes.nth(1).click();
    await page.waitForFunction(() => document.querySelector(".editor__textarea")?.value === "- [x] 买牛奶\n- [ ] 写笔记", null, { timeout: 3000 });
    expect(await boxes.first().isChecked(), "预览里的框应跟着正文变成勾选");

    // editor-003：[[ 补全
    await ta.fill("参见 ");
    await ta.focus();
    await kb.press("End");
    await kb.type("[[阿尔");
    const menu = page.locator(".wikisuggest");
    await menu.waitFor({ timeout: 3000 });
    expect((await menu.locator(".wikisuggest__item").first().textContent()) === "阿尔法笔记", "候选第一项应是阿尔法笔记");
    await page.screenshot({ path: path.join(artifacts, "13-wikilink-suggest.png") });
    await kb.press("Enter");
    await menu.waitFor({ state: "detached" });
    expect((await value()) === "参见 [[阿尔法笔记]]", `回车应补全：${JSON.stringify(await value())}`);
    await kb.type(" 和 [[贝");
    await menu.waitFor();
    await kb.press("Escape");
    await menu.waitFor({ state: "detached" });
    await kb.type("塔");
    await page.waitForTimeout(300);
    expect((await menu.count()) === 0, "按过 Esc 的 [[ 不再弹出");
    expect((await value()).endsWith("[[贝塔"), "Esc 后照常输入");

    // perf-002：长笔记预览等停手再刷新
    const longBody = Array.from({ length: 120 }, (_, i) =>
      i % 6 === 0 ? `## 第 ${i / 6} 节` : `第 ${i} 行。`, // 短行：分栏里不折行，好按行高换算滚动位置
    ).join("\n");
    const filler = "\n" + "填充段落，用来让正文超过四万字，触发预览防抖。".repeat(1800);
    await ta.fill(longBody + filler);
    await page.waitForTimeout(700);
    // 在第一个标题末尾打一个字
    await ta.evaluate((el) => {
      el.focus();
      const end = el.value.indexOf("\n");
      el.setSelectionRange(end, end);
    });
    await kb.type("新");
    const firstHeading = page.locator(".split__pane--preview h2").first();
    const immediately = await firstHeading.textContent();
    await page.waitForFunction(() => document.querySelector(".split__pane--preview h2")?.textContent === "第 0 节新", null, { timeout: 3000 }).catch(() => undefined);
    const later = await firstHeading.textContent();
    expect(immediately === "第 0 节" && later === "第 0 节新", `长笔记预览应停手后再更新（立即=${immediately}，之后=${later}）`);
    await kb.press("Backspace");

    // editor-004：分栏同步滚动——编辑区滚到「第 12 节」那一行，预览里的该标题应在顶部附近
    await page.waitForTimeout(700);
    const delta = await page.evaluate(async () => {
      const el = document.querySelector(".editor__textarea");
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      el.scrollTop = 72 * lineHeight; // 第 72 行 = 第 12 节标题
      el.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 200));
      const pane = document.querySelector(".split__pane--preview");
      const heading = [...pane.querySelectorAll("h2")].find((h) => h.textContent === "第 12 节");
      return heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
    expect(Math.abs(delta) < 40, `预览里「第 12 节」应在顶部附近，实际偏差 ${delta.toFixed(1)}px`);
    await page.screenshot({ path: path.join(artifacts, "14-split-sync.png") });

    // editor-005：切到别的笔记再回来，光标和滚动位置还在
    const before = await ta.evaluate((el) => {
      el.focus();
      el.setSelectionRange(500, 510);
      el.scrollTop = 900;
      return { start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop };
    });
    await page.locator(".note-row__text", { hasText: /^阿尔法笔记$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "阿尔法笔记", null, { timeout: 5000 });
    expect((await ta.evaluate((el) => el.scrollTop)) === 0, "另一篇应从头开始");
    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const after = await ta.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }));
    expect(
      after.start === before.start && after.end === before.end && Math.abs(after.top - before.top) < 2,
      `切回来位置应恢复：之前 ${JSON.stringify(before)}，之后 ${JSON.stringify(after)}`,
    );

    // 收尾：正文改短，视图切回原来的
    await ta.fill("编辑器第二批测试完成。");
    await page.getByRole("button", { name: initialMode, exact: true }).click();
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").first().waitFor({ timeout: 10000 });
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
