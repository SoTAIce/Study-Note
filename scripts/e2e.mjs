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
 *      → 阅览模式 → 导出 PDF → 回收站（自动清理过期、清空二次确认）→ 分组里新建 → 编辑器快捷操作 → AI 改动可撤回 → 编辑器第二批 → 粘贴图片 → 界面一批（确认框、焦点、双链、摘要）→ 左栏收起
 *      → 主题切换并记住 → 窄屏抽屉不横向溢出；全程不允许出现页面报错。
 * 截图写到 e2e-artifacts/（已 gitignore），作为验证证据。
 *
 * 需要 Playwright。云端会话已预装；本机没有时：npm i -g playwright && npx playwright install chromium
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
/**
 * 在 Node 这边轮询到条件成立（check 可以是 async）。
 * 注意：page.waitForFunction 遇到 async 判断函数不会等它的结果（Promise 本身算真，立刻返回），等落盘要用这个。
 */
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pageErrors = [];
function watch(page) {
  // 每条报错前面带上是哪一步报的：偶发的报错（比如一次 404）能直接定位到步骤
  page.on("pageerror", (e) => pageErrors.push(`[${currentStep}] ${String(e)}`));
  page.on("console", (m) => {
    // 「Failed to load resource」不带地址：附上控制台给的位置，排查时知道是哪个请求
    if (m.type() === "error") pageErrors.push(`[${currentStep}] ${m.location()?.url ? `${m.text()}（${m.location().url}）` : m.text()}`);
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

    // 宽屏（read-003）：默认「自动」，1920 宽时版心比原来最宽的 840 宽、字号放大；「满宽」接近铺满；选择记住
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".reader").waitFor();
    const paper = page.locator(".reader__paper");
    const auto = await paper.evaluate((el) => ({ w: el.getBoundingClientRect().width, font: parseFloat(getComputedStyle(el).fontSize) }));
    expect(auto.w > 1000, `自动档在 1920 宽下版心应超过 1000px，实际 ${Math.round(auto.w)}`);
    expect(auto.font > 18, `宽屏下字号应略放大，实际 ${auto.font}px`);
    expect((await page.getByRole("button", { name: "自动", exact: true }).getAttribute("aria-pressed")) === "true", "默认应是「自动」");
    await page.screenshot({ path: path.join(artifacts, "07-reading-wide.png") });
    await page.getByRole("button", { name: "满宽", exact: true }).click();
    const full = await page.evaluate(() => ({
      paper: document.querySelector(".reader__paper").getBoundingClientRect().width,
      area: document.querySelector(".reader__scroll").clientWidth,
    }));
    expect(full.paper >= full.area - 2, `满宽应铺满正文区：版心 ${Math.round(full.paper)}，正文区 ${full.area}`);
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".reader").waitFor();
    expect((await page.getByRole("button", { name: "满宽", exact: true }).getAttribute("aria-pressed")) === "true", "重新进入应记住「满宽」");
    await page.getByRole("button", { name: "自动", exact: true }).click();
    await page.keyboard.press("Escape");
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
    // test-002：在 Node 这边轮询（waitForFunction 不会等 async 判断函数的结果）
    await until(async () => {
      const item = (await api("/api/notes")).items.find((n) => n.title === "改了分组");
      return Boolean(item) && (await api(`/api/notes/${item.id}`)).body === "原文。";
    }, "撤回后的内容应存到磁盘（正文应是「原文。」）");
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

  await step("粘贴图片：存进 attachments/、插入相对路径、预览显示、Ctrl+Z 撤回；子目录笔记带 ../；不支持的类型给提示；导出里嵌入", async () => {
    // 在页面里用 canvas 画一张 48×32 的真 PNG，再模拟粘贴
    const pasteImage = (type = "image/png") =>
      page.locator(".editor__textarea").evaluate(async (el, mime) => {
        const canvas = document.createElement("canvas");
        canvas.width = 48;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#3a7bd5";
        ctx.fillRect(0, 0, 48, 32);
        const blob = mime === "image/png" ? await new Promise((r) => canvas.toBlob(r, "image/png")) : new Blob(["<svg/>"], { type: mime });
        // 浏览器给剪贴板截图起的名字就是 image.png
        const file = new File([blob], mime === "image/png" ? "image.png" : "x.svg", { type: mime });
        const data = new DataTransfer();
        data.items.add(file);
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, type);

    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    await ta.fill("看这张图：");
    await pasteImage();
    await page.waitForFunction(() => /!\[\]\(attachments\/\d{8}-\d{6}-[0-9a-f]{8}\.png\)$/.test(document.querySelector(".editor__textarea")?.value ?? ""), null, { timeout: 5000 });
    const value = await ta.inputValue();
    expect(value.startsWith("看这张图：\n![]("), `图片应另起一行：${JSON.stringify(value)}`);
    const relPath = /\((attachments\/[^)]+)\)/.exec(value)[1];
    expect(fs.existsSync(path.join(notesDir, relPath)), `磁盘上应有 ${relPath}`);

    await page.getByRole("button", { name: "分栏", exact: true }).click();
    const img = page.locator(".split__pane--preview .preview img").first();
    await img.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => (document.querySelector(".split__pane--preview .preview img")?.naturalWidth ?? 0) === 48, null, { timeout: 5000 });
    await page.screenshot({ path: path.join(artifacts, "15-image-paste.png") });

    await ta.focus();
    await page.keyboard.press("Control+z");
    expect((await ta.inputValue()) === "看这张图：", `Ctrl+Z 应撤回插入的图片：${JSON.stringify(await ta.inputValue())}`);
    await page.keyboard.press("Control+Shift+z");
    expect((await ta.inputValue()) === value, "Ctrl+Shift+Z 应重做");

    // 不支持的类型：提示，正文不动
    await pasteImage("image/svg+xml");
    await page.getByText("只支持 PNG、JPG、GIF、WebP 图片").waitFor({ timeout: 3000 });
    expect((await ta.inputValue()) === value, "不支持的图片不应改正文");

    // 导出：图片嵌成 data:
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").first().waitFor({ timeout: 10000 });
    const noteId = await page.evaluate(async () => {
      const list = await (await fetch("/api/notes")).json();
      return list.items.find((n) => n.title === "改了分组").id;
    });
    const exported = await page.evaluate(async (id) => {
      const res = await fetch("/api/export/html", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, layout: "phone" }),
      });
      return res.text();
    }, noteId);
    expect(/<img src="data:image\/png;base64,/.test(exported), "导出的 HTML 里图片应嵌成 data:");

    // 子目录（收件箱）里的笔记：插入 ../attachments/，同一张图复用同一个文件
    const captured = await page.evaluate(async () =>
      (
        await fetch("/api/capture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "收件箱里贴图" }),
        })
      ).json(),
    );
    await page.locator(".note-row__text", { hasText: /^收件箱里贴图$/ }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "收件箱里贴图", null, { timeout: 5000 });
    expect(captured.relPath.startsWith("inbox/"), "快速捕获的笔记应在 inbox/");
    await pasteImage();
    await page.waitForFunction((rel) => document.querySelector(".editor__textarea")?.value.endsWith(`![](../${rel})`), relPath, { timeout: 5000 });
    await page.waitForFunction(() => (document.querySelector(".split__pane--preview .preview img")?.naturalWidth ?? 0) === 48, null, { timeout: 5000 });
    expect(fs.readdirSync(path.join(notesDir, "attachments")).length === 1, "同一张图只存一份");

    await page.getByRole("button", { name: "只写", exact: true }).click();
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").first().waitFor({ timeout: 10000 });
  });

  await step("界面一批：任务无圆点、缺失双链淡化、分组框随内容、摘要干净、inbox/ 算收件箱、应用内确认框、弹窗焦点不跑出去", async () => {
    const body = [
      "## 清单",
      "- [x] 已完成的事",
      "- [ ] 没做的事",
      "- 普通项",
      "",
      "用 `learning_rate` 调参，见 [[分组里新建]] 和 [[还没写的笔记]]。",
      "",
      "| 甲 | 乙 |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    await page.evaluate(
      async (b) =>
        (
          await fetch("/api/notes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "界面巡检", body: b, group: "短" }),
          })
        ).json(),
      body,
    );
    await page.locator(".note-row__text", { hasText: /^界面巡检$/ }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "界面巡检", null, { timeout: 5000 });
    await page.getByRole("button", { name: "分栏", exact: true }).click();
    const preview = page.locator(".split__pane--preview .preview");
    await preview.locator("li.task-item").first().waitFor({ timeout: 5000 });

    // ui-005：任务项没有圆点，普通项照旧
    const styles = await preview.evaluate((el) =>
      Array.from(el.querySelectorAll("li")).map((li) => [li.className, getComputedStyle(li).listStyleType]),
    );
    expect(
      JSON.stringify(styles) === JSON.stringify([["task-item", "none"], ["task-item", "none"], ["", "disc"]]),
      `任务项应无圆点、普通项有圆点，实际 ${JSON.stringify(styles)}`,
    );

    // ui-006：不存在的双链带 is-missing，存在的不带
    const links = await preview.evaluate((el) =>
      Array.from(el.querySelectorAll("a.wikilink")).map((a) => [a.dataset.target, a.classList.contains("is-missing")]),
    );
    expect(
      JSON.stringify(links) === JSON.stringify([["分组里新建", false], ["还没写的笔记", true]]),
      `双链存在 / 缺失标记不对：${JSON.stringify(links)}`,
    );

    // ui-007：分组框宽度跟着组名走（一个字的组名比原来固定的 96px 窄）
    const groupWidth = await page.locator(".editor__group-input").evaluate((el) => el.getBoundingClientRect().width);
    expect(groupWidth < 96, `分组框应随内容变窄，实际 ${groupWidth}px`);

    // list-001：摘要保留行内代码文字，没有任务框和表格竖线
    const excerptText = await page.locator(".note-row", { hasText: "界面巡检" }).locator(".note-row__excerpt").textContent();
    expect(excerptText.includes("learning_rate"), `摘要应保留行内代码文字，实际「${excerptText}」`);
    expect(!/\[[ x]\]|\||---/.test(excerptText), `摘要不应有任务框 / 表格竖线，实际「${excerptText}」`);
    await page.screenshot({ path: path.join(artifacts, "16-ui-batch.png") });

    // ui-008：别的编辑器直接丢进 inbox/ 的文件（没写 type）出现在收件箱
    fs.writeFileSync(path.join(notesDir, "inbox", "外部丢进来.md"), "# 外部丢进来\n\n随手一记\n");
    await until(
      async () => ((await api("/api/notes?type=idea")).items ?? []).some((n) => n.title === "外部丢进来"),
      "丢进 inbox/ 的文件应出现在收件箱",
    );

    // a11y-001：导出弹窗里 Tab 一直停在弹窗内，关掉后焦点回到导出按钮
    const exportBtn = page.getByRole("button", { name: "导出 PDF" }).first();
    await exportBtn.click();
    await page.locator(".export-dialog").waitFor();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(i % 4 === 3 ? "Shift+Tab" : "Tab");
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest(".export-dialog")));
      expect(inside, `第 ${i + 1} 次 Tab 后焦点跑出了导出弹窗`);
    }
    await page.keyboard.press("Escape");
    await page.locator(".export-dialog").waitFor({ state: "detached" });
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "导出 PDF"),
      "关掉弹窗后焦点应回到导出按钮",
    );

    // ui-002：删除笔记用应用内确认框；Esc 取消不删，焦点默认在「取消」，Tab 不跑出去
    let nativeDialog = false;
    const onDialog = (d) => {
      nativeDialog = true;
      void d.dismiss();
    };
    page.on("dialog", onDialog);
    await page.getByRole("button", { name: "删除笔记" }).click();
    const confirmBox = page.getByRole("alertdialog", { name: "删除「界面巡检」？" });
    await confirmBox.waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent === "取消"), "默认焦点应在「取消」");
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest(".confirm-dialog"))),
      "Tab 后焦点应仍在确认框里",
    );
    await page.screenshot({ path: path.join(artifacts, "17-confirm-delete.png") });
    await page.keyboard.press("Escape");
    await confirmBox.waitFor({ state: "detached" });
    expect((await api("/api/notes")).items.some((n) => n.title === "界面巡检"), "取消后笔记应还在");

    await page.getByRole("button", { name: "删除笔记" }).click();
    await confirmBox.getByRole("button", { name: "删除" }).click();
    await confirmBox.waitFor({ state: "detached" });
    await page.getByText("已移入回收站").first().waitFor({ timeout: 5000 });
    expect(!(await api("/api/notes")).items.some((n) => n.title === "界面巡检"), "确认后笔记应已删除");

    // 删除分组也走应用内确认框；取消后分组还在
    const groupRow = page.locator(".group-row", { hasText: "改过的组" });
    await groupRow.hover();
    await groupRow.getByRole("button", { name: "删除分组：改过的组" }).click();
    const groupConfirm = page.getByRole("alertdialog", { name: "删除分组「改过的组」？" });
    await groupConfirm.waitFor();
    await groupConfirm.getByRole("button", { name: "取消" }).click();
    await groupConfirm.waitFor({ state: "detached" });
    expect((await page.locator(".group-row", { hasText: "改过的组" }).count()) === 1, "取消后分组应还在");
    page.off("dialog", onDialog);
    expect(!nativeDialog, "不应再弹浏览器原生确认框");
  });

  await step("左栏加宽，Ctrl+\\ 收起 / 展开并在刷新后保持；Ctrl+B 仍是加粗", async () => {
    const sidebarWidth = await page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.round(sidebarWidth) === 300, `左栏应加宽到 300px，实际 ${sidebarWidth}`);

    await page.locator(".note-row__text", { hasText: /^改了分组$/ }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "改了分组", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    await ta.fill("加粗这个");
    await ta.evaluate((el) => el.setSelectionRange(2, 4));
    await page.keyboard.press("Control+b");
    expect((await ta.inputValue()) === "加粗**这个**", `Ctrl+B 应加粗，实际「${await ta.inputValue()}」`);
    expect(await page.locator(".sidebar").isVisible(), "Ctrl+B 不应收起左栏");

    await page.keyboard.press("Control+Backslash");
    await page.locator(".sidebar-strip").waitFor();
    expect(!(await page.locator(".sidebar").isVisible()), "Ctrl+\\ 后左栏应收起");
    const mainLeft = await page.locator(".main").evaluate((el) => el.getBoundingClientRect().left);
    expect(mainLeft <= 60, `收起后编辑区应贴到窄边旁，实际 left=${mainLeft}`);
    await page.screenshot({ path: path.join(artifacts, "18-sidebar-collapsed.png") });

    // 窄边上的按钮能用
    await page.locator(".sidebar-strip").getByRole("button", { name: "搜索" }).click();
    await page.locator(".palette").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".palette").waitFor({ state: "detached" });

    await page.keyboard.press("Control+s");
    await page.reload();
    await page.locator(".sidebar-strip").waitFor();
    expect(!(await page.locator(".sidebar").isVisible()), "刷新后应仍是收起状态");

    await page.locator(".sidebar-strip").getByRole("button", { name: "展开左栏" }).click();
    await page.locator(".sidebar").waitFor({ state: "visible" });
    await page.locator(".sidebar").getByRole("button", { name: "收起左栏" }).click();
    await page.locator(".sidebar-strip").waitFor();
    await page.keyboard.press("Control+Backslash");
    await page.locator(".sidebar").waitFor({ state: "visible" });
    expect((await page.locator(".sidebar-strip").count()) === 0, "展开后窄边应消失");
  });

  await step("知识简卡：预览显示卡片、卡片墙筛选、今日复习翻面打分与撤回、Ctrl+Shift+R、复习记录落盘", async () => {
    const body = [
      "# 简卡测试",
      "",
      "> [!card] 梯度下降",
      "> - 沿负梯度方向更新参数",
      "> - w ← w − η·∇L(w)",
      "",
      "过拟合 :: 把训练数据的噪声也学进去",
      "",
      "用 std::vector 存的不算",
    ].join("\n");
    await page.evaluate(
      async (b) =>
        (
          await fetch("/api/notes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "简卡测试", body: b, group: "简卡组" }),
          })
        ).json(),
      body,
    );

    // 笔记预览里显示成卡片；右栏显示这篇有 2 张
    await page.locator(".note-row__text", { hasText: /^简卡测试$/ }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "简卡测试", null, { timeout: 5000 });
    const preview = page.locator(".split__pane--preview .preview");
    await preview.locator(".kcard").waitFor({ timeout: 5000 });
    expect((await preview.locator(".kcard__title").textContent()).includes("梯度下降"), "预览应显示简卡标题");
    expect((await preview.locator(".kline").count()) === 1, "一行简卡应只有 1 个（std::vector 不算）");
    await page.locator(".rail__cards").waitFor({ timeout: 5000 });
    expect((await page.locator(".rail__cards").textContent()).includes("这篇有 2 张简卡"), "右栏应显示这篇有 2 张简卡");

    // 卡片墙：按分组筛选
    await page.locator(".sidebar").getByRole("button", { name: /知识简卡/ }).click();
    await page.locator(".cards").waitFor();
    await page.getByLabel("按分组筛选").selectOption("简卡组");
    await page.waitForFunction(() => document.querySelectorAll(".kcard-tile").length === 2, null, { timeout: 5000 });
    const titles = await page.locator(".kcard-tile__title").allTextContents();
    expect(JSON.stringify(titles.sort()) === JSON.stringify(["梯度下降", "过拟合"].sort()), `卡片墙标题不对：${titles}`);
    expect((await page.locator(".kcard-tile__mastery", { hasText: "新卡" }).count()) === 2, "两张都应是新卡");
    await page.screenshot({ path: path.join(artifacts, "19-cards-wall.png") });

    // 今日复习：只复习这个分组
    await page.getByRole("button", { name: /今日复习 2 张/ }).click();
    const card = page.locator(".review-card");
    await card.waitFor();
    expect((await page.locator(".review__progress").textContent()).trim() === "0 / 2", "进度应为 0 / 2");
    expect((await page.locator(".review-card__body").count()) === 0, "翻面前不显示要点");
    await page.keyboard.press("Space");
    await page.locator(".review-card__body").waitFor();
    const nextLabels = await page.locator(".review__grade-next").allTextContents();
    expect(nextLabels.length === 4 && nextLabels[0] === "10 分钟", `四档间隔应显示，实际 ${nextLabels}`);
    await page.screenshot({ path: path.join(artifacts, "20-review-back.png") });
    const firstTitle = await page.locator(".review-card__title").textContent();
    await page.keyboard.press("3");
    await page.waitForFunction(() => document.querySelector(".review__progress")?.textContent?.trim() === "1 / 2", null, { timeout: 5000 });

    // 撤回：同一张卡回来、进度回到 0
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.querySelector(".review__progress")?.textContent?.trim() === "0 / 2", null, { timeout: 5000 });
    expect((await page.locator(".review-card__title").textContent()) === firstTitle, "撤回后应回到刚才那张卡");

    for (const grade of ["3", "4"]) {
      await page.keyboard.press("Space");
      await page.locator(".review-card__body").waitFor();
      await page.keyboard.press(grade);
      await page.waitForTimeout(200);
    }
    await page.getByText("今天的复习完成了").waitFor({ timeout: 5000 });
    expect((await page.locator(".review__done").textContent()).includes("本次复习 2 张，记住 2 张"), "结束页应显示本次复习统计");

    // 复习记录落盘：打分 3 次 + 撤回 1 次
    const logFile = path.join(dataDir, "review", "log.jsonl");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.grade).length === 3 && lines.filter((l) => l.undo).length === 1, `日志行不对：${JSON.stringify(lines)}`);

    // 回到卡片墙：两张都变成「学习中」，左栏待复习数减少
    await page.getByRole("button", { name: "回到卡片墙" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".kcard-tile__mastery--learning").length === 2, null, { timeout: 5000 });

    // Ctrl+Shift+R 从笔记页直接进入复习
    await page.locator(".sidebar").getByRole("button", { name: /全部笔记/ }).first().click();
    await page.keyboard.press("Control+Shift+R");
    await page.locator(".review").waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.locator(".cards").waitFor();
    await page.locator(".sidebar").getByRole("button", { name: /全部笔记/ }).first().click();
  });

  await step("子项目：分组下新建子项目、左栏成树、父分组包含子项目笔记、折叠刷新后保持、改父分组名子项目跟着变", async () => {
    await page.locator(".sidebar").waitFor();
    const parentRow = page.locator(".group-row:not(.group-row--child)", { hasText: "冒烟" }).first();
    await parentRow.hover();
    await parentRow.getByRole("button", { name: "在「冒烟」下新建子项目" }).click();
    await page.getByLabel("冒烟 的子项目名").fill("looprun");
    await page.keyboard.press("Enter");
    const childRow = page.locator(".group-row--child", { hasText: "looprun" });
    await childRow.waitFor({ timeout: 5000 });

    // 点子项目（进连读）再新建：分组栏预填完整的「冒烟/looprun」
    await childRow.locator(".group-row__main").click();
    await page.locator(".new-note-entry").click();
    const groupInput = page.locator(".compose__group-input");
    await groupInput.waitFor();
    expect((await groupInput.inputValue()) === "冒烟/looprun", `分组栏应预填「冒烟/looprun」，实际「${await groupInput.inputValue()}」`);
    await page.locator(".compose__title").fill("子项目里的笔记");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "子项目里的笔记", null, { timeout: 5000 });
    const made = (await api("/api/notes")).items.find((n) => n.title === "子项目里的笔记");
    expect(made && made.group === "冒烟/looprun", `新笔记应在「冒烟/looprun」，实际 ${made && made.group}`);

    // 点父分组：列表包含子项目里的笔记，并标出子项目名
    await parentRow.locator(".group-row__main").click();
    const subNote = page.locator(".note-row", { hasText: "子项目里的笔记" });
    await subNote.waitFor({ timeout: 5000 });
    expect((await subNote.locator(".note-row__group").innerText()).trim() === "looprun", "父分组列表里应标出子项目名");
    const inParent = (await api(`/api/notes?group=${encodeURIComponent("冒烟")}`)).items.map((n) => n.title);
    expect(inParent.includes("子项目里的笔记") && inParent.includes("分组里新建"), `父分组应包含子项目：${inParent.join("、")}`);
    await page.screenshot({ path: path.join(artifacts, "21-subprojects.png") });

    // 折叠子项目，刷新后仍折叠
    await page.getByRole("button", { name: "收起「冒烟」的子项目" }).click();
    await childRow.waitFor({ state: "detached" });
    await page.reload();
    await page.locator(".sidebar").waitFor();
    await page.getByRole("button", { name: "展开「冒烟」的子项目" }).waitFor();
    expect((await page.locator(".group-row--child", { hasText: "looprun" }).count()) === 0, "刷新后子项目应仍折叠");
    await page.getByRole("button", { name: "展开「冒烟」的子项目" }).click();
    await childRow.waitFor();

    // 改父分组名：子项目和里面的笔记跟着换前缀
    await parentRow.hover();
    await parentRow.getByRole("button", { name: "改分组名：冒烟" }).click();
    await page.getByLabel("新的分组名").fill("冒烟测试");
    await page.keyboard.press("Enter");
    await page.locator(".group-row:not(.group-row--child)", { hasText: "冒烟测试" }).waitFor({ timeout: 5000 });
    await childRow.waitFor();
    const renamed = (await api("/api/notes")).items.find((n) => n.title === "子项目里的笔记");
    expect(renamed && renamed.group === "冒烟测试/looprun", `改名后应为「冒烟测试/looprun」，实际 ${renamed && renamed.group}`);
  });

  await step("连读：点子项目进连读、生成目录、按目录顺序、外来章与缺章、左侧目录、本页跳转、[ ] 翻章、加入目录、新建缺章", async () => {
    const post = (url, body) =>
      page.evaluate(
        async ([u, b]) => {
          const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
          return { status: res.status, json: await res.json() };
        },
        [url, body],
      );
    const G = "冒烟测试/looprun";
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段，撑开篇幅。`).join("\n\n");
    expect((await post("/api/notes", { title: "第二章", body: `# 第二章\n\n## 小节甲\n\n${long}\n\n回看 [[子项目里的笔记]]。\n`, group: G })).status === 201, "建第二章");
    expect((await post("/api/notes", { title: "外来章", body: `别的分组里的一篇。\n\n${long}\n`, group: "冒烟测试" })).status === 201, "建外来章");

    await page.locator(".group-row--child", { hasText: "looprun" }).locator(".group-row__main").click();
    const book = page.locator(".book");
    await book.waitFor();
    await book.getByText("还没有目录").waitFor();
    const titles = () => page.locator(".book__chapter-title").allInnerTexts();
    expect(JSON.stringify(await titles()) === JSON.stringify(["子项目里的笔记", "第二章"]), `无目录时按创建时间：${await titles()}`);

    await book.getByRole("button", { name: "生成目录" }).click();
    await book.getByRole("button", { name: "编辑目录" }).waitFor({ timeout: 5000 });
    const made = await api(`/api/book?group=${encodeURIComponent(G)}`);
    expect(made.index && made.index.title === "looprun 目录", `应生成「looprun 目录」，实际 ${made.index && made.index.title}`);

    // 往目录里加一篇外来章和一篇还没写的
    const add = await post("/api/book/index", { group: G, titles: ["外来章", "还没写"], baseHash: made.index.hash });
    expect(add.status === 200, `追加目录应成功：${add.status}`);
    await page.locator(".group-row--child", { hasText: "looprun" }).locator(".group-row__main").click();
    await page.waitForFunction(() => document.querySelectorAll(".book__chapter-title").length === 4, null, { timeout: 5000 });
    expect(
      JSON.stringify(await titles()) === JSON.stringify(["子项目里的笔记", "第二章", "外来章", "还没写"]),
      `应按目录顺序：${await titles()}`,
    );
    expect((await page.locator(".book__chapter", { hasText: "外来章" }).locator(".book__from").innerText()).includes("来自 冒烟测试"), "外来章应标来源");
    expect((await page.locator(".book__chapter.is-missing", { hasText: "还没写" }).count()) === 1, "缺章应占位");

    // 左侧目录含章内小标题
    const toc = page.getByRole("navigation", { name: "连读目录" });
    await toc.getByRole("button", { name: "小节甲" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "22-book.png") });

    const scroller = page.locator(".book__scroll");
    // 滚动动画停下来再读位置（连续两次读数一样）
    const settled = async () => {
      let last = -1;
      for (let i = 0; i < 40; i += 1) {
        const now = await scroller.evaluate((el) => el.scrollTop);
        if (now === last) return now;
        last = now;
        await page.waitForTimeout(100);
      }
      return last;
    };

    // 本页跳转：第二章里的 [[子项目里的笔记]] 不离开连读
    await toc.getByRole("button", { name: "外来章" }).click();
    const atForeign = await settled();
    expect(atForeign > 200, `点目录「外来章」应滚下去，scrollTop=${atForeign}`);
    await page.locator(".book__chapter", { hasText: "第二章" }).locator("a.wikilink", { hasText: "子项目里的笔记" }).click();
    const atFirst = await settled();
    expect(atFirst < atForeign, `点书内链接应滚回第一章，scrollTop=${atFirst}`);
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    expect(focused === "子项目里的笔记", `焦点应在第一章标题上，实际「${focused}」`);
    expect(await book.isVisible(), "点书内链接应留在连读里");

    // ] 下一章、[ 上一章
    await page.keyboard.press("]");
    const atNext = await settled();
    expect(atNext > atFirst + 20, `] 应翻到下一章：${atFirst} → ${atNext}`);
    await page.keyboard.press("[");
    const atPrev = await settled();
    expect(atPrev < atNext, `[ 应翻回上一章：${atNext} → ${atPrev}`);

    // 新建缺章
    await page.locator(".book__chapter.is-missing", { hasText: "还没写" }).getByRole("button", { name: "新建" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".book__chapter.is-missing").length === 0, null, { timeout: 5000 });
    const created = (await api("/api/notes")).items.find((n) => n.title === "还没写");
    expect(created && created.group === G, `新建的缺章应在本项目：${created && created.group}`);

    // 未排入目录 → 加入目录
    expect((await post("/api/notes", { title: "后加的", body: "后加的正文", group: G })).status === 201, "建后加的");
    await page.locator(".group-row--child", { hasText: "looprun" }).locator(".group-row__main").click();
    const unlisted = page.locator(".book__chapter", { hasText: "后加的" });
    await unlisted.getByRole("button", { name: "加入目录" }).click();
    await page.locator(".book__divider").waitFor({ state: "detached", timeout: 5000 });
    const final = await api(`/api/book?group=${encodeURIComponent(G)}`);
    expect(final.chapters.map((c) => c.title).join("、") === "子项目里的笔记、第二章、外来章、还没写、后加的", `加入后目录：${final.chapters.map((c) => c.title)}`);

    // 外部编辑器改了一章：连读自己刷新
    const extPath = path.join(notesDir, final.chapters.find((c) => c.title === "后加的").path);
    fs.writeFileSync(extPath, fs.readFileSync(extPath, "utf8").replace("后加的正文", "外部改过的正文"), "utf8");
    await page.locator(".book__chapter", { hasText: "外部改过的正文" }).waitFor({ timeout: 8000 });

    // 父分组：列表顶部的「连读」
    await page.locator(".group-row:not(.group-row--child)", { hasText: "冒烟测试" }).locator(".group-row__main").click();
    await page.locator(".sidebar__list").getByRole("button", { name: "连读" }).click();
    await page.waitForFunction(() => document.querySelector(".book__title")?.textContent === "冒烟测试", null, { timeout: 5000 });
  });

  await step("连读就地编辑：双击改一章 Esc 保存、同时只编辑一章、点别处保存、外部改动走冲突、在此后新建一章、[[ 补全、任务框改源文件", async () => {
    const G = "冒烟测试/looprun";
    const bookOf = () => api(`/api/book?group=${encodeURIComponent(G)}`);
    const fileOf = async (title) => {
      const b = await bookOf();
      const ch = [...b.chapters, ...b.unlisted].find((c) => c.title === title);
      return path.join(notesDir, ch.path);
    };
    const waitFile = async (file, text, label) => {
      for (let i = 0; i < 50; i += 1) {
        if (fs.readFileSync(file, "utf8").includes(text)) return;
        await page.waitForTimeout(100);
      }
      throw new Error(`${label}：文件里没有「${text}」`);
    };
    await page.locator(".group-row--child", { hasText: "looprun" }).locator(".group-row__main").click();
    await page.locator(".book__chapter-title", { hasText: "第二章" }).waitFor();
    const chapter = (title) => page.locator(".book__chapter", { has: page.locator(".book__chapter-title", { hasText: title }) });
    const editors = page.locator(".book__editor");

    // 双击正文：这一章原地变成编辑框，光标落在双击的那一段
    await chapter("第二章").locator(".preview p", { hasText: "第 3 段，" }).dblclick();
    await editors.waitFor();
    const caretText = await editors.evaluate((el) => el.value.slice(el.selectionStart, el.selectionStart + 5));
    expect(caretText === "第 3 段", `光标应落在双击的段落，实际「${caretText}」`);
    await page.keyboard.press("End");
    await page.keyboard.type("（就地改过）");
    await page.keyboard.press("Escape");
    await editors.waitFor({ state: "detached" });
    await waitFile(await fileOf("第二章"), "第 3 段，撑开篇幅。（就地改过）", "Esc 保存");
    await chapter("第二章").getByText("（就地改过）").waitFor();

    // 同一时间只编辑一章：点另一章的「编辑」先保存当前这章
    await chapter("子项目里的笔记").getByRole("button", { name: /^编辑：/ }).click();
    await editors.waitFor();
    await page.keyboard.type("\n第一章补一句。");
    await chapter("外来章").getByRole("button", { name: /^编辑：/ }).click();
    await chapter("外来章").locator(".book__editor").waitFor();
    expect((await editors.count()) === 1, `同时只能有一个编辑框，实际 ${await editors.count()}`);
    await waitFile(await fileOf("子项目里的笔记"), "第一章补一句。", "切换章节时保存");

    // [[ 补全在就地编辑里也能用
    await page.keyboard.type("\n见 [[第二");
    await page.locator(".wikisuggest").getByRole("option", { name: "第二章" }).waitFor();
    await page.keyboard.press("Enter");
    // 点编辑框以外（本页正文里）：保存并恢复成渲染状态
    await page.locator(".book__title").click();
    await editors.waitFor({ state: "detached" });
    await waitFile(await fileOf("外来章"), "见 [[第二章]]", "点别处保存");

    // 正在编辑时外部改了这一章：停在编辑状态，提示冲突；以我的覆盖
    await chapter("后加的").getByRole("button", { name: /^编辑：/ }).click();
    await editors.waitFor();
    await page.keyboard.type("\n这里的修改");
    const extFile = await fileOf("后加的");
    fs.writeFileSync(extFile, fs.readFileSync(extFile, "utf8").replace("外部改过的正文", "外部又改了一次"), "utf8");
    await page.getByRole("alert").filter({ hasText: "这一章在别处被改过了" }).waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(artifacts, "23-book-edit.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400); // 等按钮的颜色过渡走完
    await page.screenshot({ path: path.join(artifacts, "23-book-edit-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "以我的覆盖" }).click();
    await editors.waitFor({ state: "detached" });
    await waitFile(extFile, "这里的修改", "以我的覆盖");

    // 在此后新建一章：插在第二章之后，建好直接编辑；Ctrl+S 保存
    await chapter("第二章").getByRole("button", { name: /之后新建一章/ }).click();
    await page.getByLabel("新一章的标题").fill("任务章");
    await page.keyboard.press("Enter");
    await chapter("任务章").locator(".book__editor").waitFor({ timeout: 5000 });
    const order = (await bookOf()).chapters.map((c) => c.title);
    expect(order.indexOf("任务章") === order.indexOf("第二章") + 1, `新章应在第二章之后：${order}`);
    await page.keyboard.type("\n- [ ] 待办甲");
    await page.keyboard.press("Control+s");
    await editors.waitFor({ state: "detached" });
    const taskFile = await fileOf("任务章");
    await waitFile(taskFile, "- [ ] 待办甲", "Ctrl+S 保存");

    // 任务框：点了改那一章的源文件
    await chapter("任务章").locator("input.task-check").click();
    await waitFile(taskFile, "- [x] 待办甲", "点任务框");
  });

  await step("连读整本导出 PDF：先保存正在编辑的章，封面 + 目录页，每章新起一页，书签两级，书内链接可跳", async () => {
    const G = "冒烟测试/looprun";
    await page.locator(".group-row--child", { hasText: "looprun" }).locator(".group-row__main").click();
    await page.locator(".book__chapter-title", { hasText: "第二章" }).waitFor();
    const chapter = (title) => page.locator(".book__chapter", { has: page.locator(".book__chapter-title", { hasText: title }) });
    // 正在编辑的改动要先存，导出的才是最新内容
    await chapter("外来章").getByRole("button", { name: /^编辑：/ }).click();
    await page.locator(".book__editor").waitFor();
    await page.keyboard.type("\n导出前刚写的一句");
    await page.locator(".book").getByRole("button", { name: "导出整本 PDF" }).click();
    const dialog = page.getByRole("dialog", { name: "导出整本 PDF" });
    await dialog.waitFor();
    expect((await dialog.getByText("标题下显示更新日期").count()) === 0, "整本导出不该有元信息选项");
    await dialog.getByText("A4").click();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), dialog.getByRole("button", { name: "导出" }).click()]);
    expect(download.suggestedFilename() === "looprun.pdf", `文件名应为 looprun.pdf，实际 ${download.suggestedFilename()}`);
    const pdfPath = path.join(artifacts, "24-book-export.pdf");
    await download.saveAs(pdfPath);
    const raw = fs.readFileSync(pdfPath).toString("latin1");
    expect(raw.startsWith("%PDF"), "下载的应是 PDF");
    const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(raw);
    expect(box && Math.abs(Number(box[1]) - 595) < 2, `应是 A4（595pt 宽），实际 ${box && box[1]}`);
    const b = await api(`/api/book?group=${encodeURIComponent(G)}`);
    const chapters = b.chapters.filter((c) => c.kind === "note").length;
    const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages >= chapters + 2, `每章新起一页：至少 ${chapters + 2} 页，实际 ${pages}`);
    // 书签：封面、目录、每章各一条，章下面还有小标题（第二章的「小节甲」）→ 至少章数 + 3 条；有嵌套（/Count 不止一个）
    const bookmarks = (raw.match(/\/Title\s*[(<]/g) ?? []).length - 1; // 减去文档信息里的标题
    expect(bookmarks >= chapters + 3, `书签至少 ${chapters + 3} 条，实际 ${bookmarks}`);
    expect((raw.match(/\/Count -?\d+/g) ?? []).length >= 2, "书签应有两级");
    // 书内链接：目录页每章一个，加上正文里的 [[链接]]
    const links = (raw.match(/\/Subtype\s*\/Link/g) ?? []).length;
    expect(links >= chapters, `书内链接至少 ${chapters} 个，实际 ${links}`);
    await page.getByText("已导出：looprun.pdf").waitFor({ timeout: 5000 });
    const foreign = b.chapters.find((c) => c.title === "外来章");
    expect(fs.readFileSync(path.join(notesDir, foreign.path), "utf8").includes("导出前刚写的一句"), "导出前应先保存正在编辑的章");
  });

  await step("笔记模板：面板里新建模板、子项目设默认模板、新建页预填骨架和复制成提示词、文件头记 template:、预览和连读不显示提示、Ctrl+K 找到模板", async () => {
    const G = "冒烟测试/looprun";
    // 1. 左栏底部「笔记模板」：新建一个模板，两个小节，保存后写进 data/templates.json
    await page.getByRole("button", { name: "笔记模板", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "笔记模板" });
    await panel.waitFor();
    await panel.locator(".tpl-panel__item", { hasText: "实现详情" }).waitFor();
    await panel.getByRole("button", { name: "新建模板" }).click();
    await panel.getByLabel("模板名").fill("会议纪要");
    await panel.getByLabel("第 1 节标题").fill("结论");
    await panel.getByLabel("第 1 节提示").fill("定了什么");
    await panel.getByRole("button", { name: "添加小节" }).click();
    await panel.getByLabel("第 2 节标题").fill("跟进");
    const skeleton = await panel.getByLabel("骨架预览").textContent();
    expect(skeleton === "## 结论\n<!-- 定了什么 -->\n\n## 跟进\n", `骨架预览不对：${JSON.stringify(skeleton)}`);
    await panel.getByRole("button", { name: /^保存/ }).click();
    await page.getByText("模板已保存").waitFor({ timeout: 5000 });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "templates.json"), "utf8"));
    expect(saved.templates.map((t) => t.name).join() === "实现详情,学习笔记,会议纪要", `templates.json：${JSON.stringify(saved.templates.map((t) => t.name))}`);
    await page.screenshot({ path: path.join(artifacts, "25-templates-panel.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, "25-templates-panel-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await panel.getByRole("button", { name: "关闭", exact: true }).first().click();
    await panel.waitFor({ state: "detached" });

    // 2. 子项目行上的「默认模板」：面板定位到这个组，选「实现详情」设为默认
    const childRow = page.locator(".group-row--child", { hasText: "looprun" });
    await childRow.hover();
    await childRow.getByRole("button", { name: `「${G}」的默认模板` }).click();
    await panel.getByLabel("要设默认模板的分组").waitFor();
    const picked = await panel.getByLabel("要设默认模板的分组").inputValue();
    expect(picked === G, `应预选这个子项目，实际「${picked}」`);
    await panel.getByLabel("默认模板", { exact: true }).selectOption("实现详情");
    await panel.getByRole("button", { name: "设为默认" }).click();
    await panel.getByLabel(`「${G}」的默认模板`).waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "templates.json"), "utf8")).groupDefaults[G] === "实现详情", "默认模板应落盘");

    // 3. 在这个子项目里新建：预选「实现详情」、正文预填骨架；复制成提示词
    await childRow.locator(".group-row__main").click();
    await page.locator(".book__title").waitFor();
    await page.locator(".new-note-entry").click();
    const select = page.locator("#compose-template");
    await select.waitFor();
    expect((await select.inputValue()) === "实现详情", `应预选默认模板，实际「${await select.inputValue()}」`);
    const body = await page.locator(".compose__body").inputValue();
    expect(body.startsWith("## 背景\n<!-- 为什么做、要解决什么问题 -->\n\n## 设计\n"), `正文应预填骨架：${JSON.stringify(body.slice(0, 60))}`);
    await page.locator(".compose__title").fill("模板笔记");
    await page.screenshot({ path: path.join(artifacts, "26-compose-template.png") });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.getByRole("button", { name: "复制成提示词" }).click();
    await page.getByText(/已复制提示词/).waitFor({ timeout: 5000 });
    // Windows 的剪贴板会把换行变成 \r\n
    const prompt = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    expect(prompt.startsWith("请就「模板笔记」写一篇笔记，严格按下面的结构输出："), `提示词开头不对：${prompt.slice(0, 40)}`);
    expect(prompt.includes("## 关键代码\n（文件路径 + 片段") && prompt.includes("只写「待补」"), "提示词应含小节和「待补」要求");
    // 换成「不用模板」：正文只有骨架，直接清空；再换回来又填上
    await select.selectOption("");
    expect((await page.locator(".compose__body").inputValue()) === "", "换成不用模板后骨架应清掉");
    await select.selectOption("实现详情");
    await page.locator(".compose__body").press("Control+End");
    await page.keyboard.type("\n写进去的正文");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "模板笔记", null, { timeout: 5000 });
    const made = (await api("/api/notes")).items.find((n) => n.title === "模板笔记");
    const raw = fs.readFileSync(path.join(notesDir, made.relPath), "utf8");
    expect(/^group: 冒烟测试\/looprun\ntemplate: 实现详情$/m.test(raw), `文件头应有 template:：${raw.slice(0, 200)}`);
    expect(raw.includes("## 背景\n<!-- 为什么做、要解决什么问题 -->"), "正文应是骨架");
    await page.locator(".editor__template", { hasText: "实现详情" }).waitFor();
    expect(made.excerpt === "背景 设计 关键代码 踩坑 待办 写进去的正文", `摘要不该有提示语：${made.excerpt}`);

    // 4. 预览、连读里看不到提示注释
    await page.getByRole("button", { name: "只看预览", exact: true }).click();
    const preview = page.locator(".preview").first();
    await preview.locator("h2", { hasText: "关键代码" }).waitFor();
    expect(!(await preview.textContent()).includes("为什么做"), "预览里不该显示提示注释");
    await page.getByRole("button", { name: "分栏", exact: true }).click();
    await childRow.locator(".group-row__main").click();
    await page.locator(".book__chapter-title", { hasText: "模板笔记" }).waitFor();
    expect(!(await page.locator(".book").textContent()).includes("要解决什么问题"), "连读里不该显示提示注释");
    // 连读「在此后新建一章」：模板默认是项目的默认模板
    await page
      .locator(".book__chapter", { has: page.locator(".book__chapter-title", { hasText: "第二章" }) })
      .getByRole("button", { name: /之后新建一章/ })
      .click();
    expect((await page.getByLabel("新一章用的模板").inputValue()) === "实现详情", "新建章应默认用项目的默认模板");
    await page.getByLabel("新一章的标题").press("Escape");

    // 5. Ctrl+K 输入「模板」：第一条是打开模板管理的命令
    await page.keyboard.press("Control+k");
    await page.getByLabel("搜索关键词").fill("模板");
    await page.locator(".hit--command", { hasText: "笔记模板" }).waitFor();
    await page.keyboard.press("Enter");
    await panel.waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  await step("按模板规整：粘贴大段 → 提示条 → 预览（每节收了哪几块 + 差异）→ 应用 → 撤销；模型乱回不改正文", async () => {
    // 本地假模型：只回分配方案（mode = bad 时回一句话，不是 JSON）
    let mode = "ok";
    let calls = 0;
    const stub = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        const content =
          mode === "ok"
            ? `好的：\n\`\`\`json\n${JSON.stringify({ 背景: [1], 设计: [3], drop: [0, 2] })}\n\`\`\``
            : "我觉得第一段应该放在背景里。";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    try {
      // 走真实的设置接口把应用内 AI 指向假模型；规整走真实的 /api/ai/arrange
      await page.evaluate(async (baseUrl) => {
        const res = await fetch("/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: "sk-e2e-stub", model: "stub-model" }),
        });
        if (!res.ok) throw new Error(await res.text());
      }, `http://127.0.0.1:${stub.address().port}`);
      const created = await page.evaluate(async () => {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "规整测试", body: "", template: null }),
        });
        return res.json();
      });
      await page.reload();
      // 等界面起来（左栏有笔记）再按快捷键
      await page.locator(".note-row").first().waitFor({ timeout: 8000 });
      await page.keyboard.press("Control+k");
      await page.getByLabel("搜索关键词").fill("规整测试");
      await page.locator(".hit", { hasText: "规整测试" }).first().click();
      await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "规整测试", null, { timeout: 5000 });

      // 外部 AI 的回答：小节名和模板不一样，还多了一段闲话
      const reason = "旧的主循环每一轮都重新读全部配置，笔记多了以后一轮要好几秒。".repeat(14);
      const pasted = `## 1. 背景\n\n${reason}\n\n## 2. 实现\n\n- 配置读一次后缓存\n- 只在文件变了时重读\n\n顺便一提：这个改动是周末做的。`;
      expect([...pasted].length > 400, "粘贴内容要超过 400 字");
      const ta = page.locator(".editor__textarea");
      // 模拟一次真实粘贴：先发 paste 事件，应用没拦下就照浏览器默认行为插入文字
      await ta.evaluate((el, text) => {
        el.focus();
        const data = new DataTransfer();
        data.setData("text/plain", text);
        const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        if (!event.defaultPrevented) document.execCommand("insertText", false, text);
      }, pasted);
      expect((await ta.inputValue()) === pasted, "粘贴的文字应进了正文框");
      const hint = page.locator(".arrange-hint");
      await hint.waitFor({ timeout: 3000 });
      expect((await hint.textContent()).includes("要按模板规整刚粘贴的内容吗"), "这篇没有模板：提示条里让人选一个");
      expect((await hint.getByLabel("规整用的模板").inputValue()) === "实现详情", "默认选第一个模板");
      await page.waitForTimeout(300); // 等淡入动画结束
      await page.screenshot({ path: path.join(artifacts, "28-arrange-hint.png") });
      await hint.getByRole("button", { name: "规整", exact: true }).click();

      const dialog = page.getByRole("dialog", { name: "按模板规整" });
      await dialog.waitFor();
      const section = (title) => dialog.locator(".arrange__section", { has: page.locator("strong", { hasText: new RegExp(`^${title}$`) }) });
      await section("背景").locator(".arrange__blocks li").first().waitFor({ timeout: 8000 });
      expect((await section("背景").textContent()).includes("1 块"), "背景应收 1 块");
      expect((await section("设计").textContent()).includes("配置读一次后缓存"), "设计应收列表");
      expect((await section("踩坑").textContent()).includes("待补"), "没内容的小节显示待补");
      expect((await section("其他").textContent()).includes("顺便一提"), "没分配的进「其他」");
      expect((await section("换成模板标题").textContent()).includes("1. 背景"), "被丢掉的原标题要列出来");
      await dialog.locator(".diff__line--add").first().waitFor();
      // 只是预览：磁盘上还是粘贴的原样
      const notePath = path.join(notesDir, created.relPath);
      await until(async () => (await api(`/api/notes/${created.id}`)).body.includes("## 1. 背景"), "粘贴的内容应先存盘");
      expect(!fs.readFileSync(notePath, "utf8").includes("template:"), "预览阶段不该写文件头");
      await page.screenshot({ path: path.join(artifacts, "28-arrange-preview.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(artifacts, "28-arrange-preview-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });

      await dialog.getByRole("button", { name: "应用", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      const arranged = await ta.inputValue();
      expect(arranged.startsWith(`## 背景\n<!-- 为什么做、要解决什么问题 -->\n\n${reason}\n\n## 设计\n`), `规整结果开头不对：${JSON.stringify(arranged.slice(0, 80))}`);
      expect(arranged.includes("- 配置读一次后缓存\n- 只在文件变了时重读"), "列表原样搬进来");
      expect(arranged.endsWith("## 其他\n\n顺便一提：这个改动是周末做的。\n"), `结尾应是「其他」：${JSON.stringify(arranged.slice(-40))}`);
      expect(!arranged.includes("1. 背景") && !arranged.includes("2. 实现"), "原来的标题被模板标题代替");
      // 保存后：文件头补上 template:，历史里有一份「AI 改写前」
      await until(async () => {
        const note = await api(`/api/notes/${created.id}`);
        return note.meta.template === "实现详情" && note.body.startsWith("## 背景");
      }, "规整结果应存盘，文件头带 template:");
      const arrangedRaw = fs.readFileSync(notePath, "utf8");
      expect(/^template: 实现详情$/m.test(arrangedRaw), `文件头应有 template: 实现详情：${arrangedRaw.slice(0, 200)}`);
      await page.locator(".editor__template", { hasText: "实现详情" }).waitFor();
      const history = await api(`/api/notes/${created.id}/history`);
      expect(history.items.some((item) => item.reason === "ai"), `应存了一份「AI 改写前」：${JSON.stringify(history.items.map((i) => i.reason))}`);

      // 撤销：正文回到粘贴的原样，文件头的模板名也去掉
      await page.getByRole("button", { name: "撤销 AI 改写" }).click();
      expect((await ta.inputValue()) === pasted, "撤销后应回到粘贴的原样");
      await until(async () => {
        const note = await api(`/api/notes/${created.id}`);
        return !note.meta.template && note.body.startsWith("## 1. 背景");
      }, "撤销后正文和文件头都应回到规整前并存盘");

      // AI 面板入口；模型乱回：报错，正文一个字不动
      mode = "bad";
      const before = fs.readFileSync(notePath, "utf8");
      // 这一段里浏览器会把 422 记成一条资源加载错误：只放过它，别的照样算失败
      const errorsBefore = pageErrors.length;
      await page.keyboard.press("Control+j");
      await page.locator("section.ai").getByRole("button", { name: "按模板规整" }).click();
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "开始规整" }).click();
      await dialog.getByText(/规整没成功/).waitFor({ timeout: 8000 });
      expect((await dialog.textContent()).includes("笔记没有任何改动"), "失败时说明正文没动");
      expect(await dialog.getByRole("button", { name: "应用", exact: true }).isDisabled(), "失败时不能应用");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(fs.readFileSync(notePath, "utf8") === before, "模型乱回时文件不该变");
      expect((await ta.inputValue()) === pasted, "模型乱回时正文不该变");
      const during = pageErrors.splice(errorsBefore);
      pageErrors.push(...during.filter((e) => !/status of 422 .*\/api\/ai\/arrange/.test(e)));
      expect(calls === 2, `假模型应被调用 2 次，实际 ${calls}`);
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
  });

  await step("AI 生成模板：一句话描述 → 预览里改名 → 加入列表 → 让 AI 改写提示词 → 保存；新建页复制提示词带额外要求", async () => {
    // 本地假模型：按请求回模板或新的提示词
    const asked = [];
    const stub = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const messages = JSON.parse(raw).messages;
        asked.push(messages[1].content);
        const content = messages[0].content.includes('{"prompt": "额外要求"}')
          ? JSON.stringify({ prompt: "实验一节列出数据集和指标；\n结论区分作者声称的和实验证明的。" })
          : `好的：\n\`\`\`json\n${JSON.stringify({
              name: "论文阅读",
              sections: [
                { title: "问题", hint: "论文要解决什么" },
                { title: "方法", hint: "怎么做的" },
                { title: "实验", hint: "数据、对比、结论" },
              ],
              prompt: "请用中文写；方法一节要画出数据流。",
            })}\n\`\`\``;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    try {
      await page.evaluate(async (baseUrl) => {
        const res = await fetch("/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: "sk-e2e-stub", model: "stub-model" }),
        });
        if (!res.ok) throw new Error(await res.text());
      }, `http://127.0.0.1:${stub.address().port}`);
      const templatesFile = path.join(dataDir, "templates.json");
      const savedBefore = fs.readFileSync(templatesFile, "utf8");

      await page.getByRole("button", { name: "笔记模板", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "笔记模板" });
      await panel.locator(".tpl-panel__item", { hasText: "实现详情" }).waitFor();
      await panel.getByRole("button", { name: "让 AI 生成" }).click();
      const gen = page.getByRole("dialog", { name: "让 AI 生成模板" });
      await gen.waitFor();
      // 「从笔记归纳」页签：能搜到笔记、选进来（这里只看界面，生成走描述方式）
      await gen.getByRole("tab", { name: "从笔记归纳" }).click();
      await gen.getByLabel("搜索要归纳的笔记").fill("阿尔法");
      await gen.locator(".tpl-gen__hit", { hasText: "阿尔法笔记" }).click();
      await gen.locator(".tpl-gen__chip", { hasText: "阿尔法笔记" }).waitFor();
      expect((await gen.textContent()).includes("会发给你在 AI 设置里配置的服务商"), "要写明正文会发给 AI 服务商");
      await gen.getByRole("tab", { name: "一句话描述" }).click();
      await gen.getByLabel("模板描述").fill("论文阅读笔记，要能记方法和实验");
      await gen.getByRole("button", { name: /^生成$/ }).click();
      const nameInput = gen.getByLabel("生成的模板名");
      await nameInput.waitFor({ timeout: 8000 });
      expect((await nameInput.inputValue()) === "论文阅读", `模板名：${await nameInput.inputValue()}`);
      expect((await gen.getByLabel("生成的第 3 节标题").inputValue()) === "实验", "小节应来自模型");
      expect(asked.at(-1) === "想要的笔记模板：论文阅读笔记，要能记方法和实验", `发给模型的：${asked.at(-1)}`);
      const promptPreview = await gen.getByLabel("生成的提示词预览").textContent();
      expect(promptPreview.includes("## 方法\n（怎么做的）") && promptPreview.includes("这个模板的额外要求：\n请用中文写；方法一节要画出数据流。"), `提示词预览：${promptPreview}`);
      await nameInput.fill("论文精读");
      await page.screenshot({ path: path.join(artifacts, "29-template-gen.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(artifacts, "29-template-gen-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await gen.getByRole("button", { name: "加入模板列表" }).click();
      await gen.waitFor({ state: "detached" });
      await panel.locator(".tpl-panel__item.is-active", { hasText: "论文精读" }).waitFor();
      await panel.getByText("有没保存的修改").waitFor();
      expect(fs.readFileSync(templatesFile, "utf8") === savedBefore, "加入列表后、保存前不该写盘");

      // 让 AI 改写这个模板的专属提示词，结果进文本框；保存后才落盘
      const promptBox = panel.getByLabel("专属提示词");
      expect((await promptBox.inputValue()) === "请用中文写；方法一节要画出数据流。", "专属提示词应带过来");
      await panel.getByRole("button", { name: "让 AI 改写提示词" }).click();
      await page.waitForFunction(() => document.querySelector("#tpl-panel-prompt")?.value.startsWith("实验一节"), null, { timeout: 8000 });
      expect(asked.at(-1).includes("## 方法\n<!-- 怎么做的 -->"), "改写提示词时要把小节发给模型");
      expect((await panel.getByLabel("提示词预览").textContent()).includes("结论区分作者声称的和实验证明的。"), "改写后切到提示词预览");
      await panel.getByRole("button", { name: /^保存/ }).click();
      await page.getByText("模板已保存").waitFor({ timeout: 5000 });
      const saved = JSON.parse(fs.readFileSync(templatesFile, "utf8")).templates.find((t) => t.name === "论文精读");
      expect(saved && saved.sections.length === 3 && saved.prompt === "实验一节列出数据集和指标；\n结论区分作者声称的和实验证明的。", `templates.json：${JSON.stringify(saved)}`);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });

      // 新建页选这个模板，复制成提示词：固定要求之后是这个模板的额外要求
      await page.locator(".new-note-entry").click();
      const select = page.locator("#compose-template");
      await select.waitFor();
      await select.selectOption("论文精读");
      await page.locator(".compose__title").fill("某篇论文");
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      await page.getByRole("button", { name: "复制成提示词" }).click();
      await page.getByText(/已复制提示词/).waitFor({ timeout: 5000 });
      const prompt = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
      expect(
        prompt.includes("不要编造。\n\n这个模板的额外要求：\n实验一节列出数据集和指标；\n结论区分作者声称的和实验证明的。"),
        `提示词应带额外要求：${prompt.slice(-120)}`,
      );
      await page.keyboard.press("Escape");
      await page.locator(".compose__title").waitFor({ state: "detached" });
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
  });

  await step("分屏阅读：选一篇放右边、各自滚动、外部修改刷新、拖分隔条、⇄ / ×、Ctrl+点双链在另一栏、当前栏翻篇、窄窗口", async () => {
    const para = "分屏用的长段落，撑出滚动条，方便测两栏各自滚动。".repeat(8);
    const body = `# 分屏长文\n\n参见 [[分屏短文]]。\n\n${["甲", "乙", "丙"].map((h) => `## ${h}\n\n${para}\n\n${para}`).join("\n\n")}\n`;
    const make = (title, text) =>
      page.evaluate(
        async ([noteTitle, noteBody]) =>
          (
            await fetch("/api/notes", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: noteTitle, body: noteBody }),
            })
          ).json(),
        [title, text],
      );
    const created = await make("分屏长文", body);
    await make("分屏短文", "# 分屏短文\n\n回到 [[阅览测试]]。\n");
    const rightTitle = () => page.locator('.reader-pane[aria-label="右栏"] .reader-pane__title').textContent();
    const leftTitle = () => page.locator('.reader-pane[aria-label="左栏"] .reader-pane__title').textContent();
    const scrollerOf = (pane) => page.locator(`.reader-pane[aria-label="${pane}"] .reader__scroll`);

    await page.keyboard.press("Control+k");
    await page.getByLabel("搜索关键词").fill("阅览测试");
    await page.locator(".hit", { hasText: "阅览测试" }).first().click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "阅览测试", null, { timeout: 5000 });
    await page.getByLabel("阅览模式").click();
    await page.locator(".reader").waitFor();

    // 1. 「分屏」→ 选一篇放右边
    await page.getByRole("button", { name: "分屏", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选一篇放到右边" });
    await picker.getByLabel("搜索关键词").fill("分屏长文");
    await picker.locator(".hit", { hasText: "分屏长文" }).first().click();
    await page.locator('.reader-pane[aria-label="右栏"] .reader__paper').waitFor({ timeout: 5000 });
    expect((await leftTitle()) === "阅览测试" && (await rightTitle()) === "分屏长文", "左右两栏应各是一篇");
    expect((await page.locator('.reader-pane.is-active').getAttribute("aria-label")) === "右栏", "刚打开的右栏是当前栏");

    // 2. 各自滚动，互不影响
    await scrollerOf("右栏").evaluate((el) => (el.scrollTop = 600));
    await scrollerOf("左栏").evaluate((el) => (el.scrollTop = 300));
    await page.waitForTimeout(100);
    const tops = [await scrollerOf("左栏").evaluate((el) => el.scrollTop), await scrollerOf("右栏").evaluate((el) => el.scrollTop)];
    expect(Math.abs(tops[0] - 300) < 2 && Math.abs(tops[1] - 600) < 2, `两栏应各自滚动：${JSON.stringify(tops)}`);
    // 版心按这一栏自己的宽度算：半屏时正文差不多铺满这一栏（不会被压到最窄）
    const paperWidth = (await page.locator('.reader-pane[aria-label="左栏"] .reader__paper').boundingBox()).width;
    const paneWidth = (await page.locator('.reader-pane[aria-label="左栏"]').boundingBox()).width;
    expect(paperWidth > paneWidth * 0.8, `左栏版心太窄：${paperWidth}/${paneWidth}`);
    await page.screenshot({ path: path.join(artifacts, "30-split-reading.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, "30-split-reading-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // 3. 右栏那篇在外面被改：自动刷新
    const rightFile = path.join(notesDir, created.relPath);
    fs.writeFileSync(rightFile, fs.readFileSync(rightFile, "utf8").replace("参见 [[分屏短文]]。", "参见 [[分屏短文]]。外部编辑器加的一句。"), "utf8");
    await page.locator('.reader-pane[aria-label="右栏"]', { hasText: "外部编辑器加的一句" }).waitFor({ timeout: 8000 });

    // 4. 拖分隔条：比例跟着变并记在本机；双击恢复一半
    const divider = page.getByRole("separator", { name: "调整左右两栏的比例" });
    const area = await page.locator(".reader__body--split").boundingBox();
    const handle = await divider.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.65, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    const dragged = Number(await divider.getAttribute("aria-valuenow"));
    expect(Math.abs(dragged - 65) <= 1, `拖到 65% 附近，实际 ${dragged}`);
    const leftWidth = (await page.locator('.reader-pane[aria-label="左栏"]').boundingBox()).width;
    expect(Math.abs(leftWidth / area.width - 0.65) < 0.02, `左栏应占 65%：${leftWidth}/${area.width}`);
    expect(Math.abs(Number(await page.evaluate(() => localStorage.getItem("study.splitRatio"))) - 0.65) < 0.011, "比例应记在本机");
    await divider.dblclick();
    expect((await divider.getAttribute("aria-valuenow")) === "50", "双击恢复各一半");
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    expect((await divider.getAttribute("aria-valuenow")) === "45", "焦点在分隔条上按 ← 调 5%");
    expect((await leftTitle()) === "阅览测试", "调分隔条时 ← 不该翻篇");

    // 5. ⇄ 交换、再换回来
    await page.getByRole("button", { name: "左右交换" }).click();
    await page.waitForFunction(() => document.querySelector('.reader-pane[aria-label="左栏"] .reader-pane__title')?.textContent === "分屏长文", null, { timeout: 5000 });
    expect((await rightTitle()) === "阅览测试", "交换后右栏是原来的左栏");
    await page.getByRole("button", { name: "左右交换" }).click();
    await page.waitForFunction(() => document.querySelector('.reader-pane[aria-label="左栏"] .reader-pane__title')?.textContent === "阅览测试", null, { timeout: 5000 });

    // 6. Ctrl+点双链：右栏点 → 左栏打开；左栏点 → 右栏打开
    await page.locator('.reader-pane[aria-label="右栏"] a.wikilink', { hasText: "分屏短文" }).click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector('.reader-pane[aria-label="左栏"] .reader-pane__title')?.textContent === "分屏短文", null, { timeout: 5000 });
    expect((await rightTitle()) === "分屏长文", "右栏不动");
    await page.locator('.reader-pane[aria-label="左栏"] a.wikilink', { hasText: "阅览测试" }).click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector('.reader-pane[aria-label="右栏"] .reader-pane__title')?.textContent === "阅览测试", null, { timeout: 5000 });
    expect((await leftTitle()) === "分屏短文", "左栏不动");

    // 7. 当前栏翻篇：点一下右栏，] / [ 只换右栏
    await page.locator('.reader-pane[aria-label="右栏"] .reader__scroll').click({ position: { x: 20, y: 200 } });
    expect((await page.locator(".reader-pane.is-active").getAttribute("aria-label")) === "右栏", "点过的右栏是当前栏");
    const before = await rightTitle();
    await page.keyboard.press("]");
    await page.waitForTimeout(400);
    if ((await rightTitle()) === before) await page.keyboard.press("[");
    await page.waitForFunction((was) => document.querySelector('.reader-pane[aria-label="右栏"] .reader-pane__title')?.textContent !== was, before, { timeout: 5000 });
    expect((await leftTitle()) === "分屏短文", "翻篇只作用于当前栏");

    // 8. 窗口太窄：只显示当前栏 + 提示；加宽恢复
    await page.setViewportSize({ width: 860, height: 860 });
    await page.locator(".reader__split-hint").waitFor();
    expect((await page.locator(".reader-pane").count()) === 1, "窄窗口只显示当前栏");
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.locator('.reader-pane[aria-label="左栏"]').waitFor();
    expect((await page.locator(".reader-pane").count()) === 2, "加宽后两栏都回来");

    // 9. × 关闭右栏；窄窗口时「分屏」按钮变灰
    const lastRight = await rightTitle();
    await page.getByRole("button", { name: "关闭右栏" }).click();
    await page.locator(".reader-pane").first().waitFor({ state: "detached" });
    await page.setViewportSize({ width: 860, height: 860 });
    await page.waitForFunction(
      () => [...document.querySelectorAll(".reader__tools button")].find((b) => b.textContent.trim() === "分屏")?.disabled === true,
      null,
      { timeout: 3000 },
    );
    expect((await page.getByRole("button", { name: "分屏", exact: true }).getAttribute("title")) === "窗口太窄，放不下两栏", "悬停说明原因");
    await page.setViewportSize({ width: 1360, height: 860 });

    // 10. 退出再进：选篇框最前面是上次在右边看的那篇，比例也还在
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
    await page.getByLabel("阅览模式").click();
    await page.getByRole("button", { name: "分屏", exact: true }).click();
    const first = picker.locator(".hit").first();
    await first.waitFor();
    expect((await first.textContent()).includes(lastRight) && (await first.textContent()).includes("上次在右边"), `第一项应是上次右栏：${await first.textContent()}`);
    // 对输入框按回车：框刚打开时焦点要等一下才进输入框
    await picker.getByLabel("搜索关键词").press("Enter");
    await page.waitForFunction((title) => document.querySelector('.reader-pane[aria-label="右栏"] .reader-pane__title')?.textContent === title, lastRight, { timeout: 5000 });
    expect((await page.getByRole("separator", { name: "调整左右两栏的比例" }).getAttribute("aria-valuenow")) === "45", "比例应还是上次的 45%");
    await page.keyboard.press("Escape");
    await page.locator(".reader").waitFor({ state: "detached" });
  });

  await step("拖 .md 导入：空白处 → 遮罩 → 框里标题与预览 → 选分组 → 导入并打开；拖到子项目行预选它；拖两个只导第一个；拖 .txt 提示", async () => {
    /** 在页面里造一次真实的拖放：dragover（看遮罩）→ drop，落点是 selector 元素的中心 */
    const dragFiles = async (selector, files, { drop = true } = {}) => {
      await page.evaluate(
        ({ selector: sel, files: list, drop: doDrop }) => {
          const target = document.querySelector(sel);
          if (!target) throw new Error(`找不到 ${sel}`);
          const rect = target.getBoundingClientRect();
          const data = new DataTransfer();
          for (const item of list) data.items.add(new File([item.content], item.name, { type: item.type }));
          const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
          target.dispatchEvent(new DragEvent("dragenter", init));
          target.dispatchEvent(new DragEvent("dragover", init));
          window.__lastDrop = () => target.dispatchEvent(new DragEvent("drop", init));
          if (doDrop) window.__lastDrop();
        },
        { selector, files, drop },
      );
    };
    const md = (name, content) => ({ name, content, type: "text/markdown" });
    const obsidian = "---\ntitle: 拖进来的笔记\naliases:\n  - 别名\ntags:\n  - 读书\ncssclass: wide\n---\n\n# 拖进来的笔记\n\n第一段。![](img/本地图.png)\n";

    // 导入的笔记引用了一张本地图片：打开它时那张图 404 是预期的（框里也提醒了），只放过这一条
    const errorsBefore = pageErrors.length;
    const dropExpectedImage404 = () => {
      const during = pageErrors.splice(errorsBefore);
      pageErrors.push(...during.filter((e) => !/status of 404 .*\/api\/files\/img\//.test(e)));
    };

    // 1. 拖到编辑页标题栏（不在任何项目上）：先看遮罩，再松手
    await page.locator(".note-row").first().waitFor();
    await page.locator(".editor__title").waitFor();
    await dragFiles(".editor__title", [md("obsidian 笔记.md", obsidian)], { drop: false });
    await page.locator(".drop-overlay", { hasText: "松开导入为新笔记" }).waitFor({ timeout: 3000 });
    await page.screenshot({ path: path.join(artifacts, "31-import-overlay.png") });
    await page.evaluate(() => window.__lastDrop());
    const dialog = page.getByRole("dialog", { name: "导入笔记" });
    await dialog.waitFor({ timeout: 3000 });
    expect((await page.locator(".drop-overlay").count()) === 0, "松手后遮罩消失");
    expect((await dialog.getByLabel("导入后的标题").inputValue()) === "拖进来的笔记", "标题取文件头 title");
    expect((await dialog.getByLabel("正文开头").textContent()).startsWith("# 拖进来的笔记"), "正文开头预览");
    const kept = await dialog.locator(".import-dialog__kept code").allTextContents();
    expect(JSON.stringify(kept) === JSON.stringify(["aliases", "tags", "cssclass"]), `保留的键：${JSON.stringify(kept)}`);
    expect((await dialog.textContent()).includes("本地图片不会一起导入"), "引用了本地图片要提醒");
    expect((await dialog.getByLabel("导入到的分组").inputValue()) === "", "没在任何分组里：预选不分组");
    await dialog.getByLabel("导入到的分组").selectOption("冒烟测试");
    await dialog.getByLabel("导入后的标题").fill("拖进来的笔记（改过）");
    await page.waitForTimeout(300); // 等弹框淡入结束
    await page.screenshot({ path: path.join(artifacts, "31-import-dialog.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, "31-import-dialog-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await dialog.getByRole("button", { name: "导入", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "拖进来的笔记（改过）", null, { timeout: 5000 });
    await page.getByText("已导入《拖进来的笔记（改过）》到「冒烟测试」").waitFor({ timeout: 3000 });
    const imported = (await api("/api/notes")).items.find((n) => n.title === "拖进来的笔记（改过）");
    const raw = fs.readFileSync(path.join(notesDir, imported.relPath), "utf8");
    for (const part of ["aliases:\n  - 别名", "tags:\n  - 读书", "cssclass: wide", "group: 冒烟测试", "title: 拖进来的笔记（改过）"]) {
      expect(raw.includes(part), `导入的文件应有「${part}」：\n${raw}`);
    }
    expect(raw.endsWith("\n# 拖进来的笔记\n\n第一段。![](img/本地图.png)\n"), "正文原样");

    dropExpectedImage404();

    // 2. 拖到左栏子项目行：遮罩写这个项目、行高亮、框里预选它；拖两个只导第一个
    const row = '.group-row--child[data-drop-group="冒烟测试/looprun"]';
    await page.locator(row).waitFor();
    await dragFiles(row, [md("第一个.md", "# 第一个\n\n内容一\n"), md("第二个.md", "# 第二个\n")], { drop: false });
    await page.locator(".drop-overlay", { hasText: "松开导入到「冒烟测试/looprun」" }).waitFor({ timeout: 3000 });
    expect((await page.locator(`${row}.is-drop-target`).count()) === 1, "指针下的项目行要高亮");
    await page.evaluate(() => window.__lastDrop());
    await dialog.waitFor();
    expect((await dialog.getByLabel("导入到的分组").inputValue()) === "冒烟测试/looprun", "拖到项目上：预选这个项目");
    expect((await dialog.getByLabel("导入后的标题").inputValue()) === "第一个", "只导第一个");
    expect((await dialog.textContent()).includes("一次只导一个，这次导入《第一个.md》，另外 1 个没有导入"), "要说明只导了一个");
    await dialog.getByRole("button", { name: "导入", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "第一个", null, { timeout: 5000 });
    const first = (await api("/api/notes")).items.find((n) => n.title === "第一个");
    expect(first && first.group === "冒烟测试/looprun", `应进了子项目：${JSON.stringify(first)}`);
    expect(!(await api("/api/notes")).items.some((n) => n.title === "第二个"), "第二个不该导入");

    // 3. 拖到正文框上的 .md 也走导入（不当图片拒掉）；取消不留东西
    const countBefore = (await api("/api/notes")).items.length;
    await dragFiles(".editor__textarea", [md("拖到正文框.md", "# 拖到正文框\n")]);
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect((await api("/api/notes")).items.length === countBefore, "取消后不该多出笔记");

    // 4. 拖 .txt：提示只能导入 .md
    await dragFiles(".editor__title", [{ name: "随手记.txt", content: "x", type: "text/plain" }]);
    await page.getByText("只能导入 .md 文件").waitFor({ timeout: 3000 });
    expect((await page.locator(".drop-overlay").count()) === 0 && (await dialog.count()) === 0, "不弹框、遮罩消失");
  });

  await step("帮助：? 打开速查并筛选、输入框里 ? 不打开、Ctrl+K 找到帮助、读手册并章内跳转、生成练习笔记连读、动手改双链、删除练习笔记", async () => {
    const help = page.getByRole("dialog", { name: "帮助" });

    // 1. 不在输入框里按 ?：打开速查；筛选「复习」只剩相关的
    await page.locator(".sidebar__brand").click();
    await page.keyboard.press("?");
    await help.waitFor({ timeout: 3000 });
    expect((await help.getByRole("tab", { name: "速查" }).getAttribute("aria-selected")) === "true", "默认是速查页签");
    expect((await help.locator(".help-panel__row", { hasText: "Ctrl+Shift+R" }).count()) === 1, "速查里应有今日复习的快捷键");
    await help.getByLabel("筛选快捷键和写法").fill("复习");
    const kept = await help.locator(".help-panel__row").allTextContents();
    expect(kept.length >= 4, `筛选「复习」后应剩几行：${kept.length}`);
    expect((await help.locator('.help-panel__group[aria-label="编辑器"]').count()) === 0, "筛选后不相关的分组藏起来");
    await page.waitForTimeout(300); // 等抽屉滑入结束
    await page.screenshot({ path: path.join(artifacts, "32-help-cheat.png") });
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });

    // 2. 在输入框里按 ? 不打开；Ctrl+K 输入「快捷键」找到帮助命令
    await page.keyboard.press("Control+k");
    const search = page.getByLabel("搜索关键词");
    await search.focus();
    await page.keyboard.type("?");
    await page.waitForTimeout(200);
    expect((await help.count()) === 0, "在输入框里按 ? 不该打开帮助");
    await search.fill("快捷键");
    await page.locator(".hit--command", { hasText: "帮助" }).waitFor();
    await page.keyboard.press("Enter");
    await help.waitFor();

    // 3. 使用手册：第一章；章内 [[手册：笔记模板]] 在面板里跳过去
    await help.getByRole("tab", { name: "使用手册" }).click();
    await help.locator('.help-panel__article[aria-label="手册：新建与保存"]').waitFor({ timeout: 5000 });
    expect((await help.locator(".help-panel__chapter").count()) === 12, "目录应有 12 章");
    expect((await help.textContent()).includes("动手试试"), "每章有「动手试试」");
    await help.locator(".help-panel__article a.wikilink", { hasText: "手册：笔记模板" }).click();
    await help.locator('.help-panel__article[aria-label="手册：笔记模板"]').waitFor({ timeout: 3000 });
    expect((await help.locator(".help-panel__chapter.is-active").textContent()) === "笔记模板", "目录高亮跟着跳");
    await page.screenshot({ path: path.join(artifacts, "32-help-manual.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, "32-help-manual-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // 4. 生成练习笔记：关掉面板、打开「使用手册/练习」的连读，12 章按目录顺序
    await help.getByRole("button", { name: "生成练习笔记" }).click();
    await help.waitFor({ state: "detached" });
    await page.getByText("已生成 13 篇练习笔记").waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".book__title")?.textContent === "练习", null, { timeout: 5000 });
    const chapters = await page.locator(".book__chapter-title").allTextContents();
    expect(chapters.length === 12 && chapters[0] === "手册：新建与保存" && chapters[11] === "手册：一键启动与更新", `连读章节：${JSON.stringify(chapters)}`);
    const practice = (await api(`/api/notes?group=${encodeURIComponent("使用手册/练习")}`)).items;
    expect(practice.length === 13, `练习笔记应有 13 篇（含目录）：${practice.length}`);

    // 5. 动手试试：在练习笔记里把一行改成双链，预览里成了能点的链接
    const md = practice.find((n) => n.title === "手册：Markdown、双链与标签");
    await page.keyboard.press("Control+k");
    await page.getByLabel("搜索关键词").fill("双链与标签");
    await page.locator(".hit", { hasText: "手册：Markdown、双链与标签" }).first().click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "手册：Markdown、双链与标签", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    const before = await ta.inputValue();
    expect(before.includes("参见 手册：分组与子项目"), "练习里要改的那一行");
    await ta.fill(before.replace("参见 手册：分组与子项目", "参见 [[手册：分组与子项目]]"));
    await page.keyboard.press("Control+s");
    await page.locator(".save-state--saved").waitFor({ timeout: 5000 });
    const link = page.locator(".preview a.wikilink", { hasText: "手册：分组与子项目" }).first();
    await link.waitFor();
    expect(!(await link.getAttribute("class")).includes("is-missing"), "链到的练习笔记存在，不该是淡色");
    expect(fs.readFileSync(path.join(notesDir, md.relPath), "utf8").includes("[[手册：分组与子项目]]"), "改动应存盘");

    // 6. 左栏「帮助」→ 使用手册 → 删除练习笔记：都进回收站，左栏没了这个子项目
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await help.waitFor();
    await help.getByRole("tab", { name: "使用手册" }).click();
    await help.getByRole("button", { name: "删除练习笔记" }).click();
    const confirmBox = page.getByRole("alertdialog", { name: "删除练习笔记？" });
    await confirmBox.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByText("已把 13 篇练习笔记移进回收站").waitFor({ timeout: 5000 });
    await help.getByRole("button", { name: "生成练习笔记" }).waitFor();
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    expect((await api(`/api/notes?group=${encodeURIComponent("使用手册/练习")}`)).items.length === 0, "练习笔记应都删了");
    await page.locator('.group-row[data-drop-group="使用手册/练习"]').waitFor({ state: "detached", timeout: 5000 });
    // 刚才开着的那篇也一起删了：当成自己删的，关掉编辑器，不当外部删除再「抢救」一份进回收站
    await page.waitForTimeout(2000); // 外部删除的确认要等 1.5 秒，等过这段再查有没有多出来的
    expect((await page.locator(".editor__title").count()) === 0 || (await page.locator(".editor__title").inputValue()) !== "手册：Markdown、双链与标签", "开着的练习笔记应关掉");
    expect((await page.getByText("已在外部删除").count()) === 0, "不该提示「已在外部删除」");
    const trash = await api("/api/trash");
    const copies = trash.items.filter((item) => item.origPath === md.relPath).length;
    expect(copies === 1, `回收站里这篇应只有 1 份，实际 ${copies}`);
    const practicePaths = new Set(practice.map((n) => n.relPath));
    const trashed = trash.items.filter((item) => practicePaths.has(item.origPath)).length;
    expect(trashed === 13, `回收站里应正好有 13 篇练习笔记（每篇一份），实际 ${trashed}`);
  });

  await step("外部编辑器写的文件头（块状 tags、aliases、未知键）在应用里编辑保存后原样保留", async () => {
    const file = path.join(notesDir, "obsidian-style.md");
    const head = "---\ntitle: Obsidian 写的笔记\naliases:\n  - 黑曜石\ntags:\n  - 读书\n  - 复习\ncssclass: wide\n---\n";
    fs.writeFileSync(file, `${head}\n第一行正文\n`, "utf8");
    // 等外部编辑同步把它收进索引
    let made;
    for (let i = 0; i < 50 && !made; i += 1) {
      made = (await api("/api/notes")).items.find((n) => n.title === "Obsidian 写的笔记");
      if (!made) await page.waitForTimeout(100);
    }
    expect(made && made.tags.includes("读书") && made.tags.includes("复习"), `块状 tags 应读出来：${JSON.stringify(made && made.tags)}`);
    await page.keyboard.press("Control+k");
    await page.getByLabel("搜索关键词").fill("Obsidian 写的笔记");
    await page.locator(".hit", { hasText: "Obsidian 写的笔记" }).first().click();
    await page.waitForFunction(() => document.querySelector(".editor__title")?.value === "Obsidian 写的笔记", null, { timeout: 5000 });
    const ta = page.locator(".editor__textarea");
    await ta.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("在应用里加的一行");
    await page.keyboard.press("Control+s");
    await page.locator(".save-state--saved").waitFor({ timeout: 3000 });
    const text = fs.readFileSync(file, "utf8");
    for (const part of ["aliases:\n  - 黑曜石", "tags:\n  - 读书\n  - 复习", "cssclass: wide", "在应用里加的一行"]) {
      expect(text.includes(part), `保存后文件里应有「${part}」：\n${text}`);
    }
  });

  await step("服务换成新版本后，开着的旧页面提示「应用已更新」，可以稍后再说", async () => {
    // 正常情况（页面和服务同一份代码）不提示
    expect((await page.locator(".update-bar").count()) === 0, "代码没变时不该提示更新");
    // 另开一页，把推送通道的 hello 换成「服务的代码指纹不一样」
    const other = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    watch(other);
    await other.route("**/api/events", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body: `event: hello\ndata: ${JSON.stringify({ bootId: "e2e-new-boot", stamp: "0000000000000000" })}\n\n`,
      }),
    );
    await other.goto(base);
    const bar = other.locator(".update-bar");
    await bar.waitFor({ timeout: 5000 });
    expect((await bar.textContent()).includes("已更新到新版本"), "提示文字不对");
    await other.screenshot({ path: path.join(artifacts, "27-update-bar.png") });
    await bar.getByRole("button", { name: "稍后再说" }).click();
    await bar.waitFor({ state: "detached" });
    await other.close();
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
