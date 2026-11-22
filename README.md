# dsh-log-prune

> 前置插件：[dsh-toolbox](https://github.com/Rotsins/dsh-toolbox) 版本 ≥ 0.2.1

> 安装步骤见 [INSTALL.md](INSTALL.md)，配置项与调参见 [CONFIG.md](CONFIG.md)；本文档偏功能概览。

给 DeepSeek Harness 的上下文裁切插件：按 token 预算把最早几轮对话换成一行「日期门牌」（只改工作台视图，不删日志），并在到线时自动给会话排「写摘要」任务。配置面板以工具箱里的「日志裁切」页签形式打开。

## 它做什么

- **裁切**：上下文接近压缩线时，从最早一轮往后累加，剩到保留线就停；被裁的段落换成一行门牌：`[2026-11-13 全天记录已归档 · 346 条 · 原文 <归档文件> · 翻原文 … #seq=… · 搜词 …]`
- **摘要**：token 过摘要线时，用本机 API 给会话排一条「【裁切摘要】」任务，把跨越区间压成一段摘要；之后到更高线再裁时，摘要之前的内容整段裁掉
- **长文落盘**：单条 user 消息超过阈值就写盘，界面上只留一行指针，不占上下文
- **交接（默认关）**：裁掉的内容写成清单 JSON，并发一个事件，方便记忆/日记类插件接走
- **配置面板**：工具箱里的「日志裁切」页签，打开后可改全局参数，也能按会话单独覆盖

## 安装

要求：`@deepseek-ai/dsh` >= 0.2.1-rc.2 < 0.3.0，**Node >= 22.15 且内置 zstd**（与 `package.json` 的 engines 一致；22.15 起自带 zstd，Windows 不必额外装 zstd 命令行）。低于此版本插件会拒绝激活；23.x 需 23.8+（内置 zstd 才可用）。0.2.1 上未实测，若报接口缺失请回退到 0.2.2-rc.1 以上。

> **提示**：配套工具箱要求 **`dsh-toolbox >= 0.2.1`**（当前发布包配套 0.2.1.3）。工具箱是硬前置，缺了或 `apiVersion`/必需方法不匹配时，裁切插件会拒绝激活。

> **预设阈值要求**：官方压缩阈值必须大于摘要线和强制裁切线（`compactPoint × triggerRatio`）；否则官方压缩会先发生，摘要和裁切不会触发。例如 V3 预设 25 万压缩时，不能沿用 40 万摘要线/55 万裁切线。

1. 把本包放到任意目录，例如 `~/.dsh/plugins/dsh-log-prune`。
2. 在 profile 目录里链接它（二选一）：
   - 在 `$DSH_HOME/profiles/web/package.json` 的 dependencies 加 `"dsh-log-prune": "link:/绝对路径/dsh-log-prune"` 后跑一次 `pnpm install`
   - 或直接建软链：`ln -s /绝对路径/dsh-log-prune $DSH_HOME/profiles/web/node_modules/dsh-log-prune`
3. 二选一挂载（不要同时用，否则会重复加载）：
   - **bundle 形式（推荐，所有预设共用）**：把 `dsh-toolbox` 和 `dsh-log-prune` 都加进 profile 的 `dsh.profile.bundles`（toolbox 在前），两个包内的 `cordis.patch.yml` 会自己声明
   - 预设行形式（仅旧配置/单预设调试，不推荐）：在预设的 cordis patch 里加一行，见下；toolbox 也必须在同一组合里

```yaml
- id: log-prune
  name: dsh-log-prune
  disabled: false
```

4. 重启 DSH。工具箱里会出现「日志裁切」页签。
5. **补归档脚本（归档闸门）**：tgz 已自带 `bin/archive-sessions.mjs`，插件会自动找（优先 `$DSH_HOME/bin/archive-sessions.mjs`，没有则用插件自带的 `bin/`）。首次装完建议手动跑一次，生成水位和归档目录：

   ```sh
   node <插件目录>/bin/archive-sessions.mjs
   ```

   Windows 桌面端（Electron）调用脚本时插件已内置 `ELECTRON_RUN_AS_NODE=1`；若运行时 node 不在 PATH，可设环境变量 `DSH_NODE` 指向 node.exe。

   注意：`--dry` 也会解压读取全部会话（只统计、不写盘），会话多时慢是正常的，不是卡住。

## 清理（可选）

- **归档清理（F1）**：面板「清理」→ dry 预览 → 确认。归档是插件内部数据，DSH 不加载，**不需要重启**。
- **会话日志清理（F2）**：**默认禁用**。DSH 0.2.2 载入会话时要求 `assistant/message.data.stream` 是数组，剥掉会让会话打不开（2026-11-19 事故）；当前代码只扫描、不写回。
- **配套脚本**（Node 22.15+，均已随包）：
  - `bin/rollback-stream-clean.mjs`：从 `.bak-stream-*` 恢复被误剥的会话（默认 dry，`--apply` 执行）；
  - `bin/probe-settlement-shape.mjs`：只读取证 DSH 的 seed 校验器与 `stream` 使用点；
  - `bin/verify-stream-strategy.mjs`：影子实例验证（默认只写影子目录）；
  - `lib/session-clean-v2.mjs`：四闸门清理（默认 dry，`--canary --apply` 金丝雀）。
- **会话历史备份**：`*.bak-*` 可在确认不需要后移到冷备目录，避免长期占空间。

## 装不上时先自检

```sh
node <插件目录>/bin/doctor.mjs [profile 目录]
```

它会依次检查：包能不能从 profile 解析到、入口 import 是否通过、apply 能不能挂上两个路由和页面注入钩子。哪一步红，就是卡在哪。

## 会话被写坏时

症状：`session event at seq N lacks an identified message`，会话打不开。

```sh
node <插件目录>/bin/repair-session.mjs <会话id> --dry   # 先看要删几条
node <插件目录>/bin/repair-session.mjs <会话id>         # 自动备份后修
```

它会删掉没有消息 id 的 user/message 事件，以及引用它们的孤儿 compaction/prune 事件；原文件备份在 `.bak-<时间>`。

## 配置

- 配置文件：`$DSH_HOME/state/log-prune.yml`（首次启动自动生成，带注释和推荐值；改完立即生效，不用重启）
- 会话级覆盖：`$DSH_HOME/state/log-prune-sessions.json`（只存与全局不同的字段）
- 面板读取的接口是 `GET/POST /dsh-log-prune/config`，由插件自己注册，不经过 /api 前缀

主要字段：

| 字段 | 含义 | 推荐 |
|---|---|---|
| keepTurns | 裁切后至少保留最近几轮 | 2–5 |
| compactPoint | 预设的官方压缩阈值（窗口 × thresholdRatio） | 60–70 万 |
| triggerRatio | 强制裁切线 = compactPoint × 本比例 | 0.80–0.90 |
| keepTokens | 无摘要时裁完保留多少 token | 8–15 万 |
| summaryTrigger | 兼容/面板联动字段；实际摘要派发看 summaryPoint | 35–45 万 |
| longtextLimit | 单条 user 消息超过多少字落盘 | 6000–12000 |
| summaryPoint | 实际摘要触发线 | 与 summaryTrigger 同值 |
| summaryIntervalMs | 轮询间隔 | 10000–60000 |
| summaryCooldownMs | 同一会话两次摘要的最小间隔 | 300000–900000 |

### 摘要派发怎么配

摘要不是必须的：不配也能裁切；web 版即使不填 `summaryClientPath`，只要进程内 agents 可用也会自动排摘要。

web 版优先走**进程内 agents 服务**派发，正常不需要填下面两项；只有进程内拿不到 agents（例如某些桌面/独立进程）时，才需要 HTTP 兜底：

1. `summaryClientPath`：一个导出 `NodeApiClient` 的模块绝对路径。在 DSH 安装目录里搜 `class NodeApiClient`，把命中的 .js 文件路径填进来。
2. `summaryApiUrl`：本机 `dsh web` 的地址，例如 `http://127.0.0.1:3080`；不填用默认端口。

Windows 路径用正斜杠（`C:/...`）或双反斜杠。配好重启后，日志里会写「已排摘要」，失败也会给出原因。

```yaml
summaryApiUrl: "http://127.0.0.1:3080"
summaryClientPath: "<DSH_HOME>/.../client.node.js"
```

## 命令行

```sh
node <插件目录>/bin/log-prune.mjs reset-global            # 全局重置为默认值
node <插件目录>/bin/log-prune.mjs reset-session <会话id>  # 清掉某个会话的覆盖
node <插件目录>/bin/log-prune.mjs list                    # 看当前覆盖
```

## 归档 / 镜像（裁切的前置条件）

裁切前必须确认被裁的事件「原文还在」。插件按顺序找证据：

1. `archiveDir`（默认 `$DSH_HOME/记忆/日志存档`，文件名 `*<sid>.日志`，zstd 压缩的 JSONL）
2. `mirrorDir`（默认 `$DSH_HOME/记忆/镜像`，文件名 `*_<sid>.jsonl`）
3. 都没有时，直接读 DSH 自己的会话日志 `$DSH_HOME/sessions/*/<sid>/session.v<N>.jsonl[.zstd]` 兜底；按最高 schema 版本选文件，同版本优先 zstd，未压缩版本只在没有 zstd 时使用

所以别的机器不需要额外装镜像/归档插件也能跑；想用自己的路径，在配置里填 `archiveDir` / `mirrorDir` 即可。

zstd 解压也不依赖系统命令：优先用插件内置的纯 JS 解码器（`lib/vendor/fzstd`，能解多帧），其次系统 `zstd`，最后用 Node 内置 zstd 兜底（部分 Node 版本只解首帧）——Windows 不装 zstd 也能裁。压缩优先用 Node 内置 zstd，缺了才回退系统 `zstd`。

## 环境变量（都可选）

| 变量 | 默认 | 用途 |
|---|---|---|
| DSH_HOME | `<DSH_HOME>`（本机数据根） | 状态目录根 |
| DSH_LOG_PRUNE_CONFIG | $DSH_HOME/state/log-prune.yml | 配置文件 |
| DSH_LOG_PRUNE_SESSIONS | $DSH_HOME/state/log-prune-sessions.json | 会话覆盖 |
| DSH_LOG_PRUNE_TOKDIR | $DSH_HOME/state/prune-tokens | token 状态目录 |
| DSH_LOG_ARCHIVE | $DSH_HOME/记忆/日志存档 | 原文归档目录 |
| DSH_LOG_MIRROR | $DSH_HOME/记忆/镜像 | 实时镜像目录 |
| DSH_LOG_PRUNE_LONGTEXT_DIR | $DSH_HOME/inbox/longtext | 长文落盘目录 |
| DSH_LOG_PRUNE_FUSE | $DSH_HOME/state/prune-broken.json | 熔断名单 |
| DSH_DAY_CUT_FILE | $DSH_HOME/state/day-cut.json | 作息日切点（{"hour":5}） |
| DSH_LOG_PRUNE_DRY | 空 | 设为 1 只打日志不真裁 |
| DSH_ARCHIVE_WM | $DSH_HOME/state/archive-watermark.json | 归档水位（裁切前的「原文已另存」硬闸门用） |
| DSH_ARCHIVE_SCRIPT | 自动找（$DSH_HOME/bin → 插件 bin） | 补归档脚本路径（闸门未过时现场调它补） |
| DSH_PRUNE_PLATE_MERGE | 空 | 设为 1 启用「新旧门牌合并」（默认关；会放开门牌区间严格递增检查） |
| DSH_LOG_PRUNE_INDEXDIR | $DSH_HOME/state/prune-index | 检索明文副本目录 |
| DSH_LOG_PRUNE_DEBUG | 空 | 设为 1 输出诊断日志（默认静默） |
| DSH_LOG_PRUNE_CALIB | $DSH_HOME/state/prune-calib.json | 摘要点标定缓存 |
| DSH_LOG_PRUNE_ARMEDDIR | $DSH_HOME/state/prune-armed | 上弦/激发态状态目录 |
| DSH_TZ | 空 | 时区默认值；yaml 未写时生效，离线清理脚本也继承 |
| DSH_TZ_OFFSET | 空 | ICU 不完整时的分钟偏移兜底（东八区 480） |
| DSH_TRUST_PROXY | 空 | 1=信任反代 XFF 最后一跳；0=强制关闭；空=读 yaml `trustProxy` |

> 安装依赖：**全局 Node 必须 >= 22.15 且内置 zstd**（`zstdCompressSync` / `zstdDecompressSync`）。低于 22.15 或缺少内置 zstd 时，插件会在启动阶段拒绝激活；不要用旧 Node 只跑在线裁切——裁切后的清理/修复没有 zstd 兜底，可能损坏会话。

## 访问控制与已知局限（0.2.18 起）

宿主的登录认证只保护页面本身；插件用 `webServer.register` 注册的 `/dsh-log-prune/*` 路由不经过它。所以插件自己做了一层守卫：

- **本机访问**（`remoteAddress` 是 127.x / ::1 / unix socket）：直接放行，不需要任何 token。桌面端和 Linux web 的本机浏览器都走这条
- **非本机访问**：默认 403。需要手机/平板访问时，把配置里 `allowRemote` 设为 `true`；此后页面会自动注入 token，直接调 API 需要请求头 `x-lp-token`
- **反向代理**：默认不读 `X-Forwarded-For`。只有确认反代会覆盖该头时，才设 `trustProxy: true`（或 `DSH_TRUST_PROXY=1`）；开启后也只对**来自回环 TCP 对端**的请求读取该头，公网直连即使伪造 `100.64.x.x` 仍按远程走 `allowRemote` + token。未开时若反代把 `remoteAddress` 变成 127.0.0.1，会被当作本机放行，所以反代部署必须同时加宿主认证/防火墙。
- **写操作**（POST/PUT/DELETE/PATCH）：强制 `Content-Type: application/json`，并校验 `Origin` 与请求 `Host` 同源。浏览器里的跨站页面（含 `<form>`、`no-cors fetch`、sandbox iframe）发不出 JSON 的简单请求，CSRF 路径因此关闭

token 存在 `$DSH_HOME/state/access-token.json`（0600），重启不变；删掉该文件重启即轮换。

| 风险 | 触发条件 | 状态 |
|---|---|---|
| 跨站 JSON fetch | 恶意页面用 JS 发 JSON POST | ✅ 已挡（preflight 被浏览器拦） |
| 跨站 form / no-cors / sandbox iframe | 简单请求 CSRF | ✅ 已挡（强制 JSON Content-Type） |
| 反向代理前置 | 在插件前加 nginx / caddy / cloudflare | ⚠️ 默认不信任 `X-Forwarded-For`；未开 `trustProxy` 时 `remoteAddress` 变成 127.0.0.1，公网请求会被当本机放行。确认反代会覆盖该头后才开 `trustProxy`，并同时用宿主认证/防火墙限制端口 |
| token 文件泄露 | 本机其他用户读 `state/access-token.json` | ⚠️ 0600 + 目录权限；删文件重启即轮换 |
| token 暴力猜 | 公网暴露 + `allowRemote: true` | ✅ 128 bit 随机，不可行；但公网暴露前请先加宿主认证 |
| 解压内存峰值 | 会话日志 > 100MB | ⚠️ 解压 153MB 压缩文件时，内存峰值约 3–4 GB（Buffer → UTF-16 字符串 → 行数组）。低内存机器建议改用镜像/归档 |
| 修复重写内存峰值 | 对超大会话跑「修复」 | ⚠️ `repairOrphans` 一次性 `Buffer.concat` 所有保留帧，峰值约 1 GB；低频操作，可接受 |

## 注意

- 只替换工作台视图，不删日志；每个要裁的节点必须已经进归档/镜像，否则跳过
- 裁切失败会重试两次，连续三次被核心拒绝就熔断该会话，并往会话里留一条提示
- 「交接」默认关：打开后往 $DSH_HOME/state/pruned-outbox/ 写清单并可选发事件
- 面板是通过往页面注入脚本实现的（不依赖 dsh.client 模块图），所以在任意页面都能打开
