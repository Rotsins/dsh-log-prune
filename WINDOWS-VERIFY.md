# Windows 桌面端验证 · 对接清单

这次要在 Windows 上验证两个包：

- `dsh-toolbox-0.2.1.3.tgz`（前置插件，必须先装）
- `dsh-log-prune-0.2.18.2.tgz`（裁切插件，依赖 toolbox）

下面是我需要你回传的内容。不用一次给全，按第 8 节的顺序来，做到哪一步发哪一步即可。

## 1. 环境信息

- Windows 版本（10/11、版本号）；是否管理员账户；是否开了开发者模式；
- DSH 版本（关于页/安装包版本）；安装方式（安装包还是绿色版）和安装目录；
- 数据根实际路径：`%USERPROFILE%\.dsh`、`C:\data\dsh`，还是别的；不确定就跑：

  ```cmd
  dir "%USERPROFILE%\.dsh"
  dir "C:\data\dsh"
  ```

- profile 实际目录（`profiles\web` 还是别的名字）；
- Node：`where node`、`node -v`；
- 有没有杀软/公司策略拦截脚本；DSH 用的端口（默认 3099？）。

## 2. 目录与挂载配置（脱敏后发）

- `<DSH_HOME>` 下 `plugins`、`profiles`、`state` 的目录树（截图或 `tree /L 2`）；
- `profiles\<profile>\package.json` 里 `dsh-toolbox`、`dsh-log-prune` 两行 dependencies；
- `profiles\<profile>\cordis.patch.yml` 里 `- id: toolbox`、`- id: log-prune` 两段，前后各 3 行；
- 确认两个插件目录同级；
- 确认 toolbox **没有**被加进 `dsh.profile.bundles`（它必须走 patch 层 insert）。

## 3. 安装过程

- tgz 解压到哪、目录名是什么；
- 链接方式：`link:` + `pnpm install`，还是 `mklink /J`；命令原文；
- `pnpm install` / `npm install` 输出尾部 20 行；
- 挂载方式、重启方式（托盘退出/任务管理器/其他）；
- 有没有 UAC/权限弹窗。

## 4. 启动与面板

- 启动日志里搜 `dsh-toolbox`、`log-prune` 的整段（成功或报错）；
- 本机打开 `http://127.0.0.1:<端口>/dsh-toolbox/status` 的截图；
- 工具箱悬浮球、日志裁切页签、面板五个按钮的截图；
- 面板显示的版本号（应为 toolbox `0.2.1.3`、log-prune `0.2.18.2`）；
- 「其他设置」能否展开、改时间后是否提示「其他设置已自动保存到全局」。

## 5. 离线清理（重点）

先 dry 预检，再决定真跑：

1. 点「清理」→ 预检完成卡片的截图/文本（会话数、待归档、待清 stream）；
2. 点「确认执行」后观察：
   - DSH 是否正常关闭、界面是否断开、是否自动拉起；
   - **有没有 PowerShell/CMD 黑窗**（按你的要求应该没有）；
   - 从关到拉起大约多久；
3. 清理日志：`state\offclean-runs\<runId>\run.log` 的第 1 行简报 + 最后 50 行；
4. `status.json` / `report.json`（脱敏后发）；
5. 如果失败：报错原文、是否自动回滚、`.bak-stream-*` 是否生成、DSH 是否还能启动；
6. 如果拉起失败：`DSH_EXE`、`DSH_NODE`、`DSH_RESTART_CMD` 是怎么设的；手动启动是否正常；
7. 清理期间有没有杀软拦截/权限错误。

## 6. 回传方式

- 文本直接贴；截图/日志文件发 QQ；
- 路径里的用户名可以打码，保留目录结构即可；
- 不要发 token、`access-token.json`、完整会话正文。

## 7. 我拿到后会做什么

- 把 `INSTALL.md` 的 Windows 小节里的路径换成你机器的实际路径；
- 补 `mklink /J` / `pnpm install` 的实测结果，写清是否需要管理员权限；
- 补离线清理在 Windows 的拉起方式、耗时、黑窗验证结果；
- 如果发现代码问题，先修再重新打包。

## 8. 建议顺序

1. 只装 toolbox → 重启 → 看状态页/悬浮球；
2. 再装 log-prune → 重启 → 看页签/面板；
3. 面板 dry 预检；
4. 确认没有正在跑的任务后，真跑一次清理；
5. 按第 1–5 节把结果发我。
