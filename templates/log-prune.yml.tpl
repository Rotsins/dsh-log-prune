# log-prune 配置（热更新：保存后立即生效，不用重启）
# 说明：这些数值互相联动，改之前先看每行的「联动/推荐」注释

# 时区：IANA 名称（如 Asia/Shanghai、America/New_York、UTC）。影响门牌日期、每日清理的 04:30、归档切片
# 改完立即生效；Node 的 ICU 不完整时会退回 DSH_TZ_OFFSET（分钟）
timezone: @@timezone@@

## —— 裁切 ——
# 裁切后至少保留最近几轮对话。太小会把刚说的话裁掉，太大会省得少
keepTurns: @@keepTurns@@           # 推荐 2~5

# 预设的官方压缩阈值（窗口 × thresholdRatio）。换预设、改预设阈值时必须同步这里
compactPoint: @@compactPoint@@   # 推荐 60~70 万（等于 100 万窗口 × 0.65）

# 强制裁切线 = compactPoint × triggerRatio。给官方压缩留兜底余量，别贴太近
triggerRatio: @@triggerRatio@@   # 推荐 0.80~0.90（当前 55/65 ≈ 0.846）

# 没有摘要时，裁切后保留多少 token；和 compactPoint 联动，约为窗口 10%
keepTokens: @@keepTokens@@     # 推荐 8~15 万

# 兼容/面板联动字段：改这里会同步 summaryPoint；实际摘要派发看 summaryPoint
summaryTrigger: @@summaryTrigger@@  # 推荐 35~45 万

# 单条 user 消息超过多少字就写盘，界面上只留一行【长文落盘】指针
longtextLimit: @@longtextLimit@@    # 推荐 6000~12000

# 新旧门牌合并：把旧门牌并进新门牌（默认关；开了会放开门牌区间的严格递增检查）
plateMerge: @@plateMerge@@

# —— O2 时代摘要合并 ——
# 门牌/旧摘要堆积到阈值时，派一次「合并模式」摘要任务：旧摘要 + 旧门牌合并成一份时代摘要 + 一块总门牌，
# 常驻 token 从「摘要×N + 门牌×M」收敛为常数。默认关，先在测试会话灰度跑稳再开。
eraMerge: @@eraMerge@@
eraMergePlates: @@eraMergePlates@@       # 门牌块数达到该值触发；推荐 3~6
eraMergeSummaries: @@eraMergeSummaries@@    # 旧摘要条数达到该值触发；推荐 2~3

# —— F2 会话 stream 置空（高危开关）——
# off = 不碰会话日志（现状）；empty = 把 assistant/message 的 data.stream 置为 []（不删字段）。
# 开 empty 的前提：《清理模块方案》3.1 静态取证 + 3.2 六项动态验证全部通过，缺一不可。
# 面板「清理」按钮真跑时每次只处理一个会话（分级放量），写后校验失败自动回滚并记 clean-broken.json。

# —— O3 后台预归档 ——
# token 接近摘要线（summaryPoint × preArchiveRatio）的会话，后台提前补归档；首次裁切不再现场等 60 秒
preArchive: @@preArchive@@
preArchiveRatio: @@preArchiveRatio@@

## —— 摘要任务 ——
# 插件是否自己给会话排摘要任务（关掉后只能手动排）
summaryEnabled: @@summaryEnabled@@

# 实际摘要触发线：token 到这个数就排一次摘要任务；面板上跟随 summaryTrigger
summaryPoint: @@summaryPoint@@   # 推荐 35~45 万
summaryIgnoreRatio: @@summaryIgnoreRatio@@   # 低于摘要阈值的这个比例就忽略任务；推荐 0.3~0.5

# 轮询间隔：多久扫一次各会话的 token 状态
summaryIntervalMs: @@summaryIntervalMs@@  # 推荐 10000~60000

# 同一会话两次摘要的最小间隔，防止反复唤醒
summaryCooldownMs: @@summaryCooldownMs@@  # 推荐 300000~900000

