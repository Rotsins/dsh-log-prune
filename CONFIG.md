# dsh-log-prune 配置说明

版本：**0.2.18.2**。配置文件改完**立即生效，不用重启**；面板保存后立即写盘。

> Windows 下 `$DSH_HOME` 是实际数据根（插件会探测 `C:\data\dsh` 和 `%USERPROFILE%\.dsh`，也可用环境变量指定）；本文统一用 `$DSH_HOME` 表示。

## 1. 配置文件与优先级

| 文件 | 作用 |
|---|---|
| `$DSH_HOME/state/log-prune.yml` | 全局配置；首次启动自动生成，带注释和推荐值 |
| `$DSH_HOME/state/log-prune-sessions.json` | 会话级覆盖；只存与全局不同的字段 |

优先级从低到高：

1. **环境变量默认层**：只有 `DSH_LOG_PRUNE_KEEP`、`DSH_LOG_PRUNE_COMPACT`、`DSH_LOG_PRUNE_TRIGGER_RATIO`、`DSH_LOG_PRUNE_KEEP_TOKENS`、`DSH_LOG_PRUNE_SUMMARY_TRIGGER`、`DSH_LOG_PRUNE_LONGTEXT` 这 6 个数值项会被当作默认值；yaml 里写了就以 yaml 为准。
2. **全局 yaml**。
3. **会话覆盖** `log-prune-sessions.json`；但「其他设置」整组（`updateCheck`、`autoScan`、`autoClean`、`cleanAtHour`、`cleanAtMinute`、`timezone`、`handoffEnabled`、`handoffEvent`）只认全局，旧会话覆盖里的同名键会被忽略。

面板底部的三个按钮：

- **保存到当前会话**：把当前面板值写进本会话覆盖，只存与全局不同的字段；
- **跟随全局**：删掉本会话覆盖，回到全局值；
- **保存到全局**：写全局 yaml（会弹确认框）。

「其他设置」整组是全局项：**改完自动保存**，不用点底部按钮；即使点「保存到当前会话」，这 8 个全局项也会被抬到全局，不会进会话覆盖。

`saveConfig` 每次写盘前会自动生成 `.bak-<时间>` 备份；文件里插件不认识的键会原样保留在末尾。

## 2. 裁切

| 字段 | 默认 | 范围/推荐 | 说明 |
|---|---:|---|---|
| `keepTurns` | 3 | 0–20，推荐 2–5 | 裁切后至少保留最近几轮，防止把刚说的话裁掉 |
| `compactPoint` | 650000 | >=50000，推荐 60–70 万 | 预设的官方压缩阈值（窗口 × thresholdRatio）；面板只读，换预设要同步 |
| `triggerRatio` | 0.846 | 0.3–1.0，推荐 0.80–0.90 | 强制裁切线 = `compactPoint` × 本比例，略早于官方压缩 |
| `keepTokens` | 100000 | >=10000，推荐 8–15 万 | 没有摘要时，裁切后保留多少 token |
| `summaryTrigger` | 400000 | >=50000，推荐 35–45 万 | 兼容/面板联动字段；改它会同步 `summaryPoint`，实际派发看 `summaryPoint` |
| `longtextLimit` | 8192 | >=1000，推荐 6000–12000 | 单条 user 消息超过多少字就写盘，界面只留一行「【长文落盘】」指针 |
| `archiveDir` | 空 | 留空用默认 | 归档目录；默认 `$DSH_HOME/记忆/日志存档` |
| `mirrorDir` | 空 | 留空用默认 | 实时镜像目录；默认 `$DSH_HOME/记忆/镜像` |
| `eraMerge` | false | 默认关 | 时代摘要合并：门牌/旧摘要堆积到阈值时，派一次「合并模式」摘要，把旧摘要+门牌收敛成时代摘要+总门牌 |
| `eraMergePlates` | 4 | 2–64 | 门牌块数达到该值触发合并；推荐 3–6 |
| `eraMergeSummaries` | 2 | 2–32 | 旧摘要条数达到该值触发合并；推荐 2–3 |
| `plateMerge` | false | 仅配置文件/环境变量 | 新旧门牌合并；默认关，打开会放开门牌区间严格递增检查 |

