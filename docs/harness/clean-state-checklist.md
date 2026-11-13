# 收工自检清单

每个会话结束前逐条确认，全部勾上才算结束。

- [ ] `./init.sh` 从头跑全绿（如用了 `SKIP_E2E=1`，在进度日志里写明原因）
- [ ] `claude-progress.md` 有本次会话一节，顶部「当前已验证状态」已更新
- [ ] `feature_list.json` 的状态与实际一致：没验证过的不是 `passing`，证据已填
- [ ] 没有留下调试代码（`console.log`、`debugger`、临时文件、注释掉的大段代码）
- [ ] 没有记录的半成品步骤为零；中途停下的写进 `session-handoff.md`
- [ ] 新发现的问题已作为新条目进 `feature_list.json`
- [ ] 改了模块职责或约定的，同步更新了 `server/README.md` / `web/README.md` / `AGENTS.md`
- [ ] 已提交，下个会话可以直接 `./init.sh` 开工
