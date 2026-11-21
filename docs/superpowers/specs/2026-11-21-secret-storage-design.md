# 密钥加密存放 设计方案

日期：2026-11-21
状态：**已批准（2026-11-21）**，已完成（见第八节实现记录）
对应条目：sec-001（`feature_list.json`）

## 一、现状（调研结果）

`data/config.json` 里有三处明文密钥：

| 位置 | 是什么 | 谁读写 |
|---|---|---|
| 顶层 `apiKey` | 旧版单服务商 AI 配置的 Key | `server/ai.ts` `loadAiConfig` / `saveAiConfig` |
| `providers.items[].apiKey` | 各个 AI 服务商卡片的 Key | `server/providers/index.ts` `loadProviders` / `saveProviders` |
| `backup.appPassword` | WebDAV 应用密码 | `server/backup.ts` `loadBackupConfig` / `saveBackupConfig` |

读写都经过 `server/config.ts` 的 `readConfig` / `patchConfig`（读整个文件，浅合并写回）。

已经有的保护：

- `config.json` 不进 git；
- 不上传到 WebDAV 备份；
- 界面只拿到打码后的值（`maskSecret`）；
- AI 工具不许读 `data/` 目录。

还没防住的：

- `data` 文件夹被整个复制走（拷到 U 盘、放进 OneDrive 同步、打包发给别人）后，密钥就是明文；
- 同一台电脑上别的程序或别人随手打开 `config.json` 就能看到。

顺带发现：`server/ai.ts` 里写死了 `D:\work\paper-reader\data\config.json`，没有配置时会从那里借 Key（另一个应用的明文文件）。这次不动它，只保证借来的 Key 存进本应用时也是加密的。

## 二、已确定的需求（2026-11-21 问答）

| 问题 | 结论 |
|---|---|
| 怎么存 | **加密后存进 `config.json`，钥匙文件放在 `data` 外面的用户目录** |
| 平台 | **只用 Windows**；Mac / Linux 用同样的办法（钥匙放在用户目录、权限仅本人），主要给开发和自动测试用 |

## 三、能防什么、不能防什么（会写进 README）

**能防：**

- 只复制或同步 `data` 文件夹，比如拷到 U 盘、放进 OneDrive、打包发人：拿到的是密文，没有钥匙解不开；
- 截图、录屏、把 `config.json` 贴给别人求助时，不会露出密钥；
- 同一台电脑上的其他 Windows 账户读不到钥匙。用户目录默认只有本人和管理员能读。

**不能防：**

- 用你本人账户运行的程序。它能读到钥匙文件，就能解开密钥，这是所有「应用自己能解开」方案共同的限制；
- 管理员账户；
- 以前明文存过的痕迹。旧文件在 OneDrive 历史版本、回收站、磁盘碎片里可能还在。如果 `data` 曾经被分享或同步过，建议到服务商那里换一个新 Key。

## 四、做法

### 1. 钥匙文件

- 位置：Windows 上是 `%APPDATA%\StudyNotes\secret.key`，其他系统是 `~/.config/study-notes/secret.key`。
- 环境变量 `STUDY_SECRET_DIR` 可以改位置。测试和 E2E 一律指到临时目录，不碰真实的用户目录。
- 内容是 32 字节随机数，用 `node:crypto` 生成。
- 第一次需要存密钥时才创建：
  - 创建时用「不存在才写」（`wx`），防止两个进程同时生成两把；
  - 非 Windows 上权限设为 `0600`；
  - Windows 上继承用户目录的权限（默认只有本人和管理员能读）。
- 同一个账户下所有 `data` 目录共用这一把钥匙。

### 2. 密文格式

密钥字段仍然是字符串，只是内容换成：

```
enc:v1:<钥匙指纹 8 位>:<iv>:<tag>:<密文>
```

- 算法是 AES-256-GCM，`node:crypto` 自带，不加依赖；
- 每次加密用新的随机 iv；
- GCM 自带校验，文件被改过会解不开，不会解出乱码。

### 3. 放在哪一层：`server/config.ts`

新增一个模块 `server/secrets.ts`（加密、解密、钥匙文件），由 `config.ts` 调用。

- **读**：`readConfig` 读到文件后，把所有以 `enc:v1:` 开头的字符串解密成明文再交出去。调用方（ai、providers、backup）一行不用改。
- **写**：`patchConfig` 先读文件原文，只替换这次传进来的顶层段；段里叫 `apiKey`、`appPassword` 的字段，非空就先加密再写，其他顶层段保持原文不动。
- 解密结果在内存里缓存，按密文查，不用每次读配置都重新解。
- 同一个明文重复保存时沿用原来的密文，免得每次保存都改动文件。
- 顺手把写 `config.json` 改成原子写：先写临时文件，再改名。这样写到一半断电，文件也不会坏掉、丢掉密钥。

### 4. 旧数据自动迁移

- 服务启动时（`main.ts`）检查一遍 `config.json`，有明文密钥就加密后原子写回，在控制台打一行「已把 N 处密钥改成加密存放」。
- 不额外留明文备份，留了等于白做。

### 5. 读不出来时

钥匙文件不见了、换了电脑、或者 `config.json` 被改坏时：

