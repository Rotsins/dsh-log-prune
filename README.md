# dsh-log-prune

给 DeepSeek Harness 的上下文裁切插件：按 token 预算把最早几轮对话换成一行「日期门牌」（只改工作台视图，不删日志），并在到线时自动给会话排「写摘要」任务。附带一个可以拖动、展开的「日志裁切」配置面板。

## 它做什么

- **裁切**：上下文接近压缩线时，从最早一轮往后累加，剩到保留线就停；被裁的段落换成一行门牌：`[2026-11-13 全天记录已归档 · 346 条 · 原文 <归档文件> · 翻原文 … #seq=… · 搜词 …]`
- **摘要**：token 过摘要线时，用本机 API 给会话排一条「【裁切摘要】」任务，把跨越区间压成一段摘要；之后到更高线再裁时，摘要之前的内容整段裁掉
- **长文落盘**：单条 user 消息超过阈值就写盘，界面上只留一行指针，不占上下文
- **交接（默认关）**：裁掉的内容写成清单 JSON，并发一个事件，方便记忆/日记类插件接走
- **配置面板**：左下角/可拖动的「日志裁切」按钮，点开可改全局参数，也能按会话单独覆盖

## 安装

要求：`@deepseek-ai/dsh` >= 0.2.1-rc.2 < 0.3.0，Node 20+。0.2.1 上未实测，若报接口缺失请回退到 0.2.2-rc.1 以上。

1. 把本包放到任意目录，例如 `~/.dsh/plugins/dsh-log-prune`。
2. 在 profile 目录里链接它（二选一）：
   - 在 `$DSH_HOME/profiles/web/package.json` 的 dependencies 加 `"dsh-log-prune": "link:/绝对路径/dsh-log-prune"` 后跑一次 `pnpm install`
   - 或直接建软链：`ln -s /绝对路径/dsh-log-prune $DSH_HOME/profiles/web/node_modules/dsh-log-prune`
3. 二选一挂载（不要同时用，否则会重复加载）：
   - **bundle 形式（推荐，桌面版/只认 bundle 的版本）**：把 `dsh-log-prune` 加进 profile 的 `dsh.profile.bundles` 列表即可，包内 `cordis.patch.yml` 会自己声明
   - 预设行形式（web 版）：在预设的 cordis patch 里加一行，见下

```yaml
- id: log-prune
  name: dsh-log-prune
  disabled: false
```

4. 重启 DSH。启动后页面上会出现「日志裁切」小按钮。

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

- 配置文件：`$DSH_HOME/state/log-prune.yml`（首次启动自动生成，带注释和推荐值；改完下一轮生效，不用重启）
- 会话级覆盖：`$DSH_HOME/state/log-prune-sessions.json`（只存与全局不同的字段）
- 面板读取的接口是 `GET/POST /dsh-log-prune/config`，由插件自己注册，不经过 /api 前缀

主要字段：

| 字段 | 含义 | 推荐 |
|---|---|---|
| keepTurns | 裁切后至少保留最近几轮 | 2–5 |
| compactPoint | 预设的官方压缩阈值（窗口 × thresholdRatio） | 60–70 万 |
| triggerRatio | 强制裁切线 = compactPoint × 本比例 | 0.80–0.90 |
| keepTokens | 无摘要时裁完保留多少 token | 8–15 万 |
| summaryTrigger | 有摘要后到多少 token 就裁摘要前内容 | 35–45 万 |
| longtextLimit | 单条 user 消息超过多少字落盘 | 6000–12000 |
| summaryPoint | 摘要触发线 | 与 summaryTrigger 同值 |
| summaryIntervalMs | 轮询间隔 | 10000–60000 |
| summaryCooldownMs | 同一会话两次摘要的最小间隔 | 300000–900000 |

### 摘要派发怎么配

摘要不是必须的：不配也能裁切，只是不会自动排摘要任务。

要开摘要，需要两样：

1. `summaryClientPath`：一个导出 `NodeApiClient` 的模块绝对路径。在 DSH 安装目录里搜 `class NodeApiClient`，把命中的 .js 文件路径填进来。
2. `summaryApiUrl`：本机 `dsh web` 的地址，例如 `http://127.0.0.1:3080`；不填用默认端口。

Windows 路径用正斜杠（`C:/...`）或双反斜杠。配好重启后，日志里会写「已排摘要」，失败也会给出原因。

```yaml
summaryApiUrl: "http://127.0.0.1:3080"
summaryClientPath: "C:~/.dsh/.../client.node.js"
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
3. 都没有时，直接读 DSH 自己的会话日志 `$DSH_HOME/sessions/*/<sid>/session.v4.jsonl.zstd` 兜底

所以别的机器不需要额外装镜像/归档插件也能跑；想用自己的路径，在配置里填 `archiveDir` / `mirrorDir` 即可。

zstd 解压也不依赖系统命令：优先用 Node 内置 zstd，其次系统 `zstd`，最后用插件内置的纯 JS 解码器（`lib/vendor/fzstd`）——Windows 不装 zstd 也能裁。

## 环境变量（都可选）

| 变量 | 默认 | 用途 |
|---|---|---|
| DSH_HOME | ~/.dsh | 状态目录根 |
| DSH_LOG_PRUNE_CONFIG | $DSH_HOME/state/log-prune.yml | 配置文件 |
| DSH_LOG_PRUNE_SESSIONS | $DSH_HOME/state/log-prune-sessions.json | 会话覆盖 |
| DSH_LOG_PRUNE_TOKDIR | $DSH_HOME/state/prune-tokens | token 状态目录 |
| DSH_LOG_ARCHIVE | $DSH_HOME/记忆/日志存档 | 原文归档目录 |
| DSH_LOG_MIRROR | $DSH_HOME/记忆/镜像 | 实时镜像目录 |
| DSH_LOG_PRUNE_LONGTEXT_DIR | $DSH_HOME/inbox/longtext | 长文落盘目录 |
| DSH_LOG_PRUNE_FUSE | $DSH_HOME/state/prune-broken.json | 熔断名单 |
| DSH_DAY_CUT_FILE | $DSH_HOME/state/day-cut.json | 作息日切点（{"hour":5}） |
| DSH_LOG_PRUNE_DRY | 空 | 设为 1 只打日志不真裁 |

## 注意

- 只替换工作台视图，不删日志；每个要裁的节点必须已经进归档/镜像，否则跳过
- 裁切失败会重试两次，连续三次被核心拒绝就熔断该会话，并往会话里留一条提示
- 「交接」默认关：打开后往 $DSH_HOME/state/pruned-outbox/ 写清单并可选发事件
- 面板是通过往页面注入脚本实现的（不依赖 dsh.client 模块图），所以在任意页面都能打开
