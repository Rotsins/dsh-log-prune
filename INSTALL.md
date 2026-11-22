# dsh-log-prune 安装说明

版本：**0.2.18.2**（适用于 DeepSeek Harness 0.2.x，`>=0.2.1-rc.2 <0.3.0`）

> 前置插件：[dsh-toolbox](https://github.com/Rotsins/dsh-toolbox) 版本 ≥ 0.2.1

> 这里的 0.2.x 指**宿主 dsh 包**的版本；Windows 桌面安装包版本是 2.0.x（例如 2.0.19.0），两者不是一回事。

这个插件做三件事：按 token 预算把最早的对话换成「日期门牌」、到线时自动排「写摘要」任务、以及在面板里手动/定时做离线深度清理。安装本身不需要改 DSH 源码。

## 1. 前置要求

- **DSH**：0.2.x 系列（`package.json` 的 peerDependencies 为 `>=0.2.1-rc.2 <0.3.0`）。
- **Node**：**>= 22.15 且内置 zstd**（`engines` 要求）。22.15 起自带 zstd，Windows 不必额外装 `zstd` 命令行。低于 22.15 或缺少内置 zstd 时插件会拒绝激活（23.x 需 23.8+）；不要用旧 Node 只跑在线裁切，裁切后的清理/修复没有兜底。
- **预设阈值**：官方压缩阈值必须大于摘要线和强制裁切线（`compactPoint × triggerRatio`）。如果预设压缩阈值更低（如 V3 25 万），官方压缩会先发生，摘要和裁切不会触发；此时提高预设阈值，或把摘要/裁切线降到压缩线以下。
- **平台**：Linux / macOS / Windows 桌面端。Linux 的离线清理依赖 systemd；Windows 走 Electron + 隐藏窗口，不需要额外服务。
- **磁盘**：插件目录、`$DSH_HOME/state`、归档目录需要可写；离线清理会临时停 DSH，执行前请确认没有正在跑的任务。
- **前置插件**：必须同时安装 **[dsh-toolbox](https://github.com/Rotsins/dsh-toolbox) 版本 ≥ 0.2.1**（当前发布配套 0.2.1.3），先确认它的日志出现「服务已提供」再装本插件；本插件 `inject` 含 `toolbox`，缺了会拒绝激活。

## 2. 安装步骤

### 2.1 放置插件

把包放到 DSH 的插件目录，例如：

```sh
/data/dsh/plugins/dsh-log-prune
```

桌面版通常是用户目录下的 `.dsh/plugins/dsh-log-prune`；下文用 `<插件目录>` 代指实际路径。

如果是 tgz 包，解压后把 `package/` 里的内容合并到插件目录；Linux/macOS 可一步到位：

```sh
tar -xzf dsh-log-prune-0.2.18.2.tgz -C <插件目录> --strip-components=1
```

### 2.2 链接到 profile

编辑 `<DSH_HOME>/profiles/<profile>/package.json`，在 `dependencies` 里加一行（用绝对路径）：

```json
"dsh-log-prune": "link:/绝对路径/dsh-log-prune"
```

然后在 profile 目录执行一次安装：

```sh
cd <DSH_HOME>/profiles/<profile>
pnpm install
```

> Windows 桌面版 PATH 里通常没有 `node`/`pnpm`，直接执行 `pnpm install` 会报「不是内部或外部命令」。桌面版通常**不需要 pnpm**：直接在 `node_modules` 建 junction（`mklink /J`），或在 `dependencies` 写 `link:` 即可。确需 pnpm 时用 DSH 自带 runtime：
>
> ```cmd
> "%DSH%\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe" "%DSH%\resources\app.asar.unpacked\node_modules\pnpm\bin\pnpm.cjs" install
> ```

如果不想动 `package.json`，也可以直接建软链（效果相同）：

```sh
ln -s /绝对路径/dsh-log-prune <DSH_HOME>/profiles/<profile>/node_modules/dsh-log-prune
```

### 2.3 挂载插件（推荐两个都 bundle）

**方式 A：bundle 形式（推荐，所有预设共用）**

在 profile 的 `package.json` 里，把 `dsh-toolbox` 和 `dsh-log-prune` 都加进 `dsh.profile.bundles`（toolbox 必须在前）：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-toolbox",
      "dsh-log-prune"
    ]
  }
}
```

两个包内的 `cordis.patch.yml` 会自动声明插件，不需要再写预设行。只装裁切、不装工具箱会拒绝激活。

**方式 B：预设行形式（仅旧配置/单预设调试，不推荐）**

在 profile 的 `cordis.patch.yml`（或正在用的预设文件）里加：

```yaml
- id: log-prune
  name: dsh-log-prune
  disabled: false
