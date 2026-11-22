# dsh-log-prune 发布说明

## 0.2.18.2 · 2026-11-21

> 前置插件：[dsh-toolbox](https://github.com/Rotsins/dsh-toolbox) 版本 ≥ 0.2.1

### 配置与状态
- 修复配置保存时丢失注释前空格：`summaryClientPath` / `summaryApiUrl` / `archiveDir` / `mirrorDir` 曾被写成 `""# 例：...`，YAML 把注释当值，面板重复保存不断加反斜杠。新增回归测试。
- 修复成功裁切后仍残留旧 `reason: archive-missing` / `detail`：只留摘要与普通成功路径都写 `fails:0, reason:'', detail:''`。
- `summaryTrigger` 明确为兼容/面板联动字段；旧配置只写它、未写 `summaryPoint` 时自动回退到它，实际派发仍看 `summaryPoint`。文档与面板文案同步。

### 安全与跨平台
- XFF 加固：只有 TCP 对端本身是回环（本机 nginx / tailscale serve）时才读取 `X-Forwarded-For`；公网直连伪造 `100.64.x.x` 不再被当成本机。
- 补齐 Windows 隐藏窗口：`ensure-archive`、`zstd-safe`、`offline-clean` 的 taskkill/schtasks/systemctl/zstd、`rollback-stream-clean` 全部加 `windowsHide: true`。

### 测试
- toolbox 31/31；log-prune 63 单测 + 14 e2e；新增配置注释、XFF 公网直连伪造回归。

## 0.2.18.1 · 2026-11-20

### 批次 3：E5 归档逐帧流式清理（2026-11-21）
- `cleanArchiveStreams` 对带帧侧车的归档不再 `readFileSync` 整包：先按侧车校验（size/偏移，不读内容），再逐帧 `readSync` 解压；只有检测到 stream 才进第二遍，边清边写 tmp（内存 = 单帧）。
- 没有帧侧车的旧归档保留整包路径（通常很小）。
- 回归：新增 `test/archive-clean-e5.test.mjs`（带 stream / 不带 stream 两例，校验帧偏移连续、其它事件保留、无改动不重写）；真实 97MB 归档（1242 帧）dry 跑通，错误 0。

### 收尾批（2026-11-21，E1/E4/E7/凭证）
- **E1**：批帧规则抽到 `lib/frame-pack.mjs`，offline-clean 改用它；新增跨包测试，与工具箱 `frame-writer` 的产物逐字节比对（同目录没有工具箱时自动 skip）。
- **E4**：`readRawTolerantAsync` 的 worker 失败不再对 ≥8MB 文件回落「整包同步解压」，改为明确报错并提示走 CLI；小文件仍安全回落。
- **E7**：简报改存 `brief.txt`，不再「读 run.log 全文→插一行→整体重写」；面板接口读取时把 brief 拼在日志前（旧 run.log 首行简报保持兼容）。
- **凭证**：面板带 `?token=` 打开时校验通过即种 HttpOnly `dsh_tb_token`（与工具箱同名）并 302 去掉地址栏 token；`guard` 接受 cookie 作为 token 来源，刷新/同源 fetch 不再依赖 URL；iframe 内仍保留一次前端清理兜底。
- **Linux 拉起确认**：`dshProcessCount` 补 pgrep 分支，`DSH_RESTART_CMD` 与 start-exe 分支不再无条件 `verified: true`，统一等 20 秒确认。

### 低风险收尾（2026-11-21）
- **E8**：面板等 token 的超时从 1500ms 降到 300ms（同源 postMessage 是同步级延迟，手机上不再空转）。
- **手机端文案**：工具箱 403 页面补上「先设 allowRemote: true，再加 ?token=」；此前只讲 token，用户会反复在地址栏试。
- **Linux 保险丝**：rescue 的 systemd-run 加 `--collect`，单元跑完自动回收，不再留在 runtime 目录。
- **启动新鲜度检查**：从只比 index/watcher/config 三个文件，改为扫全部 `lib/*.mjs|js` 与 `bin/*.mjs`；改 zstd-safe 这类模块时提示不再失真。
- **D1/D2/D7**：`DEFAULT_FRAME_LINES`、`authState`/`requestToken`、`CATCHUP_MIN` 去掉无外部引用的 export。
- 手机端 cookie 双写：检查过 `client.js` 已不再写 `dsh_tb_token`，只剩服务端 HttpOnly 那一份，无需改。

### 每日清理的休眠/非 7×24 适配（2026-11-21）
- 补跑窗口从 6 小时收紧到 **5 分钟**：只容忍定时器抖动，不再「错过就补」。
- 新增休眠/时钟跳变检测：两次 tick 间隔超过 2 分钟即判定为恢复，当天不补跑、只记一行日志。
- 调度仍留在插件进程内（只在 DSH 活着时触发），**不安装 systemd timer / Windows 计划任务**：
  系统级定时器在用户休眠/关机时要么被跳过、要么在恢复后补跑，后者会打断刚打开电脑的用户；
  系统定时器只保留给「清理过程中 DSH 没起来」的短时死亡保险丝。
- 默认仍是关（autoClean: false），模板里写明「只建议 7×24 机器打开」。

### F7 流式解压上限（2026-11-21）
- 新增 `unzstdLimited()`：基于 fzstd 的 `Decompress` 流式累计输出，超过上限（默认 512MB / DSH_ARCHIVE_MAX_TEXT_MB）立即中止；`unzstd()` 优先走它，解码异常再回落原来的整包 fzstd / CLI / 内置链（行为不变）。
- 大文件 worker（`decompress-worker.mjs`）与工具箱单帧解压（`archive-frames.mjs`）同步改为流式带护栏，不再「整份解完再判上限」。
- 验收：真实 53.6MB 会话（解压 110.2MB）流式与整包解码逐字节一致（sha1 相同）；离线 dry-run 20 会话、错误 0；新增 `test/zstd-limit.test.mjs` 两例。

### P3 低风险子集（2026-11-21）
- **E2** `verifySessionFile` 改分段比对（2000 行/段），不再为整份会话再拼一个 `want` 字符串；保留「末尾必须有换行」的严格性。
- **E3** 残帧另存文件名带内容 sha1 前 12 位，复用改 `existsSync`；`pruneOldBackups` 顺带把 `.droppedTail-` 只留最近 5 份。
- **E9** toolbox `registerRoute` 形参改名 `routePath`，不再遮蔽模块级 `path`。
- **S-c** 新增 `test/config-keys.test.mjs`：模板占位符键集合必须等于 DEFAULTS，面板 FIELDS 必须是已知键，非 UI 键显式白名单。
- **S-d** toolbox 测试脚本改为 `node --test test/*.test.mjs`，`frame-writer.test.mjs` 在无 zstd 的 Node 上自动 skip。
- **D4–D9** 删除 0 引用代码：archive-sessions 的 zstd 三路探测残留、log-prune util 的 uniquePath/fsErrHint、semver.compareVersion、zstd-safe 的 compressLines/hasBuiltinZstd/hasZstdCli、daycut 的 shiftDay/nowHour。
- 未做（留后续）：E1 批帧交叉测试（offline-clean 无入口守卫，直接 import 会跑主流程）、E4/E5/E7/E8/E10、S-a/S-b、手机端 token/cookie 收口。

### 审查报告第四批（2026-11-21，P0/P1/P2）
- **F2** `zstd-safe` 的 vendor 动态 import 改 `pathToFileURL`：Windows 上 `import(绝对路径)` 会被当裸模块名，fzstd 永远加载不到，归档读改写只能走 CLI（Windows 默认没有）→ 全断。顺带删掉 archive-clean 里那份从未被使用的局部 fzstd 加载块。
- **F3** 默认不信任 `X-Forwarded-For`：直连部署下该头可伪造，带 `100.64.1.1` 即可绕过 allowRemote/token 与写操作 CSRF。新增 `trustProxy`（默认 false，仅反代会覆盖该头时开）；三条鉴权路径共用同一个写操作防线。
- **F5** Windows 重启任务补 `/sd`：只给 `/st` 时 schtasks 按「今天」解释，跨午夜的任务永不触发，DSH 拉不起来。
- **F8** 归档水位文件改原子写（offline-clean 两处 + archive-sessions）：半写一次等于水位账本全丢。
- **F9** ICU 探测改用「UTC 20:00 = 北京次日 04:00」跨日样本，并把结论落成模块级 TZS；small-icu 不再静默错一天。
- **F10** 每日清理的「今天」与 04:30 判定改北京时间（固定 +480），与归档/门牌同一口径，UTC 主机不再偏 8 小时。
- **F11** 归档文本缓存按条目自身字节记账：覆盖先减旧值、逐出不再整表重算、正在读的大文件不再无限占住缓存。
- **F12** 派发失败区分可重试性：systemd-run 抖动释放当日认领、隔分钟重试（最多 3 次）；脚本缺失/node 不可用仍当天不再试，避免反复关停 DSH。
- 回归：新增 F9/F10 北京时间用例；全量 41 例通过。

### 每日清理重启循环修复（2026-11-21）
- **严重**：每日离线清理的「今天已派过」只记在内存里；offline-clean 会停/拉 DSH，重启后内存清空，6 小时补跑窗口内每分钟重派一次，形成「启动→20 秒→停→再启动」的高频循环（04:34–08:03）。
- **修复**：新增 `lib/offclean-day.mjs`，改为 `state/offclean-day-<日期>.claim` 原子认领（O_EXCL，跨进程/跨重启生效）+ 同一单元在跑不派；runId 固定为 `daily-<日期>`，systemd 单元名同日唯一。判定只认「当天」，跨天不参考上一条记录（避免昨天晚跑把今天误杀掉）。
- 派发失败当天不自动重试（面板可手工派），避免失败路径再次循环。
- 定时器不再挂 `ctx.effect` 的 dispose 清理（插件重载会把定时器清掉、`FLAGS` 已置位又不再注册，导致每日清理静默停摆）。
- 回归：`test/offclean-day.test.mjs` 7 例，覆盖「同日跳过 / 20 小时内跳过 / 跨天放行 / 认领互斥」。

### 审查报告第三批（2026-11-21 凌晨，A 组）
- **B13** 更新检查改用 `semver.compareLoose`：支持四段版本与预发布标签，修复 `0.2.18.1-fix4` 被 `map(Number)` 变成 NaN→0 的误报。
- **W3** `CONFIG_PATH`/`SESSIONS_PATH` 改 `path.join`，Windows 不再出现 `C:\data\dsh/state` 混合分隔符。
- **P1** tmpdir 的 `log-prune.log` 超 5MB 滚动 `.1`（每 200 次写检查一次），不再无限增长。
- **P10** `loadConfig` 读失败做 10 秒负缓存，watcher 每 tick 不再反复 stat+read 失败；ensure/save 后主动失效。
- **P9** 会话修复不再两次全量 `JSON.stringify` 比对，改用实际改动标记，60MB 会话省数百 MB 堆。
- **O10** archive-frames 重建前校验「帧内 seq 单调不减」，不满足只报不写。
- **V3** `foldSurface` 探测失败写日志（候选路径）、`foldStatus()` 暴露状态、60 秒后允许重试，不再永久缓存 null。
- **V5** 启动能力自检加入 ICU/时区探测；small-icu 下告警，并支持 `DSH_TZ_OFFSET`（分钟）手工兜底。
- **V1（补齐）** 面板顶部显示 zstd/时区能力警告，缺 zstd 时拦住离线清理入口并说明升级办法。
- **M5** toolbox 60 秒轮询在 `document.hidden` 时暂停。
- **S7** 默认配置模板外置到 `templates/log-prune.yml.tpl`，代码只做值替换（输出与旧版逐字一致，已 diff 验证）。
- **D7/D8** 删除 client.js 的 diag 上报、/diag 路由与 STATUS_HTML 里会过期的「当前页签」文案（D6/D9 此前已落地）。
- **B1（复核）** 派发前 node 校验与 `child.on('error')` 回写 status 均已在位。
- **B2（toolbox + doctor）** droppedTail 时不再自动写回：先把残帧另存为 .droppedTail-<时间>-<pid>（同内容去重、不参与备份轮转），返回 needConfirm 与丢弃条数；doctor 面板二次确认后带 confirmDrop:true 再写。repairOrphans(sid, root, {confirmDrop})、toolbox.repair(sid, opts)、/dsh-session-doctor/repair 已打通。
- **B3（toolbox）** 修复写回改批帧：新增 `lib/frame-writer.mjs`，首帧恰好一行 session header、其余 500 行/帧；`repairOrphans`/`repairPruneSpans` 两处统一。实测 51.2MB/86610 行会话由 86610 帧降到 175 帧，打包 709ms，行数无损失。

### 审查报告 B 组（2026-11-21 凌晨）
- **O2** writeStatus 增加 lastError（失败时记原因、成功即清），面板/诊断可直接显示最近失败原因。
- **O5** 离线清理报告增加 partial/partialSessions：P5 因侧车失败跳过清理的会话不再只藏在计数里。
- **O7** 复核：log-prune 探针的 logTail 已在 toolbox 快照里整体脱敏，无需另做通道。
- **P3** frameSeqStats 改为复用外层 fd，重建侧车不再每帧 open/close。
- **P6** collectNodes 版本号由整串 join 改为数字滚动哈希，仍能识别中间节点替换。
- **P7** 修复/区间两处备份改异步 fs.promises.copyFile，不再同步阻塞事件循环。
- **P8** watcher fastLoop 在 ARMED_DIR 不存在时退避到 10 秒；toolbox 轮询此前已加 visibility。
- **S6** 锁定会话以服务端文件为唯一真源，POST 成功后才回写 localStorage 缓存。
- **R5** 列表里「已知 bad」优先于 unknown（unknown = !checked && !bad）。
### 审查报告 B 组续（M2 + S4，2026-11-21）
- **S4** toolbox 9 条路由统一改走 registerRoute，鉴权只在注册器里施加一次，新增路由不会再漏。
- **M2** 新增 lib/auth.mjs：复用 log-prune 的 state/access-token.json 与 log-prune.yml 的 allowRemote；远程可带 ?token=（页面成功后种 dsh_tb_token cookie）或 x-lp-token，回环照常放行。
- 未授权不再返回纯 forbidden：页面给可读的「仅本机可用 + 如何带 token」，API 返回 JSON。
- client.js 保持开放（只是壳脚本，不含数据）；CONFIG.md 同步更新。
- 实机修正（Tailscale/本机反代）：XFF 最后一跳为 100.64/10 或回环时视为本机，公网仍走 allowRemote + token。
- token 文件改为远程请求进来即生成；toolbox client.js 同步 cookie 并给 iframe 带 token，log-prune ui.js 接受自身 URL 的 ?token=。

### 审查报告 C 组（O1 盘点 + L4，2026-11-21）
- 新增 tools/audit-catches.mjs：扫描 lib/bin，按文件统计 catch 总数/空 catch 行号；本轮盘出 538 处 catch、243 处空 catch（log-prune 415 / toolbox 123）。
- 修掉两处「失败仍返回成功」：archive-cut 写回前备份失败改为中止（不再无备份覆盖）；/locked 写盘失败返回 500（不再回 ok:true）。
- 其余空 catch 按模块分类保留：纯清理临时文件/探测类不改，涉及数据正确性的已在前几批（B4/B17/B2 等）处理。
- L4：CONFIG.md 补充「Windows/CIFS/NFS 上 0600 不保证生效，allowRemote 只开在受信网络」；token 文件权限不是 0600 时启动打印一次告警。

### 审查报告 C 组（P4：fold 前缀重放增量化，2026-11-21）
- toolbox repair.mjs 新增 makeSurfaceWalker：按 seq 顺序推进一次，apply 语义与 DSH foldSurface 一致；checkSession 的 shadow-span 校验与 repairOrphans 的两处前缀 fold 全部改用它，O(n²) → O(n)。
- repairPruneSpans 原本就是增量实现，未再改。
- 回归：toolbox 27/27（含 prune 配对/影子范围/修复幂等用例）。

### 审查报告 C 组（S2：会话文件名适配收敛，2026-11-21）
- offline-clean 删掉自己的 sessionFileNameOf（旧排序是「zstd 优先于版本」，会选到 v4.zstd 而不是 v5 明文），统一走 lib/session-file.mjs（版本优先、同版本 zstd 优先）。
- archive-sessions 的 listLogs 不再写死 session.v4.jsonl.zstd，改用 sessionFileName（顺带支持未压缩 .jsonl）。
- 单测补充：v4.zstd + v5 明文 → 必须返回 v5 明文。
- resolveHome / candidateRoots 仍各包一份：它们要在模块加载期使用，跨包 import 需要 toolbox 服务注入，达不到「比现在更安全」的收益，保留现状。

### 审查报告 C 组（S1：zstd 读/压缩路径统一，2026-11-21）
- zstd-safe 升级为唯一入口：多帧 fzstd → CLI → 内置（读改写 allowZlib=false 直接拒绝单帧兜底），并带 512MB 解压上限（DSH_ARCHIVE_MAX_TEXT_MB）。
- 已切换：archive.mjs（readZstd 兜底）、archive-clean.mjs（zstd/unzstd）、offline-clean.mjs（compress/decompress）、archive-sessions.mjs（compress/decompress）。
- 保留例外：rollback-stream-clean.mjs 的逐帧 partial 解码（专治被截断文件，不能用整包解压替代）。
- S3 剩余（跨包统一 writeAtomic）没动：log-prune 与 toolbox 各自的原子写已经单份，跨包引入需要 toolbox 服务注入，收益低于风险。

### 审查报告 C 组（O4：checkpoint 续跑，2026-11-21）
- offline-clean 每完成一个会话的侧车/清理就写 `<run>/checkpoint.json`（原子替换，含 manifest）；同一 `--run-id` 且状态为 running 时不再把目录挪成 .prev，直接从断点继续，跳过已完成的会话。
- 校验失败回滚时把 checkpoint 标为 rolled-back；dry-run 不写 checkpoint。
- 限制：续跑路径需要真实中断演练（要停 DSH），本轮只做了 dry-run 不写 checkpoint 与语法/回归验证。

### 审查报告 C 组（S5 + O3，2026-11-21）
- **S5** 新增 lib/procctl.mjs：systemd 单元探测、canSystemd/systemdUserMode、systemctlArgs、systemdRunArgs/systemdRunRaw、Windows 计划任务参数与 bat 内容，offline-clean / archive-clean / index.js 三处共用。
- **O3** dry-run 不再在 P3 直接返回：抽出 packArchiveChunks 与 buildCleanLines，dry 用同一份逻辑模拟分帧压缩、stream 变换、首帧断言与 JSON 解析，只报不写。P6/P7 仍未模拟（归档清理与全量复检要真实文件）。
- 实测 dry：待侧车 10719 条模拟 33 帧、待清理 stream 533 条全部变换通过，错误 0。

### 审查报告 C 组（P2：解压上限与按字节缓存，2026-11-21）
- **P2** `readZstd`/`decompressBuf`/`unzstd` 统一加解压后上限（默认 512MB，`DSH_ARCHIVE_MAX_TEXT_MB` 可调）；CLI 的 `maxBuffer` 同步收紧，ENOBUFS 给出明确提示。
- worker 解压（`decompress-worker.mjs`）在解析前检查文本大小；archive-frames 单帧 >64MB 直接拒绝、单帧解压后 >512MB 拒绝。
- `fileTextCache` 由「最多 6 个文件」改为同时按**解压后字节**限容（默认 256MB，`DSH_ARCHIVE_CACHE_MB`），`archTextCache` 也加字节上限。

### 审查报告 C 组（第一批：P5 + S3 子集）
- **P5** toolbox `findSessionDir` 增加 sid→目录缓存（上限 500），命中后用 `sessionFileName` 校验，文件被删/移走自动失效。
- **S3（子集）** 新增 toolbox `lib/util.mjs`（`ts15`/`uniquePath`/`fsErrHint`）与 log-prune `lib/util.mjs`（`tsLocal`/`uniquePath`/`fsErrHint`）；index/watcher/offline-clean/archive-frames/repair 改为引用单一定义。时间戳格式逐字不变（毫秒版仅 offline-clean 使用）。

### Windows 实机反馈修复（2026-11-20 晚）
- **offline-clean 参数校验**：新增 `--help`；未知参数直接 exit 5；手工运行没有 `--run-id` 时默认只允许 `--dry-run`，真清理必须显式 `--apply`（防止 `--help`/拼错参数误触真实清理）。
- **Windows 关闭 DSH 改用退出握手**：优先 `"DSH NEXT.exe" --dsh-installer-quit`，走完整 before-quit；超时才回退 taskkill（不再一上来就 taskkill 绕过框架退出流程）。
- **预演 404 竞态**：dispatch 先建 run 目录和初始 status；UI 对 404 做退避重试。
- **预检卡片不再全 0**：dry 运行会显示「待清理 stream / 待侧车」的 plan 汇总，并标注未执行。
- **安装文档 Windows 勘误**：profile 改为 `<profile>`（实测 desktop）、pnpm/node 不在 PATH 时的替代、端口不写死 3099、tgz 用 `--strip-components=1`、托盘退出/握手、面板需先点「识别/载入」。
- **清理后拉起 DSH（P8）**：拉起前从子进程 env 剔除 `ELECTRON_RUN_AS_NODE`/`DSH_NODE`（否则 DSH NEXT.exe 以 node 模式启动即退出）；拉起后用 tasklist 轮询 20s 确认进程，`report.restart.verified` 如实记录；未确认时保留死亡保险丝，不再 fire-and-forget 直接拆。
- **「查看清理日志」按钮不可见（P9）**：`ocListRuns` 跳过 `.prev-*` 和没有 status.json 的目录，按 `status.updatedAt` 倒序；面板取最近一条 `ok != null` 的运行，首条无效不再清空整块卡片。
- **测试随包**：`files` 加 `test/`，安装副本可直接跑 `node --test test/*.test.mjs`。
- **拉起确认 tasklist 过滤**：`IMAGENAME eq` 的值不能再包字面引号（带引号 0 命中、不带引号 9 命中），否则 `verified` 恒为 false、保险丝一直保留。
- **运行中也保留日志入口（P10）**：锁未释放的 `running` 分支不再整块 return，会显示「查看上次清理日志」按钮，指向最近一条 `ok != null` 的运行；不用手动刷新面板。

### 审查报告第一批（2026-11-20 晚）
- **B5** archive-clean 的 fzstd 改用 `pathToFileURL`，Windows 不再必然加载失败。
- **B4** `coveredOf` 对 `.seqs.json` 做 safe integer/跨度校验（单区间 >100 万跳过并记录），防脏 range 卡死。
- **B11/L1** 锁文件带 pid+token，release 只删自己的；锁目录从 tmpdir 移到 `<DSH_HOME>/state/locks`。
- **B1** 派发前校验 offline-clean.mjs 非空、node 可执行（带 `ELECTRON_RUN_AS_NODE`），`child.on('error')` 回写 status。
- **B14/B15** 反馈文件名与 writeAtomic 临时名加 pid/时间/随机后缀，避免同秒/同进程覆盖。
- **B18** 离线清理识别未压缩 `session.vN.jsonl`（压缩版优先）。
- **M3** `/dsh-toolbox/version/check` 补回环校验。
- **M6** 六处请求体读取加 256KB 上限。
- **D1-D5** 清理未使用 import/导出（log-prune index、era、doctor、repair-session；toolbox hostdeps、test）。
- **O6** 每日清理改为「到点后 6 小时内补跑一次」，不再因错过那一分钟全天不跑。
- **V4** 平铺 YAML 只在引号外、`#` 前有空白时截注释，值里的 `#` 保留。
- **B19** `auditWorkspaceIndex` 的 workspace.json 从传入 root 反推。
- **B21** `repairPruneSpans` 空跨度收尾重算 `shadowedTokenCount`。

### 审查报告第二批（2026-11-21 凌晨，B2/B3 除外）
- **B6** 工具箱 iframe 的 token：宿主页面注入 postMessage 桥，ui.js 在 iframe 内请求 token；本机无 token 时回空串立即继续，不拖慢面板。
- **B7** DSH_HOME 统一：log-prune 回落 `~/.dsh`，offline-clean/archive-sessions 共用 `resolveHome`（`--home` 仍优先）。
- **B8** archive-clean 的 systemd unit 支持 `DSH_SYSTEMD_UNIT`、自动探测 `--user`，不再写死 `/bin/systemctl dsh.service`。
- **B9** Windows 保险丝 schtasks 加 `/sd` 日期、任务名带 runId，按设计解决跨午夜失效/互相覆盖（待 Windows 实测）。
- **B10/W5** 重启 bat 放 `SystemRoot\Temp`（无空格），任务执行后自删，避免 `/tr` 路径截断和任务堆积（待 Windows 实测）。
- **W2** 强制结束 DSH 后按镜像名再扫一遍残留进程（待 Windows 实测）。
- **B16** 离线清理的同文件历史备份保留最近 3 份，本次 manifest 内的不动。
- **B17** state/watcher/config 的关键 JSON/YAML 写入改为 tmp+rename 原子写。

### 审查报告第三批 · 推荐项（2026-11-21 凌晨）
- **B12** Linux `systemd-run` 不可用时拒绝 detached 派发（避免被 DSH stop 连带杀掉），dispatch 返回 409。
- **V1** 启动一次性能力自检（node/zstdWrite/zstdRead/zstdCli），写日志并通过 `/config` 的 `capabilities` 返回；面板警告暂未加。
- **V2** 宿主版本改用 semver 区间判断（>=0.2.1-rc.2 <0.3.0，且只认 0.2.x），doctor 同步。
- **V6** 校验 toolbox `apiVersion === 1` 及必需方法，契约不匹配拒绝激活。
- **O8** 保存配置改为按行原位替换值，保留用户注释、空行和未知键；新键才从默认模板补。
- **O9** `mergeRanges` 合并时累加原始 count，不再按区间长度重算导致空洞时虚高。
- **D6** 删除 `instruction()` 的 `ignoreBelow/ignoreRatio` 死参数及调用点计算。
- **D8** 工具箱状态页不再写死「裁切/巡检插件」。
- **D9** `findUnansweredToolCalls` 非 dry 返回 `ok:false`，不再假装写入成功。
- **M4** 面板高度加 `70dvh`，移动端加 `env(safe-area-inset-bottom)`。
- **M5** 离线清理轮询在页面隐藏时暂停（5 秒后再看）；工具箱 60s 轮询未改。
- **L3** 无 systemd/无 exe 时明确日志「没有自动拉起兜底，请人工确认」。
- **B20** apply 时打印最终 HOME，便于发现 DSH_HOME 晚设置不一致（未改成函数式路径）。
- **R2** `repairOrphans` 最多重试 2 次，避免第 3 轮白跑。
- **R3** TOCTOU 比较加文件头 4KB SHA-1，不再只信 mtime+size。
- **R5** 坏行统一 `checked:false`，`checkStatus` 优先按 `bad` 报红；空日志加 `reason:'empty'`。
- **R8** 缺会话头时跳过补头，不写无 type 的 `seq=-1` 事件。
- **R10** dispatch 的「检查 + 派发」放进同一把锁，防并发双派。
- **R11** 出现 `X-Forwarded-For` 时按远程处理（log-prune 要求 token；toolbox 直接拒绝）。

### 面板 · 其他设置新增两项
- **每天自动清理**开关（autoClean，默认关）：控制每天定时派发的离线清理；默认不自动跑，打开后才按设定时间执行。
- **自动清理时间**（cleanAtHour / cleanAtMinute，默认 4:30）：时 0~23、分 0~59，24 小时制，面板上是并排的两个输入框。
- 每日调度由「固定 04:30 的 setTimeout」改为「每分钟对表 + 读配置」，改完时间下一分钟即按新时间排，不用重启。
- 保留 DSH_CLEAN_AT=HH:MM 作为环境变量默认值（yaml 没写时生效）。

## 未发布 · 2026-11-18 复查修复（发布时再定版本号）

### 一、性能（本轮最大项）
- **dayOf 复用 Intl.DateTimeFormat**：原来每次调用新建实例，实测 15 万次 35 秒同步阻塞；改模块级复用后 268ms。裁切主路径「每事件一次」，是手机 web 假死主因。
- **删掉 when 字段**：全仓无人读，原来每个事件算一次 `toLocaleString`（15 万次约 15 秒）。

### 二、正确性
- **帧索引读取**：catch 里用了不存在的 `log`（模块级函数拿不到 apply 里的 log），失败时 ReferenceError 被上层吞掉，静默只返回 80 字首句。改 `console.warn`；帧路径挪到「小文件判断」之后，改为按帧定位读（不整包 readFileSync），且全部 wanted 命中才提前返回，否则回落 worker。
- **门牌合并**：合并分支里 `prevPlate` 被 `prevPlate.seq !== replaceStart` 无条件清空，导致条数缩水、起点不覆盖旧区间、日志不打印。改为 `!mergePlate` 时才清空，并补 warn 断言。
- **missByFile 合并而非覆盖**：同一归档既被 files 循环读过又被兜底命中时，第一轮结果被覆盖，已日封行退化成首句。
- **scrub 脱敏**：分隔符改为必需（不再把 `refreshInterval` / `apiDocumentation` 打码），另补裸 `refresh-token-xxx` 规则。

### 三、跨平台与闸门
- **ensure-archive 用 resolveHome()**：原来自己拼 `DSH_HOME || /data/dsh`，在 `~/.dsh` / Windows 桌面版上闸门恒 false、裁切整体停摆；并加失败冷却（5 分钟内不再 spawn）。
- **offlineAgent 能力闸**：Node <22.15 没有 zstdCompressSync 时直接返回，不再累计 failCount 触发熔断。

### 四、面板
- 打开面板轻量加载（`nolist=1`）：不扫会话列表、也不扫 sessions 目录树；点「刷新列表」才全量。

### 文档
- README 环境变量表补 7 个（归档闸门 / 门牌合并 / 索引目录 / 调试 / 标定 / 上弦目录）。

## 0.2.18 · 2026-11-16

### 一、主要改动：不再依赖 agent 事件

- watcher 每 20 秒通过 `ctx.get('agents')` 自己找活动 agent，直接量 token、写 `state/prune-tokens`、
  **到线直接触发裁切**（同一会话 120 秒冷却）。事件通不通都不再影响主功能。
- 事件恢复后两条路径可以共存，互不干扰。
- 状态超过 90 秒没更新即主动探测一次；探不到活动 agent 时按 6 小时一行记日志（心跳可见性）。

### 二、缺陷修复（审查全文见插件仓库 docs 或本机 `state/log-prune-audit-20261116.md`）

1. **外部改动判据**：由「会话文件 2 分钟内被写过」改为「inode 变化或体积缩水」。
   旧判据在活跃会话里恒为真（每个 step 都在写文件），等于永久禁止裁切。
2. **摘要识别收紧 + 逐块判**：原「开头 200 字内出现即认」会把任务提示词自己判成摘要（本地实测把
   prune-last 写成任务消息 seq），已改为「任一块以「【裁切摘要】」开头才算」，且 text/reasoning 逐块判，
   模型先写推理再写正文也不会漏判；不再用「覆盖：seq A-B」兜底（讨论格式的正文会被误判）。
2b. **门牌区间不再错位**：起始合成节点（压缩摘要/旧门牌）被跳过时，门牌上的起点改用实际替换起点，
   条数用实际裁掉的节点数——以前会写出「新门牌说 80633 起、实际只替换了 83079 起」，同一事出现两条重叠门牌。
3. **canWrite 安全闸生效**：拿不到宿主消息工厂时只量 token、不写会话（以前无条件置真，闸门等于不存在）。
4. **热重载不再静默失能**：8 个模块级 `shared*` 标志在 `ctx.effect` 卸载钩子里复位，
   重载后路由与监听能重新注册（以前卸载后标志仍是 true，新实例永不注册）。
5. **影子价格校准**：用实测 token/字数比替换全篇 `chars / 2`。
6. **兜底读日志缓存** 30 秒 → 10 分钟（整份解压 153MB 约 6 秒，会阻塞主线程）。
7. **TDZ 隐患**：`landingTimers`/`landingMsgs` 提到 `pruneStep` 之前声明。

### 三、跨环境适配

1. **配置解析兜底**：`js-yaml` 拿不到时不再整份忽略配置（原来静默回退默认值），改用内置平铺 YAML 解析器。
2. **require 基准**：从写死 `/usr/lib/node_modules` 改为与 `hostdeps` 相同的候选根
   （`/usr/local`、`/usr/lib`、桌面版 asar、profile 树、自身 node_modules 全覆盖）。
3. **消息工厂兜底**：`dsh-llm` 宿主树取不到时裸 import，再不行用带 id 的自建 `createUserMessage`，
   不会因为路径差异让 `canWrite` 变 false（那会导致只量 token、永不裁切且不报错）。
4. **路径绝对化**：`resolveHome()` 对 `DSH_HOME` 做 `path.resolve`；`repair.mjs` 不再自己读一套 DSH_HOME。
5. 清理遗留死标志 `globalThis.__dshLogPrunePreStep`。

### 四、token 测量：三档兜底

1. **核心 `@deepseek-ai/dsh-token-meter`**：`ctx.get('tokenMeter').contextPressure(session).pressureTokens`
   —— 与 DSH 自己判断压缩用的是同一个数（口径 `inputTokens + cacheReadTokens + cacheWriteTokens`）。
2. **表面上最近一条带 usage 的事件**（同口径）—— 核心服务缺失或改名时使用。
3. **全文字数 / 2** —— 仅在完全拿不到 usage 时兜底，并写一行「token 测量降级」告警（5 分钟最多一次）。

状态文件新增 `src` 字段标明来源（`tokenMeter` / `usage` / `chars`）；
三档全失败时 `tokens = 0` → **不裁**，宁可不动手。

### 五、安全：接口访问控制（新增，行为变化）

宿主只对页面做认证，插件用 `webServer.register` 注册的 `/dsh-log-prune/*` 不经过它
（实测未登录 `GET /config` 直接返回 200，且带出绝对路径）。本版加两层守卫：

- **谁在连**：回环地址（127.x / ::1 / unix socket）放行；非回环默认 **403**，
  需要远程访问时设 `allowRemote: true`，此后请求必须带 `x-lp-token`
- **谁的浏览器在发**：写操作（POST/PUT/DELETE/PATCH）强制 `Content-Type: application/json`
  并校验 `Origin` 与请求 `Host` 同源。浏览器里的跨站页面（form、no-cors fetch、sandbox iframe）
  发不出 JSON 简单请求，CSRF 路径全部关闭
- token 持久化在 `state/access-token.json`（0600），重启不变，删除文件即轮换；**惰性创建**，
  `allowRemote=false` 时根本不会生成
- `/dsh-log-prune/ui.js` 静态路由不设守卫（否则「没 token 加载不了 ui.js、拿不到 token」死锁）

已知局限（写进 README）：插件假设直连；若前面有 nginx/caddy 等反代，`remoteAddress` 会变成
127.0.0.1，本机判定会放行公网请求 —— 此时请用宿主认证或防火墙限制端口。插件当时不信任
`X-Forwarded-For`，也不提供 trustProxy；后续版本已加 `trustProxy`（默认 false，见当前 README/CONFIG）。

### 六、裁切链路补完

1. **有摘要时的选轮**：保留线为 0 时预算停止条件退化，按天合并又把同一天的轮次并成一段、
   越界被整段过滤 → 恒为 0 段。抽出纯函数 `selectCutSpans()`：有摘要时先过滤「整轮都在摘要之前」再挑，
   不做预算停手；无摘要时维持原预算模式。附回归单测
2. **原文覆盖补齐**：镜像/归档停在 2026-11-15 21:36，而裁切有「未归档不裁」的硬保护，
   于是全部判成未归档。改为按缺口用会话日志补齐（实测补 17,504 条）
3. **起始边界节点**：官方 compact 留下的节点 seq 比后继还新，触发「seq 必须严格递增」的保护，
   整段被跳过。改为从第一个单调节点开始切，日志记「跳过起始边界节点 N 个」
4. **裁切后折算写回**：token 文件天然滞后一轮，watcher 会拿裁切前读数再判一次到线、白派摘要。
   裁完把 `max(0, tokens - saved)` 写回，`src: postPrune`

### 七、正确性修复

| 项 | 说明 |
|---|---|
| `collectNodes` 缓存版本号 | 原来只比「长度 + 首尾」，中间发生单节点替换（长文落盘正是这种）时长度与首尾都不变，会返回**已不在表面的旧节点**。改为整串比较 |
| `updateCheck` 会话覆盖 | 面板能把它存成会话级覆盖，但 `checkUpdate()` 只读全局 → 显示已保存、外网请求照发。改为提交时抬到全局 |
| `loadConfig` catch 分支 | 配置缺失时直接返回未 clamp 的环境变量值（`keepTokens=-5` 会让裁切一直裁到 keepTurns 限）。抽出 `clampCfg()`，正常分支与 catch 分支都过一遍 |
| `writeStatus` 去重 | 原来比较整份文件，跨会话交替时永远在变、去重等于没有。改为按本会话那一条比较 |
| 会话级摘要配置 | watcher 派发时传的是全局 cfg，面板上按会话填的 `summaryApiUrl`/`summaryClientPath` 不生效。改为 `eff` |
| 索引块 rpcId | 固定为 `prune-index`，两次压缩之间没发生裁切时会写重复 rpcId。加时间戳 |
| 消息工厂缺失 | 拿不到宿主消息工厂时只量 token、不写会话（`canWrite` 闸门） |

### 八、性能

- `GET /config`：会话路径映射改为循环外扫一次（原来每个会话一次 `readdirSync`）；
  结构检查（解压 + fold，约 10ms/会话）只在 `refresh=1` 时做
- `loadSessions` 加 mtime 缓存，`saveSessions` 写完失效
- `readPresetInfo` 按 sid + 文件 mtime 缓存；`doctorInstalled` 30 秒缓存
- 环境变量只算一次（`ENV_BASE` 提到模块顶层）
- `lastMissWarn` 加容量上限；`collectNodes` 统一三处扫描

### 九、面板

- **摘要派发三项可在面板里改**：`summaryIgnoreRatio`、`summaryApiUrl`、`summaryClientPath`
  （以前只能手改 yml）
- **孤儿 prune 可见化**：裁切「prune 成功、替换被拒」时记 `orphanRisk{seq, range, at, reason}`
  （prune 自己被拒不记，避免误报）；面板显示橙色提示 + 修复按钮橙色描边；修复成功后清除；
  `/fuse/reset` 的「先修复成功」分支也清
- **恢复四块被误删的 UI**（16:51 做原版对照时整份替换 ui.js 导致）：裁切状态行 + 熔断「修复并解除」按钮、
  布尔行排版、会话列表整行选中高亮、「立即检查」按钮
- **时区修正**：裁切状态时间以前直接截 ISO 字符串，把 UTC 当本地时间显示（19:31 的裁切显示成 11:31）
- 更新检查关掉时显示「自动检查已关闭（不发外网请求）」，不再空白；开关移到独立「更新检查」组

### 十、健壮性与代码卫生

- `readEntriesAsync` 的 worker 失败回退改为 `console.warn`（原来用了 apply 作用域的 `log`，
  会 ReferenceError 被上层吞掉，兜底静默失效）
- 裁切检查日志降级为 `dlog`（要 `DSH_LOG_PRUNE_DEBUG=1` 才输出）
- 路径常量统一 `path.join`（Windows 上不再混分隔符）；`getFold` 去掉写死的 `/usr/lib/...`，
  改走 `candidateRoots()`
- 删除死代码 `loadHostDeps` / `localDefineTool`（`hostdeps.mjs` 165 → 103 行；外部无法
  `import 'dsh-log-prune/lib/hostdeps.mjs'`，两者没有任何调用方）
- `repair-session.mjs` 删掉重复的 `fzstdDecompress` 兜底；`exact` 统计循环 `charLen` 只算一次
- `ensureConfigFile` 用环境变量值写初值；`.bak-` 最多保留 5 个

### 十一、测试

- `test/pure.test.mjs`：11 条单测（`npm test`）
- `test/p4-smoke.mjs`：孤儿提示冒烟。支持 `--restore`（恢复最早那份干净基线）与 `--clean`，
  重复运行不会把干净基线覆盖成脏数据；状态文件不存在时建空基线

### 十二、升级方式

- 替换 `lib/`、`bin/`、`package.json`、`cordis.patch.yml`，重启 DSH 生效。
- 配置与状态文件向后兼容：新增配置项只有 `allowRemote`（默认 `false`，即保持「只允许本机」）；
  `prune-status.json` 的 `orphanRisk` 兼容旧的字符串形状（`"起-止"` + `orphanAt`）；
  `prune-tokens` 会在下一次探测时自动升级格式（新增 `src` 字段）。
- 若从 0.2.17.x 升级：第一次运行会自动补原文覆盖，耗时约 30 秒。

### 十三、已知未验证

- 「到线 → 派摘要 → 真的裁一刀」的干净一轮：本版期间触发过一次实裁（省 424,112 token），
  但那次的摘要派发本身是误触发（token 读数是裁切前的旧值）。正常路径的完整一轮仍待自然到线观察。
- 长时间运行下的内存峰值（解压 150MB 级会话日志约 3–4 GB）未做压测，低内存机器建议用镜像/归档。

---

## 0.2.17.5 · 待发布

### 新增
- **「自动检查更新」开关**（面板版本号那行右侧）
  - 开（默认）：沿用原逻辑，每 6 小时最多查一次 GitHub `releases/latest`，5 秒超时，失败静默
  - 关：插件不再发出任何外网请求，`/update-check` 直接返回 `disabled`，面板显示「自动检查已关闭（不发外网请求）」
- 配置项 `updateCheck`（默认 `true`），yml 模板新增「更新检查」段，写明这是唯一外网请求、查什么、多久一次、怎么关
- **裁切状态与熔断入口**（面板底部）
  - 显示「正常 / 最近失败 N 次 / 已熔断（时间 + 原因）」
  - 熔断时出现「修复并解除」按钮，点了先跑一次会话修复（孤立事件）+ 复检：
    - 修好且复检通过 → 清掉 `prune-broken.json` 条目，**不用重启**、不用手改 json
    - 修不好或复检仍有问题 → **不解除**，面板直接显示原因（哪一步失败、修复做了什么）
- 结构检查不放在裁切插件里（职责归健康巡检）：裁切面板只显示裁切状态与熔断入口
- 新增状态文件 `state/prune-status.json`：记录每个会话最近一次裁切结果与连续失败次数；成功即清零

### 改动文件
- `lib/config.mjs`：DEFAULTS 加 `updateCheck`；默认 yml 文本加说明段
- `lib/index.js`：`checkUpdate()` 开头判开关；`writeStatus()/readStatus()/clearFuse()`；失败/成功处写状态；`/fuse` 两个接口
- `lib/ui.js`：版本号行加 checkbox；底部加裁切状态行与「解除熔断」按钮

### 配套：健康巡检插件解除对裁切的依赖
- `dsh-session-doctor` 原先 `import('../../dsh-log-prune/lib/repair.mjs')`，只装巡检时「修复」会不可用
- 现在 repair 模块复制进巡检自己的 `lib/repair.mjs`，两边彻底独立
- 两个都装时，裁切面板隐藏「尝试修复会话」（原有逻辑），修复统一走巡检

---

## 记着但还没做的（留给后面版本）

来源：2026-11-14 Windows 端实测 + 新需求（第 6 条已在 0.2.17.4 完成）
1. 拖拽区扩到整块头部、删掉关闭按钮
2. 面板展开时，原悬浮按钮位置不可点，点原位置应当收起
3. 悬浮球本身能拖（现在只有面板能拖）
4. 会话 id 从宿主 ctx 取，别扫 URL 猜
5. 原生 select 下拉白底浅字看不清，要定色
6. ~~内置更新检查：面板显示版本状态，取 GitHub tag 跟本地比，缓存、超时静默~~（0.2.17.4 已完成）