裁切的硬闸门：每个要裁的节点必须已经在归档/镜像里有原文，否则跳过。归档/镜像都没有时，会直接读 DSH 会话日志兜底。

## 3. 摘要任务

| 字段 | 默认 | 范围/推荐 | 说明 |
|---|---:|---|---|
| `summaryEnabled` | true | — | 插件是否自己给会话排摘要任务；关掉后只能手动排 |
| `summaryPoint` | 400000 | >=50000 | 实际摘要触发线；面板只读，跟随 `summaryTrigger` |
| `summaryIntervalMs` | 20000 | >=3000，推荐 10000–60000 | 多久扫一次各会话的 token 状态 |
| `summaryCooldownMs` | 600000 | >=30000，推荐 300000–900000 | 同一会话两次摘要请求的最小间隔 |
| `summaryIgnoreRatio` | 0.4 | 0.1–0.9 | 当前上下文低于摘要线这个比例就忽略任务；推荐 0.4 |
| `summaryApiUrl` | 空 | — | 派发摘要用的本机 API 地址，例 `http://127.0.0.1:3099`；留空用 `DSH_DISPATCH_API` 或默认端口 |
| `summaryClientPath` | 空 | — | HTTP 兜底用的 `NodeApiClient` 模块绝对路径；web 进程内 agents 可用时不用填 |
| `preArchive` | true | — | 接近摘要线时后台提前补归档，首次裁切不用现场等 |
| `preArchiveRatio` | 0.6 | 0.2–0.95，仅配置文件 | 预归档触发比例（× `summaryPoint`） |

> **前置条件**：预设的官方压缩阈值必须**大于**摘要线（`summaryPoint` / `summaryTrigger`）和强制裁切线（`compactPoint × triggerRatio`）。如果预设压缩阈值更低（例如 25 万），官方压缩会先发生，摘要和裁切不会触发；这时应提高预设阈值，或降低摘要/裁切配置，插件不会自动改。

摘要不是必须的：不配也能正常裁切。web 版优先走**进程内 agents 服务**派发，通常不需要填 `summaryClientPath` / `summaryApiUrl`。

只有进程内拿不到 agents 时才配 HTTP 兜底：

1. 在 DSH 安装目录里搜 `class NodeApiClient`，把命中的 .js 文件绝对路径填到 `summaryClientPath`；
2. 把本机 `dsh web` 地址填到 `summaryApiUrl`（例 `http://127.0.0.1:3099`）。

Windows 路径用正斜杠（`C:/...`）或双反斜杠。

## 4. 检索

| 字段 | 默认 | 范围/推荐 | 说明 |
|---|---:|---|---|
| `plainEnabled` | true | — | 写明文副本 `<day>.txt`，当天裁的内容当天能读全文 |
| `plainMaxChars` | 20000 | 0 或 1000–400000，推荐 10000–40000 | 单条正文写盘前截断字数；0 = 不截断（不建议） |
| `plainKeepDays` | 30 | 1–3650，推荐 14–60 | 明文 .txt 保留天数，过期自动删 |
| `idxKeepDays` | 0 | 0–3650，0 = 永久 | 轻索引 .idx 保留天数；每条约 200–300 字节，0 = 永久可搜 |
| `plainRedact` | true | 仅配置文件 | 写盘前对疑似密钥/token/密码脱敏；建议保持开 |

检索索引目录默认 `$DSH_HOME/state/prune-index`。`.txt` 过期后，读原文会走归档直读兜底。

## 5. 其他设置（整组全局）

| 字段 | 默认 | 范围 | 说明 |
|---|---:|---|---|
| `timezone` | `Asia/Shanghai` | IANA 名称 | 全插件时区：门牌日期、自动清理时间（`cleanAtHour`/`cleanAtMinute`，默认 04:30）、归档切片都按它算；改完立即生效。ICU 不完整时用 `DSH_TZ_OFFSET`（分钟）兜底 |
| `autoClean` | **false** | 开/关 | 每天自动派发离线清理；默认关，只建议 7×24 运行的机器打开。休眠/关机错过时间后不补跑（只容忍 5 分钟抖动），笔记本醒来不会被突然重启 |
| `cleanAtHour` | 4 | 0–23 | 自动清理的「时」，24 小时制；下午四点三十写 16 |
| `cleanAtMinute` | 30 | 0–59 | 自动清理的「分」 |
| `updateCheck` | true | 开/关 | 每 6 小时最多查一次 GitHub 新版本；关掉不发任何外网请求 |
| `autoScan` | false | 开/关 | 打开面板时自动扫描会话列表 |
| `handoffEnabled` | false | 开/关 | 裁切后写交接清单文件 |
| `handoffEvent` | true | 开/关 | 裁切后发事件 `log-prune/pruned` |
| `handoffDir` | 空 | 仅配置文件 | 交接清单输出目录；留空用 `$DSH_HOME/state/pruned-outbox` |