```

> 两种方式同时用会重复加载，插件会注册两次、按钮/路由冲突。只选一种。

### 2.4 重启 DSH

```sh
systemctl restart dsh        # Linux systemd
```

桌面版：托盘右键「退出」再重新打开，或运行 `"DSH NEXT.exe" --dsh-installer-quit`；**不要用 taskkill**（会绕过 before-quit，框架按非正常退出处理）。Linux systemd 用上面的命令。启动后页面/工具箱里会出现「日志裁切」入口。

### 2.5 首次补归档（建议）

插件裁切前必须确认「被裁的原文还在」。首次装完建议手动跑一次归档脚本，生成水位和归档目录：

```sh
node <插件目录>/bin/archive-sessions.mjs
```

- 默认写到 `$DSH_HOME/记忆/日志存档`；
- `--dry` 也会解压读取全部会话（只统计、不写盘），会话多时慢是正常的；
- 插件会自动找 `<DSH_HOME>/bin/archive-sessions.mjs`，没有则用插件自带的 `bin/`。

### 2.6 验证安装

1. 面板能打开「日志裁切」，能看到「扫描 / 识别 / 修复 / 清理 / 体积」按钮；
2. 工具箱里出现「日志裁切」页签；打开面板会自动识别当前会话（读宿主页面里的会话 id、URL、全局变量），识别不到时才需要粘贴 id 或点「识别」。`autoScan` 只控制是否自动扫描完整会话列表，和识别当前会话不是一回事；
3. 跑一次自检：

```sh
node <插件目录>/bin/doctor.mjs
```

它会检查：包能否从 profile 解析到、入口 import 是否通过、apply 能否挂上路由和页面注入钩子。哪一步报错，就是卡在哪。

### 2.7 Windows 桌面端补充

桌面版没有 systemd，数据目录和挂载方式与 Linux/web 略有不同，按下面顺序来：

1. **确认数据根**：插件在 Windows 上会自动探测 `C:\data\dsh` 和 `%USERPROFILE%\.dsh`（哪个有 `sessions/state/profiles` 用哪个）。桌面版装在别的目录时，设环境变量 `DSH_HOME` 指向实际数据根，再启动 DSH。
2. **放插件**：把整个 `dsh-log-prune` 目录放到 `<DSH_HOME>\plugins\dsh-log-prune`。
3. **接进 profile**：
   - 桌面版优先用 bundle：编辑 `<DSH_HOME>\profiles\<profile>\package.json`，在 `dsh.profile.bundles` 里加 `"dsh-log-prune"`；
   - 同时在 `dependencies` 加 `"dsh-log-prune": "link:C:/.../dsh-log-prune"`（正斜杠，或双反斜杠转义），或直接把一份插件目录放进 `<DSH_HOME>\profiles\<profile>\node_modules\`（复制/junction 均可）。
   - profile 不一定是 `web`：用 `dir %USERPROFILE%\.dsh\profiles` 选含 `package.json` 的目录（本机实测是 `desktop`），下文统一写 `<profile>`。
4. **重启**：从托盘/窗口完全退出 DSH，再重新打开；不要执行 `systemctl`。
5. **首次补归档**：在 PowerShell 里：

   ```powershell
   node <插件目录>\bin\archive-sessions.mjs
   ```

   插件在 Electron 里调用脚本时会自动设 `ELECTRON_RUN_AS_NODE=1`；`node` 不在 PATH 时，设 `DSH_NODE` 指向 `node.exe`。
6. **离线清理**：不弹黑窗（插件用隐藏窗口/`CREATE_NO_WINDOW`）；需要时设 `DSH_EXE` 指向 DSH 可执行文件。关闭 DSH 用官方退出握手，清理完成后用隐藏窗口的 `cmd start` 拉起；只有拉起未确认时才保留一次性保险丝（`schtasks` 15 分钟后拉起一次，正常拉起确认后会删除），不是每日计划任务。执行期间不要手动开 DSH。
7. **路径写法**：JSON/YAML 里的 Windows 路径用 `C:/...` 或 `C:\\...`，不要用单个反斜杠。
8. **自检**：PATH 没有 node 时用 Electron 内嵌 node：
   ```powershell
   $env:ELECTRON_RUN_AS_NODE=1; & "DSH NEXT.exe" "<插件目录>\bin\doctor.mjs"
   ```
   或指向 DSH 自带 runtime 的 `node.exe`。桌面版没有 `dsh --profile web --dump-config` 时，改完配置先小步重启，并保留 `cordis.patch.yml` 的 `.bak`。

> 桌面版的安装包/数据目录会随版本变化；上面是插件实际支持的探测路径和挂载方式，最终以你机器上 `profiles` 所在目录为准。

## 3. 离线清理的前置

面板上的「清理」和每日自动清理都会派发 `bin/offline-clean.mjs`，流程是：

> 关闭 DSH → 补侧车归档 → 清会话 `data.stream` + 清归档残留 stream → 全量校验 → 自动拉起 DSH

因此：

- **Linux**：需要 systemd（默认单元 `dsh.service`）。插件用 `systemd-run` 起一个独立 unit 来执行清理，避免清理脚本被 `dsh.service` 停止时一起杀掉。自定义单元名设 `DSH_SYSTEMD_UNIT`。
- **Windows**：走 Electron + 隐藏窗口，不弹 PowerShell/CMD 黑框；关闭 DSH 优先用官方退出握手 `"DSH NEXT.exe" --dsh-installer-quit`（脚本已内置，失败才回退 `taskkill`），不要直接用 taskkill；清理完成后用隐藏窗口的 `cmd start` 拉起。只有拉起未确认时才保留一次性保险丝（`schtasks` 15 分钟后拉起一次，正常拉起确认后会删除），不是每日计划任务。路径不在 PATH 时可设 `DSH_NODE`（node.exe）和 `DSH_EXE`（DSH 可执行文件）。桌面版默认 `DSH_EXE=process.execPath`，`DSH_NODE` 自动用 runtime node；可在 `run.log` 的 `[环境]` 行确认。
- **权限**：执行清理的用户需要能读写会话目录、归档目录、`state/`，并能重启 DSH。
- **执行期间**：界面会断开，属正常；不要手动启动 DSH，脚本有 15 分钟保险丝兜底拉起。
- **手工运行**：必须显式加 `--dry-run` 预检；没有 `--run-id` 又没有 `--dry-run` 时脚本会拒绝执行，确认真清理需再加 `--apply`。

## 4. 升级

1. 覆盖插件目录（或用新 tgz 解包替换）；
2. profile 的 `link:` 路径不变时不需要重新 `pnpm install`；换了路径则更新 `dependencies` 后重新 `pnpm install`；
3. 重启 DSH；
4. 配置在 `$DSH_HOME/state/log-prune.yml`，升级不会覆盖；新增字段会用默认值；
5. 面板「更新检查」可看当前版本和 GitHub 最新版（`updateCheck` 关掉则不查外网）。

## 5. 卸载

1. 从 `dsh.profile.bundles` 移除 `dsh-log-prune`，或删掉预设里的 `- id: log-prune` 行（二选一里用的哪个就删哪个）；
2. 从 profile 的 `dependencies` 移除 `"dsh-log-prune"`，或在 `node_modules` 里删掉软链；
3. 重启 DSH；
4. 可选清理数据：`$DSH_HOME/state/log-prune.yml`、`log-prune-sessions.json`、`prune-index/`、`offclean-runs/` 等。归档/会话日志本身不要动。

## 6. 故障排查

### 6.1 启动失败 / 服务起不来

Linux/web CLI 先做配置预检（只组装、不启动）：

```sh
cd <DSH_HOME>
dsh --profile web --dump-config
```

退出码为 0 才安全重启。Windows 桌面版没有这个命令时，先备份 profile 的 `cordis.patch.yml`，改完小步重启，起不来就还原备份。

`cordis.patch.yml` 有 YAML 缩进错误时，DSH 每次启动都会失败，systemd 重试几次后停在 failed。

### 6.2 面板不出现 / 插件没加载

- 确认 2.3 的挂载方式只选了一种；
- 确认 profile 的 `node_modules/dsh-log-prune` 指向正确目录；
- 跑 `bin/doctor.mjs` 看卡在哪一步；
- 看 DSH 日志里有没有 `log-prune` 相关报错。

### 6.3 会话打不开

症状：`session event at seq N lacks an identified message`。

```sh
node <插件目录>/bin/repair-session.mjs <会话id> --dry   # 先看要删几条
node <插件目录>/bin/repair-session.mjs <会话id>         # 备份后修
```

### 6.4 清理失败

看最近一次运行的日志：

```sh
$DSH_HOME/state/offclean-runs/<runId>/run.log
$DSH_HOME/state/offclean-runs/<runId>/report.json
```

日志第一行是简报（用时/清理会话/归档文件/stream 数）；失败时 P7 会全量回滚，原文件备份在各自目录的 `.bak-stream-*`。

### 6.5 升级后版本没变

面板显示的版本来自 `package.json`；确认替换的是同一路径，并重启 DSH。

## 7. 关键文件与目录

| 路径 | 作用 |
|---|---|
| `<插件目录>/lib/index.js` | 插件入口、路由、裁切主逻辑 |
| `<插件目录>/lib/ui.js` | 配置面板前端 |
| `<插件目录>/lib/config.mjs` | 配置默认值、读写、会话覆盖 |
| `<插件目录>/bin/offline-clean.mjs` | 离线深度清理脚本 |
| `<插件目录>/bin/archive-sessions.mjs` | 补归档/水位 |
| `<插件目录>/bin/doctor.mjs` | 安装自检 |
| `<插件目录>/bin/repair-session.mjs` | 修复会话 |
| `$DSH_HOME/state/log-prune.yml` | 全局配置 |
| `$DSH_HOME/state/log-prune-sessions.json` | 会话级覆盖 |
| `$DSH_HOME/记忆/日志存档/` | 归档（默认） |
| `$DSH_HOME/记忆/镜像/` | 实时镜像（默认） |
| `$DSH_HOME/state/offclean-runs/` | 离线清理运行记录与日志 |

配置项和调参见 [CONFIG.md](CONFIG.md)。