- 这个密钥当作「没填」，AI 和备份会提示未配置，不会把密文当成 Key 发出去；
- 设置页（AI 服务商、备份）顶部显示一条提示：
  > 有 N 处已保存的密钥在这台电脑上解不开（钥匙文件不在或不对），请重新填写；如果有原来电脑上的 secret.key，放回 %APPDATA%\StudyNotes\ 也行。
- 新接口 `GET /api/secrets/status` 返回 `{ keyPath, unreadable }`，设置页用它显示提示和钥匙位置。
- 保存某一段设置时，这一段里解不开的旧密文会被丢掉（反正已经用不了）；没保存的其他段原样留着，钥匙文件找回后还能用。

### 6. 环境变量照旧

`STUDY_AI_KEY` 等环境变量照旧优先。（实现时发现：还没有 `config.json` 时，首次启动会把环境变量或 paper-reader 借来的 Key 记进 `config.json`，这是原有行为，`arrange-api` 测试依赖它；这次不改，只是记进去的也是密文。）

### 7. 界面

AI 服务商和备份设置里，密钥输入框下面加一行小字：

> 加密保存，钥匙在 `%APPDATA%\StudyNotes\secret.key`。换电脑时把它一起拷过去，否则要重新填。

只用 DESIGN token，浅色 / 深色都检查。

## 五、不做的

- 不接 Windows 凭据管理器 / DPAPI（问答时选了钥匙文件方案）；
- 不加主密码，也不在启动时让你输入；
- 不改 paper-reader 借 Key 的逻辑本身。

## 六、验证

**单测（`server/tests/secrets.test.ts`）：**

- 加密再解密能还原；
- 每次加密的密文都不一样；
- 被改过的密文解不开；
- 换一把钥匙解不开，返回「读不出来」而不是乱码；
- 钥匙文件只在第一次需要时创建；非 Windows 上权限是 `0600`。

**配置测试：**

- 用 `saveAiConfig`、`saveProviders`、`saveBackupConfig` 保存后，`config.json` 原文里**找不到明文**、能找到 `enc:v1:`，读出来是明文；
- 保存 AI 不会动备份段的密文，反过来也一样；
- 明文的旧配置启动迁移后变成密文，值不变；再迁移一次什么都不改；
- 钥匙文件删掉后：读出来是空、`/api/secrets/status` 报告读不出来的处数、界面拿到的打码值是空；
- 原子写：临时文件不会留在目录里。

**现有测试：**

- `ai-module`、`backup`、`providers` 相关测试原样通过；
- 测试的钥匙目录指到临时目录（在测试里设 `STUDY_SECRET_DIR`），不碰真实的用户目录。

**E2E：**

- 在设置里填一个服务商 Key 并保存，读 `config.json` 原文：没有这串明文、有 `enc:v1:`；
- 界面显示打码值和那行说明；
- 截图检查浅色 / 深色。

**CI：** Windows 上跑同一套测试，确认 `%APPDATA%` 路径和原子改名在 Windows 上正常。

## 七、工作量

- 改动主要在 `server/secrets.ts`（新）、`server/config.ts`、`server/main.ts`（迁移）、`server/api.ts`（状态接口）、两个设置组件；
- 加上测试和文档，一次会话能做完。

## 八、实现记录（2026-11-21）

和方案不同、或方案没写细、实现时定下的几处：

1. **解密结果不缓存，钥匙每次现读。** 解密一个短字符串是微秒级，钥匙文件只有几十字节。不缓存的好处是：钥匙被删掉或换掉后马上表现为「读不出来」，不会被内存里的旧值掩盖。测试也靠这一点。
2. **按字段名识别密钥。** 任何层级叫 `apiKey` / `appPassword` 的字符串都算，没有逐个列路径。数组元素有 `id` 的按 `id` 找旧值，所以服务商换了顺序也沿用各自的密文。
3. **`patchConfig` 按文件原文合并。** 没传进来的顶层段原样写回，包括解不开的密文。保存服务商时不会冲掉 AI / 备份段里暂时解不开的密钥，钥匙找回后还能用。传进来的那一段里解不开的旧密文会被丢掉，和方案一致。
4. **钥匙文件内容不对时不覆盖，加密直接报错。** 文件可能是你放错的旧钥匙，自动覆盖会让它彻底找不回来。启动迁移遇到这种情况只打警告，配置保持原样。
5. **`server/ai.ts` 的 `loadAiConfig` 原来直接 `JSON.parse` 读 `config.json`。** 改成经 `readConfig` 读，否则旧版 AI 配置会读到密文。
6. **首次启动会把环境变量或 paper-reader 借来的 Key 记进 `config.json`。** 这是原有行为，现在记进去的也是密文。
7. **测试隔离。**
   - `package.json` 的 test 脚本多了 `--import ./server/tests/setup-env.ts`，把钥匙目录指到临时目录，不碰真实的用户目录。
   - 新测试的 hooks 放在 `describe` 里：`--test-isolation=none` 下顶层 hooks 会挂到所有文件上（别的文件也会在顶层设 `STUDY_AI_KEY`）。
   - E2E 用自己的临时钥匙目录。
8. **设置页的说明放在一处。** 服务商设置有多张卡片，说明放在弹层顶部一次，不在每张卡片下面重复；AI 网关和备份设置放在密码框下面。
