import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateSecrets, patchConfig, readConfig, secretStatus } from "../config.ts";
import { loadAiConfig, saveAiConfig } from "../ai.ts";
import { loadBackupConfig, saveBackupConfig } from "../backup.ts";
import { loadProviders, saveProviders } from "../providers/index.ts";
import { auditTree, openSecret, sealSecret, secretKeyPath } from "../secrets.ts";

// hooks 放在 describe 里：测试用 --test-isolation=none 同进程跑，顶层 hooks 会挂到所有文件上
describe("密钥加密存放（sec-001）", () => {
  let keyDir: string;
  let dataDir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    previousDir = process.env.STUDY_SECRET_DIR;
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-key-"));
    process.env.STUDY_SECRET_DIR = path.join(keyDir, "StudyNotes");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cfg-"));
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.STUDY_SECRET_DIR;
    else process.env.STUDY_SECRET_DIR = previousDir;
    fs.rmSync(keyDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const rawFile = () => fs.readFileSync(path.join(dataDir, "config.json"), "utf8");

  test("加密再解密能还原；每次密文都不一样；钥匙第一次加密时才生成", () => {
    assert.equal(fs.existsSync(secretKeyPath()), false);
    const a = sealSecret("sk-真的密钥-123");
    const b = sealSecret("sk-真的密钥-123");
    assert.ok(fs.existsSync(secretKeyPath()));
    assert.match(a, /^enc:v1:[0-9a-f]{8}:/);
    assert.notEqual(a, b, "每次用新的 iv");
    assert.equal(openSecret(a), "sk-真的密钥-123");
    assert.equal(openSecret(b), "sk-真的密钥-123");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(secretKeyPath()).mode & 0o777, 0o600, "钥匙文件只有本人能读");
    }
  });

  test("被改过的密文、换了钥匙、钥匙不在：都解不开，返回 null 而不是乱码", () => {
    const sealed = sealSecret("sk-abc");
    const parts = sealed.split(":");
    const data = Buffer.from(parts[5], "base64");
    data[0] ^= 0xff;
    assert.equal(openSecret([...parts.slice(0, 5), data.toString("base64")].join(":")), null, "密文被改");
    assert.equal(openSecret("enc:v1:坏的"), null);

    fs.writeFileSync(secretKeyPath(), `${Buffer.alloc(32, 7).toString("base64")}\n`);
    assert.equal(openSecret(sealed), null, "换了钥匙");
    fs.rmSync(secretKeyPath());
    assert.equal(openSecret(sealed), null, "钥匙不在");
  });

  test("钥匙文件内容不对时不覆盖它，加密直接报错", () => {
    fs.mkdirSync(path.dirname(secretKeyPath()), { recursive: true });
    fs.writeFileSync(secretKeyPath(), "不是钥匙");
    assert.throws(() => sealSecret("x"), /钥匙文件内容不对/);
    assert.equal(fs.readFileSync(secretKeyPath(), "utf8"), "不是钥匙");
  });

  test("三处密钥保存后：config.json 原文里没有明文、只有 enc:v1:，读出来是明文", () => {
    saveAiConfig(dataDir, { apiKey: "sk-legacy-plain-0001", model: "m1" });
    saveBackupConfig(dataDir, { url: "https://dav.example.com/dav/", account: "me@example.com", password: "webdav-app-pass-02" });
    saveProviders(dataDir, {
      activeId: "p1",
      items: [
        { id: "p1", kind: "openai", label: "一", baseUrl: "https://a.example.com/v1", apiKey: "sk-provider-one-03", models: ["m"], defaultModel: "m" },
        { id: "p2", kind: "anthropic", label: "二", baseUrl: "https://b.example.com", apiKey: "", models: ["m"], defaultModel: "m" },
      ],
    });
    const raw = rawFile();
    for (const plain of ["sk-legacy-plain-0001", "webdav-app-pass-02", "sk-provider-one-03"]) {
      assert.equal(raw.includes(plain), false, `${plain} 不该以明文出现`);
    }
    assert.equal((raw.match(/enc:v1:/g) ?? []).length, 3);
    assert.equal(loadAiConfig(dataDir, {})?.apiKey, "sk-legacy-plain-0001");
    assert.equal(loadBackupConfig(dataDir)?.appPassword, "webdav-app-pass-02");
    const providers = loadProviders(dataDir);
    assert.equal(providers.items.find((item) => item.id === "p1")?.apiKey, "sk-provider-one-03");
    assert.equal(providers.items.find((item) => item.id === "p2")?.apiKey, "", "空的保持空");
    assert.equal(fs.readdirSync(dataDir).some((name) => name.includes(".tmp")), false, "原子写不留临时文件");
  });

  test("明文没变就沿用原来的密文；保存 AI 不动备份段的密文，反过来也一样", () => {
    saveBackupConfig(dataDir, { url: "https://dav.example.com/dav/", account: "me@example.com", password: "pass-unchanged-1" });
    saveAiConfig(dataDir, { apiKey: "sk-unchanged-key-1" });
    const before = JSON.parse(rawFile());
    saveAiConfig(dataDir, { model: "换个模型" });
    saveBackupConfig(dataDir, { keepDays: 9 });
    const after = JSON.parse(rawFile());
    assert.equal(after.apiKey, before.apiKey, "AI Key 的密文不该变");
    assert.equal(after.backup.appPassword, before.backup.appPassword, "备份密码的密文不该变");
    assert.equal(after.model, "换个模型");
    assert.equal(after.backup.keepDays, 9);
  });

  test("服务商按 id 换顺序也沿用各自的密文", () => {
    const item = (id: string, apiKey: string) => ({ id, kind: "openai" as const, label: id, baseUrl: "https://x.example.com", apiKey, models: ["m"], defaultModel: "m" });
    saveProviders(dataDir, { items: [item("a", "sk-aaaa-aaaa"), item("b", "sk-bbbb-bbbb")] });
    const first = JSON.parse(rawFile()).providers.items as Array<{ id: string; apiKey: string }>;
    // 前端回传的是打码后的配置：key 为空表示沿用
    saveProviders(dataDir, { items: [item("b", ""), item("a", "")] });
    const second = JSON.parse(rawFile()).providers.items as Array<{ id: string; apiKey: string }>;
    for (const id of ["a", "b"]) {
      assert.equal(second.find((x) => x.id === id)?.apiKey, first.find((x) => x.id === id)?.apiKey, id);
    }
    assert.deepEqual(loadProviders(dataDir).items.map((x) => x.apiKey), ["sk-bbbb-bbbb", "sk-aaaa-aaaa"]);
  });

  test("迁移：明文的旧配置改成密文、值不变、其他键原样；再迁移一次什么都不改；没有密钥时不生成钥匙", () => {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ model: "m" }));
    assert.equal(migrateSecrets(dataDir), 0);
    assert.equal(fs.existsSync(secretKeyPath()), false, "没有密钥不该生成钥匙");

    const legacy = {
      baseUrl: "https://api.example.com",
      apiKey: "sk-old-plaintext-key",
      model: "m",
      custom: { keep: true },
      backup: { url: "https://dav.example.com/", account: "me", appPassword: "old-plain-pass" },
      providers: { activeId: "x", items: [{ id: "x", apiKey: "sk-old-provider" }, { id: "y", apiKey: "" }] },
    };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(legacy, null, 2));
    assert.equal(migrateSecrets(dataDir), 3);
    const raw = rawFile();
    for (const plain of ["sk-old-plaintext-key", "old-plain-pass", "sk-old-provider"]) assert.equal(raw.includes(plain), false, plain);
    assert.deepEqual(readConfig(dataDir), legacy, "解密后和原来一模一样");
    assert.deepEqual(auditTree(JSON.parse(raw)), { plain: 0, unreadable: 0, sealed: 3 });

    assert.equal(migrateSecrets(dataDir), 0);
    assert.equal(rawFile(), raw, "第二次不动文件");
  });

  test("钥匙不见了：密钥当没填、状态里报几处解不开；保存别的段不会冲掉它们，找回钥匙还能用", () => {
    saveAiConfig(dataDir, { apiKey: "sk-lost-key-0001" });
    saveBackupConfig(dataDir, { url: "https://dav.example.com/dav/", account: "me@example.com", password: "lost-pass-0002" });
    const key = fs.readFileSync(secretKeyPath());
    fs.rmSync(secretKeyPath());

    assert.equal(loadAiConfig(dataDir, {}), null, "解不开等于没配置，不能把密文当 Key 发出去");
    assert.equal(loadBackupConfig(dataDir), null);
    assert.deepEqual(secretStatus(dataDir), { keyPath: secretKeyPath(), keyExists: false, unreadable: 2 });

    // 只改了服务商：AI / 备份段的密文原样留着
    patchConfig(dataDir, { providers: { activeId: "z", items: [] } });
    fs.writeFileSync(secretKeyPath(), key);
    assert.equal(loadAiConfig(dataDir, {})?.apiKey, "sk-lost-key-0001");
    assert.equal(loadBackupConfig(dataDir)?.appPassword, "lost-pass-0002");
    assert.equal(secretStatus(dataDir).unreadable, 0);
  });
});