### 5.1 每天自动清理怎么开

1. 面板「其他设置」里把「每天自动清理」打开；
2. 把「自动清理时间」的时/分改成你要的点（默认 4:30）；
3. 改完自动保存到全局，**下一分钟调度就按新时间对表**，不用重启。

到点后插件会派发 `bin/offline-clean.mjs`：**关闭 DSH → 补侧车归档 → 清会话 `data.stream` + 清归档残留 stream → 全量校验 → 自动拉起 DSH**。同一天只派发一次；派发前会查运行锁，已有任务则跳过。

注意：

- 清理期间界面会断开，属正常；不要手动启动 DSH，脚本有 15 分钟保险丝兜底拉起；
- 默认是**关**的，不打开就不会自动跑，只能手动点「清理」；
- 兼容旧环境变量 `DSH_CLEAN_AT=HH:MM`：yaml 没写时作为时/分的默认值。

## 6. 仅配置文件 / 访问控制

| 字段 | 默认 | 说明 |
|---|---:|---|
| `allowRemote` | false | 非本机访问面板/接口；默认 403，开了之后页面自动带 token，直接调 API 需请求头 `x-lp-token` |
| `trustProxy` | false | 只有确认反代会覆盖 `X-Forwarded-For` 时才开；默认忽略该头（可伪造）。也可用 `DSH_TRUST_PROXY=1` 临时打开，`=0` 强制关闭 |
| `plateMerge` | false | 新旧门牌合并，见「裁切」 |
| `handoffDir` | 空 | 交接清单目录 |
| `plainRedact` | true | 检索明文脱敏 |
| `preArchiveRatio` | 0.6 | 预归档触发比例 |

> L4：token 文件在 `<DSH_HOME>/state/access-token.json`，Linux 上权限 0600。Windows / CIFS / NFS 等文件系统不保证 `mode` 生效；这些部署下不要把 `allowRemote` 开到公网，建议放在本机或 Tailscale 这类受信网络里。

访问控制补充：宿主的登录认证只保护页面本身，插件自己注册的 `/dsh-log-prune/*` 路由不经过它。本机（127.x / ::1 / unix socket）直接放行；非本机默认 403。token 在 `$DSH_HOME/state/access-token.json`（0600），删掉重启即轮换。

反向代理（nginx/caddy/cloudflare）默认不读取 `X-Forwarded-For`。未开 `trustProxy` 时，`remoteAddress` 会变成 127.0.0.1，本机判定会把公网请求当本机放行；此时必须用宿主认证或防火墙限制端口。只有确认反代会覆盖客户端自带的 `X-Forwarded-For` 后，才把 `trustProxy` 设为 true；开启后也只对**来自回环 TCP 对端**的请求读取该头，公网直连即使伪造 `100.64.x.x` 仍按远程走 `allowRemote` + token。

