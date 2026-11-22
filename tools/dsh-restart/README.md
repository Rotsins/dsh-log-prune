# tools/dsh-restart（占位）

Windows 桌面端「清理后自动重启」的配套监测工具。本轮先放占位，等 Windows 侧回传**通过测试的最终版**后补入。

## 待补文件（v6 / v3 最终版）

- `Restart-DSH.ps1`（v6：active-run.json runId 变化 + 日志解析真实 web 端口 + 主窗口驻留 2s 强杀 + ready {newPid,port,mode}）
- `Watch-RestartRequest.ps1`（v3：锁内 PID 自愈、轮询、last-ack、失败重试、ready 超时处理）
- `Restart-DSH.vbs` / `Watch-RestartRequest.vbs` / `Run-Hidden.vbs`（隐藏启动链）
- `Install-Watch-Startup.ps1`（UTF-8 BOM，ONLOGON + /RL HIGHEST + wscript 动作）
- `electron-main-restart-handshake.js`（可控壳兜底通道，version/lastAt 修复版）
- README（安装 / 卸载 / 诊断）

## 协议

见插件发布包附带的《Windows-清理重启握手协议》文档（文件格式、DSH_HOME 解析、消费步骤、隐藏执行、v6 实况）。

## 收齐后

1. 覆盖到本目录；
2. 插件 README 增加「Windows 桌面端：清理后自动重启」一节；
3. 重新打包并回传 sha256，Windows 用新包装一次确认链路不变。