# 下面几项留空 = 用环境变量或内置默认值；换机器/换插件时只改这里
# ── 摘要派发（可选）：不填也能裁切，但不会自动排摘要任务 ──
# 摘要要用一个能 import 的客户端模块去调本机 API；在 DSH 安装目录里搜 "class NodeApiClient"，
# 找到的那个 .js 文件的绝对路径填到下面，Windows 用正斜杠或双反斜杠
summaryClientPath: @@summaryClientPath@@    # 例：C:/data/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js
# dsh web 的地址；不填用默认端口，填就写全，例 http://127.0.0.1:3080
summaryApiUrl: @@summaryApiUrl@@        # 例：http://127.0.0.1:3080
archiveDir: @@archiveDir@@           # 归档目录；留空用 <DSH_HOME>/记忆/日志存档
mirrorDir: @@mirrorDir@@            # 实时镜像目录；留空用 <DSH_HOME>/记忆/镜像

## —— 自动清理（每天定时派发离线清理）——
# 每天到点自动派发离线清理：停 DSH → 侧车+清理 → 校验 → 拉起。
# 默认关：不打开就不会自动跑，只能手动点面板「清理」。全局生效（会话覆盖不参与调度）。
# 只建议 7×24 运行的机器打开：这是一次真正的服务重启；笔记本/日常关机的机器
# 休眠或关机错过时间后不补跑（只容忍 5 分钟调度抖动），醒来不会被突然清理。
autoClean: @@autoClean@@
# 执行时间（24 小时制）：时 0~23，分 0~59；默认 4:30。下午四点三十写 16:30
cleanAtHour: @@cleanAtHour@@
cleanAtMinute: @@cleanAtMinute@@

## —— 更新检查 ——
# 允许插件自己去 GitHub 查新版本：每 6 小时最多一次，5 秒超时，失败静默
# 关掉后插件不发任何外网请求；面板上也有同名开关
updateCheck: @@updateCheck@@
# 打开面板时是否自动扫描会话列表（等同点「扫描」；默认关，打开面板不扫）
autoScan: @@autoScan@@

## —— 访问控制 ——
# 默认只允许本机访问面板与接口（remoteAddress 为回环地址）。
# 需要从别的机器访问（例如手机/平板看桌面版）时设为 true，
# 插件会把 token 注入页面，ui.js 自动带上；直接调 API 需要请求头 x-lp-token。
# token 存在 <DSH_HOME>/state/access-token.json（0600），重启不变；删掉该文件即轮换。
#
# ⚠️ 本插件默认假设「直连」：remoteAddress 就是客户端真实地址，X-Forwarded-For 默认忽略（可伪造）。
# 如果在前面加了 nginx / caddy / tailscale serve 等反向代理，remoteAddress 会变成代理地址
# （通常是 127.0.0.1），本机判定会把公网请求当成「本机」放行。此时请：
#   ① 在宿主层加认证（推荐）；② 用防火墙限制插件端口只允许本机访问；
#   ③ 确认反代会**覆盖**客户端自带的 X-Forwarded-For 后，才把下面的 trustProxy 设为 true。
trustProxy: @@trustProxy@@
allowRemote: @@allowRemote@@

## —— 检索明文副本（被裁原文的可 grep 全文，落 <DSH_HOME>/state/prune-index/<sid>/<day>.txt）——
# 关掉后仍保留轻索引（首句+关键词），log_prune_search 仍可用，只是当天未日封的段读不到全文
plainEnabled: @@plainEnabled@@

# 单条正文写盘前截断的字数；tool 结果是体积主因。0 = 不截断（不建议）
plainMaxChars: @@plainMaxChars@@    # 推荐 10000~40000

# 明文 .txt 保留天数，超过自动删（.txt 是「当天裁的当天能读全文」的便利层，过期该删）
plainKeepDays: @@plainKeepDays@@       # 推荐 14~60

# O1 检索层永续化：轻索引 .idx 的保留天数；0 = 永久。每条约 200~300 字节，一年万条级也就几 MB。
# 永久保留后，log_prune_search 对任意历史都有效；.txt 过期后读原文走归档直读兜底（log_prune_read 内置）。
idxKeepDays: @@idxKeepDays@@          # 0 = 永久；想省盘可设 180~365

# 写盘前是否对疑似密钥/token/密码脱敏（明文让密钥变成 grep 可捞，建议保持开）
plainRedact: @@plainRedact@@

## —— 交接（给别的插件/agent 用）——
# 裁切后是否把这段内容写清单 + 发事件，方便记忆/日记插件接走；默认关
handoffEnabled: @@handoffEnabled@@

# 是否发事件 log-prune/pruned（同进程的插件可以 ctx.on 订阅）
handoffEvent: @@handoffEvent@@

# 清单输出目录；留空用 <DSH_HOME>/state/pruned-outbox
handoffDir: @@handoffDir@@
