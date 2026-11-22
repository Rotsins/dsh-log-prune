# dsh-log-prune 更新报告（0.2.17.4 → 当前）

> 整理日期：2026-11-21  
> 范围：`dsh-log-prune` 从 0.2.17.4 之后到当前工作区的全部版本与未发版改动；同批的 `dsh-toolbox` 配套改动一并列出。  
> 依据：`RELEASE-NOTES.md`、`package.json`、当前源码与测试结果。  
> 当前版本：`dsh-log-prune 0.2.18.2`，`dsh-toolbox 0.2.1.3`。0.2.18.1 之后的修复已作为 0.2.18.2 发版。  
> 前置插件：[dsh-toolbox](https://github.com/Rotsins/dsh-toolbox) 版本 ≥ 0.2.1

## 一、版本概览

| 版本 | 日期 | 状态 | 主题 |
|---|---|---|---|
| 0.2.17.5 | 2026-11-14/15 | 待发布，相关能力已进入当前线 | 更新检查开关、裁切状态/熔断面板、状态文件 |
| 0.2.18 | 2026-11-16 | 已发布 | 去掉 agent 事件依赖、安全访问控制、裁切链路补完、token 三档测量 |
| 0.2.18.1 | 2026-11-20/21 | 上一发布版 | 大批审计修复：归档流式清理、解压上限、每日清理、Windows、权限、性能、测试 |
| 0.2.18.2 | 2026-11-21 | 本次发布 | 配置写坏、状态残留、Windows 隐藏窗口、XFF 伪造、摘要线文档 |

## 二、0.2.17.5：更新检查与裁切状态

这一版标注“待发布”，但相关能力已经进入当前 0.2.18.1 线。

### 1. 更新检查开关
- 面板版本号旁新增“自动检查更新”开关，配置项 `updateCheck` 默认 `true`。
- 开启时每 6 小时最多查一次 GitHub `releases/latest`，5 秒超时，失败静默。
- 关闭后插件不再发任何外网请求，`/update-check` 直接返回 `disabled`，面板显示“自动检查已关闭（不发外网请求）”。
- yml 模板增加“更新检查”说明段，明确这是唯一外网请求、查什么、频率、如何关闭。

### 2. 裁切状态与熔断入口
- 新增 `state/prune-status.json`：按会话记录最近一次裁切结果、连续失败次数、失败原因；成功即清零。
- 面板底部显示“正常 / 最近失败 N 次 / 已熔断（时间 + 原因）”。
- 熔断时出现“修复并解除”按钮：先跑孤立事件修复并复检，修好才清 `prune-broken.json`，不重启；修不好则不解除并显示原因。
- 结构检查不放进裁切插件，职责归健康巡检；裁切面板只显示状态与熔断入口。

### 3. 与健康巡检解耦
- `dsh-session-doctor` 不再依赖裁切插件的 `repair.mjs`，修复模块复制进巡检自己的 `lib/repair.mjs`。
- 两个都装时，裁切面板隐藏“尝试修复会话”，修复统一走巡检。

## 三、0.2.18：不再依赖 agent 事件

### 1. 主链路重构
- watcher 每 20 秒通过 `ctx.get('agents')` 自己找活动 agent，直接量 token、写 `state/prune-tokens`，到线直接触发裁切，不再依赖 agent 事件。
- 事件恢复后两条路径可共存；同一会话裁切有 120 秒冷却。
- token 状态超过 90 秒未更新会主动探测；探不到活动 agent 时按 6 小时一行记录，保留心跳可见性。

### 2. 缺陷修复
- 外部改动判据从“2 分钟内被写过”改为“inode 变化或体积缩水”，避免活跃会话永远禁止裁切。
- 摘要识别收紧为“任一块以「【裁切摘要】」开头”，text/reasoning 逐块判；不再用“覆盖：seq A-B”兜底，避免讨论格式的正文被误判。
- 门牌区间修正：起始合成节点被跳过时，起点用实际替换起点、条数用实际裁掉节点数，避免重叠门牌。
- `canWrite` 安全闸生效：拿不到宿主消息工厂时只量 token、不写会话。
- 热重载后 8 个模块级 `shared*` 标志复位，路由和监听能重新注册。
- 影子价格校准改用实测 token/字数比；兜底日志缓存从 30 秒延长到 10 分钟；修复 TDZ 隐患。

### 3. 跨环境适配
- `js-yaml` 不可用时使用内置平铺 YAML 解析器，不再整份忽略配置。
- `require` 基准改为与 hostdeps 相同的候选根，覆盖 `/usr/local`、`/usr/lib`、桌面版 asar、profile 树、自身 node_modules。
- 消息工厂三级兜底：宿主树 import → 裸 import → 带 id 的自建 `createUserMessage`。
- `resolveHome()` 对 `DSH_HOME` 做 `path.resolve`；repair 不再自己读一套 DSH_HOME。
- 清理遗留死标志 `globalThis.__dshLogPrunePreStep`。

### 4. token 测量三档兜底
1. 核心 `tokenMeter.contextPressure(session).pressureTokens`，与 DSH 自己判断压缩同口径。
2. 表面上最近一条带 usage 的事件，同口径。
3. 全文字数 / 2，仅在完全拿不到 usage 时使用，并每 5 分钟最多告警一次。

状态文件新增 `src` 字段（`tokenMeter` / `usage` / `chars`）；三档全失败时 `tokens=0`，不裁。

### 5. 安全：接口访问控制（行为变化）
- 回环地址（127.x / ::1 / unix socket）放行；非回环默认 403。
- 远程访问需设 `allowRemote: true`，请求必须带 `x-lp-token` 或页面登录后的 cookie。
- 写操作强制 `Content-Type: application/json` 并校验 `Origin` 与 `Host` 同源，关闭 form/no-cors fetch/sandbox iframe 的 CSRF 路径。
- token 持久化在 `state/access-token.json`（0600），重启不变；删除即轮换；`allowRemote=false` 时惰性创建。
- `/dsh-log-prune/ui.js` 静态路由不设守卫，避免“没 token 加载不了 ui.js”死锁。
- 已知限制：插件假设直连；反代部署需宿主认证/防火墙，或后续开启 `trustProxy`。

### 6. 裁切链路补完
- 有摘要时的选轮改为纯函数 `selectCutSpans()`：先过滤“整轮都在摘要之前”再挑，不再恒为 0 段。
- 镜像/归档停更时，按缺口用会话日志补齐原文覆盖，不再全部判成“未归档”。
- 官方 compact 留下的起始边界节点 seq 可能比后继新，改为从第一个单调节点开始切，并记日志。
- 裁切后把 `max(0, tokens - saved)` 写回 token 文件，避免 watcher 拿裁切前读数再白派摘要。

### 7. 正确性修复
- `collectNodes` 缓存版本号从“长度 + 首尾”改为整串比较，识别中间单节点替换。
- `updateCheck` 会话覆盖提交时抬到全局，避免“显示已保存、外网请求照发”。
- `loadConfig` 缺失/失败分支也过 `clampCfg()`，避免环境变量绕过上下界。
- `writeStatus` 去重改为按本会话那一条比较，跨会话交替不再失效。
- watcher 派发摘要使用会话级 `eff`，按会话填的 `summaryApiUrl` / `summaryClientPath` 生效。
- 索引块 `rpcId` 加时间戳，避免两次压缩之间没裁切时重复。
- 消息工厂缺失时只量 token、不写会话。

### 8. 性能、面板、测试
- `GET /config` 会话路径映射移出循环；结构检查只在 `refresh=1` 做。
- `loadSessions` 加 mtime 缓存；`readPresetInfo` 按 sid + 文件 mtime 缓存；环境变量只算一次。
- 面板增加摘要派发三项（`summaryIgnoreRatio`、`summaryApiUrl`、`summaryClientPath`）。
- 孤儿 prune 可见化：橙色提示 + 修复按钮；修复成功后清除。
- 恢复四块被误删 UI：裁切状态行、熔断“修复并解除”、布尔行排版、会话列表整行高亮。
- 裁切状态时间改用本地时间，不再把 UTC 当本地。
- 更新检查关闭时显示明确文案。
- `test/pure.test.mjs` 11 条；`test/p4-smoke.mjs` 孤儿提示冒烟。

## 四、0.2.18.1：审计修复大合集

0.2.18.1 标注 2026-11-20，但实际收录到 2026-11-21 的多批审计修复。

### 1. 归档逐帧流式清理（E5）
- `cleanArchiveStreams` 对带帧侧车的归档不再整包 `readFileSync`：先按侧车校验 size/偏移，再逐帧 `readSync` 解压；只有检测到 stream 才进第二遍，边清边写 tmp，内存约等于单帧。
- 无帧侧车的旧归档保留整包路径。
- 新增 `test/archive-clean-e5.test.mjs`；真实 97MB 归档（1242 帧）dry 跑通，错误 0。

### 2. 收尾批（E1/E4/E7/凭证）
- E1：批帧规则抽到 `lib/frame-pack.mjs`，offline-clean 改用；与 toolbox `frame-writer` 产物逐字节比对。
- E4：worker 失败不再对 ≥8MB 文件回落整包同步解压，改为明确报错并提示 CLI。
- E7：简报改存 `brief.txt`，不再读 `run.log` 全文再整体重写。
- 凭证：`?token=` 校验通过后种 HttpOnly `dsh_tb_token` 并 302 去掉地址栏 token；`guard` 接受 cookie；刷新/同源 fetch 不再依赖 URL。
- Linux 拉起确认补 pgrep 分支，`DSH_RESTART_CMD` 与 start-exe 统一等 20 秒确认。

### 3. 每日清理休眠/非 7×24 适配
- 补跑窗口从 6 小时收紧到 5 分钟，只容忍定时器抖动。
- 两次 tick 间隔超过 2 分钟判定为休眠/时钟跳变恢复，当天不补跑，只记日志。
- 调度留在插件进程内，不安装系统级定时器；系统定时器只保留给“清理过程中 DSH 没起来”的短时保险丝。
- `autoClean` 默认仍为关，模板注明只建议 7×24 机器开启。

### 4. F7 流式解压上限
- 新增 `unzstdLimited()`：fzstd 流式累计输出，超过上限（默认 512MB，`DSH_ARCHIVE_MAX_TEXT_MB` 可调）立即中止。
- `unzstd()` 优先走流式，异常再回落整包 fzstd / CLI / 内置链。
- 大文件 worker 与 toolbox 单帧解压同步改为流式带护栏。
- 验收：53.6MB 会话（解压 110.2MB）流式与整包 sha1 一致；离线 dry-run 20 会话错误 0；新增 `test/zstd-limit.test.mjs`。

### 5. P3 低风险子集
- E2：`verifySessionFile` 分段比对（2000 行/段），不再拼整份 `want` 字符串。
- E3：残帧另存文件名带内容 sha1 前 12 位；`.droppedTail-` 只留最近 5 份。
- E9：toolbox `registerRoute` 形参改名 `routePath`，不遮蔽模块级 `path`。
- S-c：新增 `test/config-keys.test.mjs`，校验模板/DEFAULTS/面板 FIELDS 三处键一致。
- S-d：toolbox 测试脚本改为 `node --test test/*.test.mjs`，无 zstd 的 Node 自动 skip。
- D4–D9：删除 0 引用代码（archive-sessions zstd 探测残留、util 的 uniquePath/fsErrHint、semver.compareVersion、zstd-safe 的 compressLines/hasBuiltinZstd/hasZstdCli、daycut 的 shiftDay/nowHour）。

### 6. 审查报告第四批（P0/P1/P2）
- F2：`zstd-safe` vendor 动态 import 改 `pathToFileURL`，修复 Windows 上绝对路径被当裸模块名、fzstd 永远加载不到。
- F3：默认不信任 `X-Forwarded-For`，新增 `trustProxy`（默认 false）；直连带 `100.64.1.1` 不再绕过 allowRemote/token。
- F5：Windows 重启任务补 `/sd` 日期，修复跨午夜任务永不触发。
- F8：归档水位文件改原子写（offline-clean 两处 + archive-sessions）。
- F9：ICU 探测改用跨日样本，small-icu 不再静默错一天。
- F10：每日清理的“今天”和 04:30 判定改北京时间，UTC 主机不再偏 8 小时。
- F11：归档文本缓存按条目自身字节记账，覆盖先减旧值，逐出不再整表重算。
- F12：派发失败区分可重试性；systemd-run 抖动释放当日认领，隔分钟重试最多 3 次。

### 7. 每日清理重启循环修复（严重）
- 问题：“今天已派过”只记内存；offline-clean 停/拉 DSH 后内存清空，6 小时补跑窗口内每分钟重派，形成“启动→20 秒→停→再启动”的高频循环。
- 修复：新增 `lib/offclean-day.mjs`，改为 `state/offclean-day-<日期>.claim` 原子认领（O_EXCL，跨进程/跨重启生效）；同一单元在跑不派；runId 固定 `daily-<日期>`。
- 派发失败当天不自动重试；定时器不再挂 `ctx.effect` 的 dispose 清理，避免插件重载后静默停摆。
- 新增 `test/offclean-day.test.mjs` 7 例。

### 8. 审查报告第三批 A 组
- B13：更新检查改用 `semver.compareLoose`，支持四段版本与预发布标签。
- W3：`CONFIG_PATH` / `SESSIONS_PATH` 改 `path.join`，Windows 不再混分隔符。
- P1：tmpdir 的 `log-prune.log` 超 5MB 滚动 `.1`。
- P10：`loadConfig` 读失败做 10 秒负缓存。
- P9：会话修复不再两次全量 `JSON.stringify` 比对，改用实际改动标记。
- O10：archive-frames 重建前校验“帧内 seq 单调不减”。
- V3：`foldSurface` 探测失败写日志、暴露状态、60 秒后允许重试。
- V5：启动能力自检加入 ICU/时区探测，支持 `DSH_TZ_OFFSET` 手工兜底。
- V1：面板顶部显示 zstd/时区能力警告，缺 zstd 时拦住离线清理。
- M5：toolbox 60 秒轮询在页面隐藏时暂停。
- S7：默认配置模板外置到 `templates/log-prune.yml.tpl`。
- D7/D8：删除 client.js 的 diag 上报、`/diag` 路由和过期状态页文案。
- B1：派发前 node 校验与 `child.on('error')` 回写 status 保持。
- B2：droppedTail 不自动写回，先另存残帧，二次确认后才写；返回 `needConfirm` 与丢弃条数。
- B3：修复写回改批帧，首帧一行 session header，其余 500 行/帧；51.2MB/86610 行会话从 86610 帧降到 175 帧。

### 9. 审查报告 B 组
- O2：`writeStatus` 增加 `lastError`，失败记原因、成功即清。
- O5：离线清理报告增加 `partial/partialSessions`。
- P3：`frameSeqStats` 复用外层 fd，重建侧车不再每帧 open/close。
- P6：`collectNodes` 版本号改为数字滚动哈希，识别中间节点替换。
- P7：修复/区间备份改异步 `fs.promises.copyFile`。
- P8：watcher fastLoop 在 `ARMED_DIR` 不存在时退避到 10 秒。
- S6：锁定会话以服务端文件为真源，POST 成功后才回写 localStorage。
- R5：列表“已知 bad”优先于 unknown。

### 10. 审查报告 B 组续（M2 + S4）
- S4：toolbox 9 条路由统一走 `registerRoute`，鉴权只在注册器施加一次。
- M2：新增 `lib/auth.mjs`，复用 log-prune 的 token 与 allowRemote；远程可带 `?token=` 或 `x-lp-token`，成功后种 `dsh_tb_token` cookie，回环照常放行。
- 未授权不再返回纯 forbidden：页面给可读说明，API 返回 JSON。
- 实机修正：XFF 最后一跳为 100.64/10 或回环时视为本机，公网仍走 allowRemote + token。
- token 文件改为远程请求进来即生成；toolbox client.js 同步 cookie 并给 iframe 带 token，log-prune ui.js 接受自身 URL 的 `?token=`。

### 11. 审查报告 C 组
- O1：新增 `tools/audit-catches.mjs`，盘出 538 处 catch、243 处空 catch（log-prune 415 / toolbox 123）。
- 修掉两处“失败仍返回成功”：archive-cut 写回前备份失败改为中止；`/locked` 写盘失败返回 500。
- L4：CONFIG.md 补充 Windows/CIFS/NFS 上 0600 不保证生效，token 文件权限非 0600 时启动告警。
- P4：toolbox `repair.mjs` 新增 `makeSurfaceWalker`，前缀 fold 从 O(n²) 降到 O(n)。
- S2：offline-clean 删除自己的 `sessionFileNameOf`，统一走 `lib/session-file.mjs`（版本优先、同版本 zstd 优先）。
- S1：zstd-safe 升级为唯一入口：多帧 fzstd → CLI → 内置；读改写 `allowZlib=false` 拒绝单帧兜底；512MB 上限。
- O4：offline-clean 每完成一个会话写 `checkpoint.json`，同一 run-id 可从断点续跑；校验失败标 rolled-back；dry-run 不写 checkpoint。
- S5 + O3：新增 `lib/procctl.mjs`，systemd/Windows 计划任务参数三处共用；dry-run 用同一份逻辑模拟分帧压缩、stream 变换、首帧断言与 JSON 解析。
- P2：解压上限统一；worker 解析前检查文本大小；archive-frames 单帧 >64MB 拒绝、解压后 >512MB 拒绝；缓存按解压后字节限容。
- P5 + S3：toolbox `findSessionDir` 增加 sid→目录缓存（上限 500）；新增两包各自的 `lib/util.mjs`，统一时间戳/uniquePath/fsErrHint。

### 12. Windows 实机反馈修复
- offline-clean 新增 `--help`；未知参数 exit 5；手工运行无 `--run-id` 时默认只允许 `--dry-run`，真清理必须显式 `--apply`。
- Windows 关闭 DSH 优先走 `"DSH NEXT.exe" --dsh-installer-quit` 退出握手，超时才回退 taskkill。
- 预演 404 竞态：dispatch 先建 run 目录和初始 status，UI 对 404 退避重试。
- 预检卡片不再全 0，dry 显示“待清理 stream / 待侧车”的 plan 汇总。
- 安装文档 Windows 勘误：profile 改 `<profile>`（实测 desktop）、pnpm/node 不在 PATH 的替代、端口不写死 3099、tgz 用 `--strip-components=1`、托盘退出/握手、面板先点“识别/载入”。
- 清理后拉起 DSH：剔除 `ELECTRON_RUN_AS_NODE`/`DSH_NODE`；tasklist 轮询 20 秒确认；未确认保留死亡保险丝。
- “查看清理日志”按钮不可见：`ocListRuns` 跳过 `.prev-*` 和无 status.json 目录，按 `status.updatedAt` 倒序；运行中也保留日志入口。
- 测试随包：`files` 加 `test/`。
- tasklist 过滤 `IMAGENAME eq` 不再包字面引号，避免 verified 恒 false。

### 13. 审查报告第一批
- B5：archive-clean 的 fzstd 改用 `pathToFileURL`，Windows 不再必然加载失败。
- B4：`coveredOf` 对 `.seqs.json` 做 safe integer/跨度校验，单区间 >100 万跳过并记录。
- B11/L1：锁文件带 pid+token，release 只删自己的；锁目录移到 `<DSH_HOME>/state/locks`。
- B1：派发前校验 offline-clean.mjs 非空、node 可执行（带 `ELECTRON_RUN_AS_NODE`），`child.on('error')` 回写 status。
- B14/B15：反馈文件名与 writeAtomic 临时名加 pid/时间/随机后缀。
- B18：离线清理识别未压缩 `session.vN.jsonl`（压缩版优先）。
- M3：`/dsh-toolbox/version/check` 补回环校验。
- M6：六处请求体读取加 256KB 上限。
- D1–D5：清理未使用 import/export。
- O6：每日清理改为“到点后 6 小时内补跑一次”（后续收紧为 5 分钟）。
- V4：平铺 YAML 只在引号外、`#` 前有空白时截注释。
- B19：`auditWorkspaceIndex` 的 workspace.json 从传入 root 反推。
- B21：`repairPruneSpans` 空跨度收尾重算 `shadowedTokenCount`。

### 14. 审查报告第二批
- B6：工具箱 iframe token 走宿主 postMessage 桥；本机无 token 时立即继续。
- B7：DSH_HOME 统一，offline-clean/archive-sessions 共用 `resolveHome`。
- B8：archive-clean 的 systemd unit 支持 `DSH_SYSTEMD_UNIT`、自动探测 `--user`。
- B9：Windows 保险丝 schtasks 加 `/sd` 日期、任务名带 runId。
- B10/W5：重启 bat 放 `SystemRoot\Temp`，执行后自删。
- W2：强制结束 DSH 后按镜像名再扫残留进程。
- B16：离线清理同文件历史备份保留最近 3 份。
- B17：state/watcher/config 关键 JSON/YAML 写入改 tmp+rename 原子写。

### 15. 审查报告第三批推荐项
- B12：Linux `systemd-run` 不可用时拒绝 detached 派发，dispatch 返回 409。
- V1：启动能力自检（node/zstdWrite/zstdRead/zstdCli），写日志并通过 `/config` 的 `capabilities` 返回。
- V2：宿主版本改 semver 区间判断（>=0.2.1-rc.2 <0.3.0，只认 0.2.x）。
- V6：校验 toolbox `apiVersion === 1` 及必需方法，契约不匹配拒绝激活。
- O8：保存配置按行原位替换值，保留注释、空行和未知键；新键才从默认模板补。
- O9：`mergeRanges` 合并时累加原始 count，不再按区间长度重算。
- D6：删除 `instruction()` 的 `ignoreBelow/ignoreRatio` 死参数。
- D8：工具箱状态页不再写死“裁切/巡检插件”。
- D9：`findUnansweredToolCalls` 非 dry 返回 `ok:false`，不再假装写入成功。
- M4：面板高度加 `70dvh`，移动端加 `env(safe-area-inset-bottom)`。
- M5：离线清理轮询在页面隐藏时暂停。
- L3：无 systemd/无 exe 时明确日志“没有自动拉起兜底，请人工确认”。
- B20：apply 时打印最终 HOME。
- R2：`repairOrphans` 最多重试 2 次。
- R3：TOCTOU 比较加文件头 4KB SHA-1，不再只信 mtime+size。
- R5：坏行统一 `checked:false`，`checkStatus` 优先按 `bad` 报红；空日志加 `reason:'empty'`。
- R8：缺会话头时跳过补头，不写无 type 的 `seq=-1` 事件。
- R10：dispatch 的“检查 + 派发”放进同一把锁，防并发双派。
- R11：出现 `X-Forwarded-For` 时按远程处理（log-prune 要求 token；toolbox 直接拒绝）。

### 16. 面板“其他设置”新增
- `autoClean`：每天自动派发离线清理，默认关。
- `cleanAtHour` / `cleanAtMinute`：默认 4:30，24 小时制，面板并排输入。
- 每日调度从固定 04:30 的 setTimeout 改为“每分钟对表 + 读配置”，改完下一分钟生效。
- 保留 `DSH_CLEAN_AT=HH:MM` 作为环境变量默认值。

## 五、0.2.18.1 补充：2026-11-18 复查修复

这一批在发布说明中标注“未发布，发布时再定版本号”，实际已进入当前 0.2.18.1 线。

### 性能
- `dayOf` 复用 `Intl.DateTimeFormat`：原来每次调用新建实例，15 万次约 35 秒同步阻塞；改模块级复用后 268ms。
- 删除无人读取的 `when` 字段，避免每个事件算一次 `toLocaleString`（15 万次约 15 秒）。

### 正确性
- 帧索引读取：catch 里用了不存在的 `log`，失败时 ReferenceError 被吞，只返回 80 字首句；改 `console.warn`，帧路径改为按帧定位读，全部 wanted 命中才提前返回，否则回落 worker。
- 门牌合并：`prevPlate` 被无条件清空，导致条数缩水、起点不覆盖旧区间；改为 `!mergePlate` 时才清空，并补 warn 断言。
- `missByFile` 合并而非覆盖：同一归档被 files 循环和兜底同时命中时，第一轮结果被覆盖；改为合并。
- `scrub` 脱敏：分隔符改为必需，不再把 `refreshInterval` / `apiDocumentation` 打码；补裸 `refresh-token-xxx` 规则。

### 跨平台与闸门
- `ensure-archive` 改用 `resolveHome()`，在 `~/.dsh` / Windows 桌面版上闸门不再恒 false；加失败冷却（5 分钟内不再 spawn）。
- `offlineAgent` 能力闸：Node <22.15 没有 `zstdCompressSync` 时直接返回，不再累计 failCount 触发熔断。

### 面板与文档
- 打开面板轻量加载（`nolist=1`）：不扫会话列表、不扫 sessions 树；点“刷新列表”才全量。
- README 环境变量表补 7 个：归档闸门 / 门牌合并 / 索引目录 / 调试 / 标定 / 上弦目录。

## 六、0.2.18.2（2026-11-21 发布）

0.2.18.1 之后的修复作为 0.2.18.2 发布；以下内容均已落盘并通过测试。

### 1. 配置反复保存被写坏（根因修复）
- 问题：保存配置时保留注释把 `#` 前的空格吃掉，写成 `summaryClientPath: ""# 例：...`；YAML 把 `# 例...` 当成值的一部分，面板再保存时 `JSON.stringify` 不断加反斜杠，最终四行配置全坏。
- 修复：`保留注释更新()` 保留注释前至少一个空白；新增回归测试。
- 影响字段：`summaryClientPath`、`summaryApiUrl`、`archiveDir`、`mirrorDir`。
- 当前运行配置已恢复为空值。

### 2. 裁切成功状态残留旧失败原因
- 问题：只留摘要的成功路径只写 `ok:true`，没有清掉上一次的 `reason: archive-missing` 和 `detail`，面板显示“裁切成功但归档缺失”。
- 修复：只留摘要成功与普通成功路径都写 `fails:0, reason:'', detail:''`；当前 `prune-status.json` 已清理。

### 3. Windows 子进程隐藏窗口补齐
- 补 `windowsHide: true`：`ensure-archive` 的 execFile、`zstd-safe` 的 CLI 解压/压缩、`offline-clean` 的 taskkill/schtasks/systemctl/zstd、`rollback-stream-clean` 的 zstd。
- 相关文件共 23 处 `windowsHide`，符合“Windows 下不弹黑窗”的要求。

### 4. X-Forwarded-For 伪造加固
- 问题：只要开启 `trustProxy`，旧逻辑不看到底是谁连进来；公网直连带 `X-Forwarded-For: 100.64.1.1` 可冒充 tailnet 本机。
- 修复：
  - `dsh-toolbox/lib/auth.mjs`：只有 TCP 对端本身是回环（本机 nginx / tailscale serve）才读取 XFF；非回环直接按远程处理。
  - `dsh-log-prune/lib/index.js` 的 `guard()`：同样加 `isLoopback(req)` 条件。
  - 新增回归：公网直连 + 伪造 XFF + `trustProxy=1` 必须判为非本机。
- 当前网络状态：3099 只监听 `127.0.0.1`；ufw 只放行 22/80/8080；nginx 的 `$proxy_add_x_forwarded_for` 仍把真实 IP 放最后一跳。

### 5. 摘要触发线文档与兼容
- 问题：`summaryTrigger` 在面板/文档中写成“摘要后裁切线”，但运行时实际只看 `summaryPoint`；只有面板输入会同步两者。
- 修复：
  - 旧配置只写 `summaryTrigger`、没写 `summaryPoint` 时，自动把前者作为后者回退。
  - 面板、README、CONFIG、yml 模板统一改为“兼容/面板联动字段，实际派发看 summaryPoint”。
  - 不改变当前阈值：`summaryTrigger` 与 `summaryPoint` 仍为 40 万。

### 6. 文档同步
- 摘要派发改为说明“web 版优先进程内 agents，不填 `summaryClientPath` 也会自动排；只有进程内拿不到 agents 时才配 HTTP 兜底”。
- 补充 XFF 只信回环对端的说明。
- 模板与当前 `log-prune.yml` 的摘要线注释同步修正。

## 七、配套工具箱（dsh-toolbox）同批变更

工具箱没有独立版本线，当前 0.2.1.3；以下按 log-prune 发布批次记录。

- 新增 `lib/auth.mjs`：复用 log-prune 的 token / allowRemote / trustProxy，统一 9 条路由的鉴权。
- 新增 `lib/frame-writer.mjs`：修复写回改批帧，首帧一行 session header，其余 500 行/帧。
- 新增 `lib/archive-frames.mjs`：归档帧侧车检查/重建/批量修复，支持 dry-run、备份、回滚、写后校验。
- 新增 `lib/repair.mjs` 的 `makeSurfaceWalker`：前缀 fold O(n²) → O(n)。
- 新增 `lib/util.mjs`、`lib/hostdeps.mjs` 收敛；`findSessionDir` 加 sid→目录缓存。
- `client.js`：iframe token 走 postMessage 桥；页面隐藏时暂停 60 秒轮询；token 同步 cookie。
- `registerRoute` 统一鉴权；`/dsh-toolbox/version/check` 补回环校验；`archive/check`、`archive/rebuild` 加路径越界校验。
- 测试补到 31 条：归档帧、auth-XFF、frame-writer、repair、workspace 索引、孤儿 prune 等。
- 包声明 `dsh.bundle.patch` + `cordis.patch.yml`，可被 web profile 作为 bundle 加载。

## 八、升级与行为变化

### 运行要求
- Node >= 22.15 且内置 zstd（`zstdCompressSync` / `zstdDecompressSync`）；23.x 需 23.8+。
- DSH 宿主 >= 0.2.1-rc.2 < 0.3.0。
- 低于要求时插件拒绝激活，不做静默降级。

### 配置/状态兼容
- 新增配置只有 `allowRemote`（默认 false）及后续 `trustProxy`（默认 false）、`updateCheck`、`autoClean`、`cleanAtHour`、`cleanAtMinute` 等。
- `prune-status.json` 的 `orphanRisk` 兼容旧的字符串形状。
- `prune-tokens` 新增 `src` 字段，下一次探测自动升级。
- 从 0.2.17.x 升级后第一次运行会自动补原文覆盖，约 30 秒。

### 安全行为
- 默认只允许回环访问；远程需 `allowRemote: true` + token。
- `trustProxy` 默认 false；开启后也只对回环 TCP 对端的 XFF 生效。
- 写操作强制 JSON + Origin 校验。

### 摘要与裁切
- 摘要派发：web 版进程内 agents 优先；HTTP 客户端仅兜底。
- 强制裁切线仍为 `compactPoint × triggerRatio`；当前配置 650000 × 0.846 ≈ 55 万（面板显示预设 681574）。
- `keepTokens=100000` 是硬裁保底；`keepTurns=0` 表示不额外保证轮数。只留摘要路径不受 10 万保底约束。
- `autoClean` 默认关；开启后按配置时区每天执行，休眠/关机恢复不补跑。

## 九、验证记录

截至 2026-11-21 当前工作区：

- `dsh-toolbox`：31/31 测试通过。
- `dsh-log-prune`：63 个单测 + 14 个 e2e 全过。
- 两包所有 `.mjs/.js` 语法检查通过。
- 实际服务：`dsh.service` active，3099 只监听 127.0.0.1；ufw 只放行 22/80/8080。
- 接口：`/dsh-toolbox/version` 200；`/dsh-log-prune/config` 200。
- 启动日志：log-prune 自检“已是最新”，Node v24.22.2，zstd 读写/CLI 正常，agents 可用。
- 重启后无新的裁切/路由/摘要错误；历史 11-18 的 `summaryClientPath` 失败仅存在于旧日志。

## 十、已知限制与未完成

- Windows 实机项仍有待实测：B9/B10/W2、F5 跨午夜 schtasks、重启 bat 路径等。
- O4 checkpoint 续跑只做了 dry-run，真实中断演练需要停 DSH，尚未做。
- 长时间运行的内存峰值未压测；解压 150MB 级会话日志可能到 3–4GB，低内存机器建议用镜像/归档。
- `compactPoint=650000` 与当前预设 `681574` 仍不一致，实际强制线 55 万；已确认这是有意保留约 3 万 token 缓冲区，暂不修改。
- `keepTurns=0` 是当前配置，不是默认推荐；硬裁靠 10 万保底，摘要后的“只留摘要”路径不吃这 10 万。
- 自定义 `archiveDir` 时，toolbox 归档修复端点仍以默认归档目录做越界基准，尚未联动；当前配置为空，不受影响。

## 十一、结论

0.2.17.4 之后，log-prune 的主线变化是：从“依赖 agent 事件”转为“watcher 自主测量 + 到线裁切”，并在 0.2.18.1 完成了归档流式清理、解压上限、每日清理防循环、Windows 兼容、访问控制和大批正确性/性能修复。0.2.18.2 又补了配置持久化、状态清理、Windows 隐藏窗口、XFF 伪造防护和摘要线文档一致性。

本次已按 0.2.18.2 / toolbox 0.2.1.3 发版，并同步 `package.json`、`RELEASE-NOTES.md` 和 `README/CONFIG`。
