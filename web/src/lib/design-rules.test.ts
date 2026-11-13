// DESIGN.md 里能机械检查的几条规则：改样式时跑 pnpm test 就能发现越界。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "styles");
const globalCss = fs.readFileSync(path.join(stylesDir, "global.css"), "utf8");
const appCss = fs.readFileSync(path.join(stylesDir, "app.css"), "utf8");

/** 去掉注释，免得注释里的示例触发规则 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `找不到 ${selector}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`${selector} 没有闭合`);
}

function declaredVars(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

test("深色主题覆盖了浅色里所有会随主题变化的颜色 token", () => {
  const css = stripComments(globalCss);
  const light = declaredVars(block(css, ":root {"));
  const darkManual = declaredVars(block(css, ':root[data-theme="dark"]'));
  const darkSystem = declaredVars(block(css, "@media (prefers-color-scheme: dark)"));
  // 这些 token 由其他 token 推导，或与主题无关
  const shared = new Set(["--accent", "--ok", "--warn", "--danger", "--font-ui", "--font-display", "--font-read", "--font-mono", "--ease", "--press"]);
  for (const name of light) {
    if (shared.has(name) || name.startsWith("--radius")) continue;
    assert.ok(darkManual.has(name), `手动深色缺少 ${name}`);
    assert.ok(darkSystem.has(name), `跟随系统的深色缺少 ${name}`);
  }
});

test("组件样式不写死颜色值，全部走 token", () => {
  const css = stripComments(appCss);
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], `app.css 里出现了写死的颜色：${hex.join(", ")}`);
});

test("不用装饰性渐变（只允许骨架屏的加载闪光）", () => {
  const css = stripComments(appCss);
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*gradient\(/g)].map((m) => m[1].trim());
  assert.deepEqual(
    rules.filter((sel) => sel !== ".skeleton"),
    [],
    "出现了渐变；DESIGN.md 规定只用纯色表面",
  );
});

test("字重只用 400 / 600 / 700", () => {
  const css = stripComments(globalCss + appCss);
  const bad = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]).filter((w) => !["400", "600", "700"].includes(w));
  assert.deepEqual(bad, [], `出现了不允许的字重：${bad.join(", ")}`);
});