## 7. 环境变量（常用）

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_HOME` | 本机数据根 | 状态目录根 |
| `DSH_LOG_PRUNE_CONFIG` | `$DSH_HOME/state/log-prune.yml` | 全局配置文件 |
| `DSH_LOG_PRUNE_SESSIONS` | `$DSH_HOME/state/log-prune-sessions.json` | 会话覆盖 |
| `DSH_LOG_ARCHIVE` | `$DSH_HOME/记忆/日志存档` | 归档目录 |
| `DSH_LOG_MIRROR` | `$DSH_HOME/记忆/镜像` | 实时镜像目录 |
| `DSH_ARCHIVE_SCRIPT` | 自动找（`$DSH_HOME/bin` → 插件 `bin`） | 补归档脚本路径 |
| `DSH_ARCHIVE_WM` | `$DSH_HOME/state/archive-watermark.json` | 归档水位 |
| `DSH_LOG_PRUNE_LONGTEXT_DIR` | `$DSH_HOME/inbox/longtext` | 长文落盘目录 |
| `DSH_LOG_PRUNE_INDEXDIR` | `$DSH_HOME/state/prune-index` | 检索明文副本目录 |
| `DSH_LOG_PRUNE_FUSE` | `$DSH_HOME/state/prune-broken.json` | 熔断名单 |
| `DSH_DAY_CUT_FILE` | `$DSH_HOME/state/day-cut.json` | 作息日切点 |
| `DSH_TZ` | 空 | 时区默认值；yaml 未写时生效，离线清理脚本也继承 |
| `DSH_TZ_OFFSET` | 空 | ICU 不完整时的分钟偏移兜底（东八区 480） |
| `DSH_TRUST_PROXY` | 空 | 1=信任反代 XFF 最后一跳；0=强制关闭；空=读 yaml `trustProxy` |
| `DSH_LOG_PRUNE_DRY` | 空 | 设为 1 只打日志不真裁 |
| `DSH_PRUNE_PLATE_MERGE` | 空 | 设为 1 启用新旧门牌合并 |
| `DSH_CLEAN_AT` | `04:30` | 每日清理时间默认值（yaml 未写时） |
| `DSH_SYSTEMD_UNIT` | `dsh.service` | Linux 离线清理重启的 systemd 单元 |
| `DSH_RESTART_CMD` | 空 | 自定义 DSH 重启命令 |
| `DSH_OFFCLEAN_RESCUE_MIN` | 15 | 离线清理保险丝分钟数 |
| `DSH_NODE` / `DSH_EXE` | 空 | Windows 下 node.exe / DSH 可执行文件路径 |
| `DSH_LOG_PRUNE_DEBUG` | 空 | 设为 1 输出诊断日志 |

> 还有若干内部/调试变量（`DSH_LOG_PRUNE_STATUS`、`DSH_LOG_PRUNE_LOCKDIR`、`DSH_LOG_PRUNE_LANDING_WAIT` 等），普通使用不需要改。

## 8. 典型场景

### 8.1 只裁切，不要摘要

```yaml
summaryEnabled: false
```

裁切仍按 `keepTokens` 工作，只是不会自动给会话排摘要任务。

### 8.2 开摘要

```yaml
summaryEnabled: true
summaryClientPath: "<DSH 安装目录>/.../client.node.js"
summaryApiUrl: "http://127.0.0.1:3099"
summaryTrigger: 400000
summaryPoint: 400000
```

### 8.3 开每天自动清理

面板「其他设置」：打开「每天自动清理」，时/分设成目标时间。默认 4:30。

### 8.4 开检索明文

```yaml
plainEnabled: true
plainKeepDays: 30
idxKeepDays: 0
```

### 8.5 手机/平板访问

```yaml
allowRemote: true
```

然后通过宿主认证或防火墙限制端口；不要直接把插件端口暴露到公网。

### 8.6 门牌/摘要太多

先看面板「体积」确认占比；确实多时再考虑：

```yaml
eraMerge: true
eraMergePlates: 4
eraMergeSummaries: 2
```

`plateMerge` 更激进，会放开门牌区间严格递增检查，建议先在测试会话灰度。

## 9. 调参注意

- `compactPoint` 必须和当前预设的官方压缩阈值同步；换预设后要同步改，否则裁切线会算错。
- `triggerRatio` 不要贴 1.0，给官方压缩留余量；推荐 0.80–0.90。
- `keepTokens` 与摘要触发线（`summaryPoint`）别设得太近，否则裁完很快又到线。
- 改 yaml 后立即生效；每日清理调度每分钟读一次配置，改时间下一分钟就按新时间排。
- 「其他设置」是全局项，不要指望写进会话覆盖生效。
- 真跑清理前，先点「清理」做 dry 预检；日志首行有简报，dry 会标「（预检，未修改）」。
- 清理失败会自动全量回滚；原文件备份在各自目录的 `.bak-stream-*`，确认没问题后再清理备份。
