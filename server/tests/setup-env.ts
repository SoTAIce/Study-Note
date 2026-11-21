/**
 * 单元 / 接口测试的公共环境（package.json 的 test 脚本用 --import 加载）：
 * 密钥的钥匙目录（sec-001）指到临时目录，测试永远不碰真实的 %APPDATA%\StudyNotes 或 ~/.config/study-notes。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.STUDY_SECRET_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-secret-"));
  process.env.STUDY_SECRET_DIR = dir;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
