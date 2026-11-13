# 会话交接

<!-- 会话较大或中途停下时填写；下个会话读完后可清空重写。 -->

## 现在已验证可用

- 全部现有功能 + 历史版本（hist-001）+ harness（harness-001）
- 实际跑过的验证：`./init.sh` 全绿（2026-11-13）

## 本次会话改了什么

- 代码 / 行为：无业务改动
- harness：AGENTS.md、CLAUDE.md、feature_list.json、claude-progress.md、init.sh、scripts/e2e.mjs、docs/harness/*、模块地图

## 坏掉的或未验证的

- 已知缺陷：无新增
- 未验证路径：Windows 本机运行 init.sh（只在 Linux 容器验证过）
- 下个会话的风险：无

## 下一步

- 优先级最高的未完成功能：`sync-001` 外部编辑后界面自动同步
- 为什么先做它：用户会同时用别的编辑器改笔记，现在界面不更新、保存时才撞冲突
- 怎样算通过：见 feature_list.json 中 sync-001 的 verification
- 这一步不能动的：store 的 baseHash 冲突检测语义、自动保存的并发 ref

## 命令

- 启动：`pnpm start`
- 验证：`./init.sh`
- 聚焦调试：`node --test --test-isolation=none server/tests/<模块>.test.ts`；`E2E_HEADED=1 E2E_KEEP=1 pnpm e2e`
