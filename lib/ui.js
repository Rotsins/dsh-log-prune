// dsh-log-prune · 设置面板（注入式，纯 DOM）：全局 + 按会话覆盖
;(function () {
  'use strict'
  if (window.__logPruneInited) return
  window.__logPruneInited = true
  var API = '/dsh-log-prune/config'
  function validTZ(s) {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: String(s) }).format(0); return true } catch (e) { return false }
  }
  var _toastEl = null
  function showToast(text) {
    try {
      if (_toastEl) { _toastEl.remove(); _toastEl = null }
      var t = document.createElement('div')
      t.textContent = text
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10001;' +
        'background:#1a2029;color:#d6dee9;border:1px solid rgba(255,255,255,.22);border-radius:8px;' +
        'padding:7px 14px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.5);' +
        'opacity:0;transition:opacity .25s ease;pointer-events:none;white-space:nowrap'
      ;(document.body || document.documentElement).appendChild(t)
      _toastEl = t
      requestAnimationFrame(function () { t.style.opacity = '1' })
      setTimeout(function () {
        t.style.opacity = '0'
        setTimeout(function () { try { t.remove() } catch (e) {} ; if (_toastEl === t) _toastEl = null }, 300)
      }, 1800)
    } catch (e) {}
  }
  // 时区候选按系统语言显示本地化名称（中文系统显示「中国时间」等），括号里保留 IANA 名
  var UI_LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'zh-CN'
  var UI_TRAD = /^zh-(TW|HK|MO)/i.test(UI_LOCALE)
  var TZ_NAME_OVERRIDE = {
    'Asia/Macau': function (trad) { return trad ? '澳門標準時間' : '澳门标准时间' },
    'Asia/Macao': function (trad) { return trad ? '澳門標準時間' : '澳门标准时间' }
  }
  var TZ_LABEL_CACHE = {}
  function tzLabel(z) {
    if (TZ_LABEL_CACHE[z]) return TZ_LABEL_CACHE[z]
    try {
      if (/^zh/i.test(UI_LOCALE) && TZ_NAME_OVERRIDE[z]) {
        var ov = TZ_NAME_OVERRIDE[z](UI_TRAD) + '（' + z + '）'
        TZ_LABEL_CACHE[z] = ov
        return ov
      }
      // Node/部分 Chromium 没有 DisplayNames 的 timeZone 类型，用 DateTimeFormat 的 long 名兜底
      var f = new Intl.DateTimeFormat(UI_LOCALE, { timeZone: z, timeZoneName: 'long' })
      var part = f.formatToParts(new Date()).filter(function (p) { return p.type === 'timeZoneName' })[0]
      var n = part && part.value
      var out = n && n !== z && !/^GMT[+-]/.test(n) ? n + '（' + z + '）' : z
      TZ_LABEL_CACHE[z] = out
      return out
    } catch (e) { return z }
  }
  // M2：经工具箱 iframe 打开时，token 在 URL 上；先接住，fetch 的 lpHeaders 就能带上
  try {
    var _tm = /[?&]token=([^&]+)/.exec(location.search)
    if (_tm && !window.__LP_TOKEN__) window.__LP_TOKEN__ = decodeURIComponent(_tm[1])
    // 只在 iframe 内抹地址栏 token：父页每次渲染都会重建带 token 的 src，刷新不丢凭证；
    // 直接打开面板时不抹（没有 cookie 兜底，抹了刷新就进不来）。
    if (_tm && window.parent !== window) {
      try {
        var _u = new URL(location.href)
        _u.searchParams.delete('token')
        history.replaceState(null, '', _u.pathname + _u.search + _u.hash)
      } catch (e2) {}
    }
  } catch (e) {}

  // Q18：默认（allowRemote=false）服务端不注入 token，这里什么都不带，本机请求照常。
  // 只有开了远程访问时，服务端才会把 token 注到 head；脚本动态注入可能乱序，ensureToken 兜底等 300ms
  // （E8：同文档同源 postMessage 是同步级延迟，1.5 秒只会在手机上空转）。
  function lpHeaders(extra) {
    var h = extra || {}
    if (window.__LP_TOKEN__) h['x-lp-token'] = window.__LP_TOKEN__
    return h
  }
  var lpTokenWait = null
  function ensureToken() {
    if (window.__LP_TOKEN__) return Promise.resolve()
    if (lpTokenWait) return lpTokenWait
    lpTokenWait = new Promise(function (resolve) {
      var done = false
      function finish() { if (done) return; done = true; resolve() }
      function onMsg(e) {
        if (e.origin !== window.location.origin) return
        if (!e.data || e.data.type !== 'lp-token') return
        if (typeof e.data.token === 'string' && e.data.token) window.__LP_TOKEN__ = e.data.token
        window.removeEventListener('message', onMsg)
        finish()
      }
      window.addEventListener('message', onMsg)
      // B6：工具箱 iframe 是独立 document，向宿主页面要一次 token（本机无 token 时宿主回空串，立即结束）
      try {
        if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'lp-token-request' }, window.location.origin)
      } catch (e) {}
      var deadline = Date.now() + 300
      var iv = setInterval(function () {
        if (window.__LP_TOKEN__ || Date.now() > deadline) { clearInterval(iv); window.removeEventListener('message', onMsg); finish() }
      }, 50)
    })
    return lpTokenWait
  }

  // 「其他设置」整组都是全局设置：改动后自动保存到全局，不进会话覆盖
  var GLOBAL_KEYS = ['updateCheck', 'autoScan', 'autoClean', 'cleanAtHour', 'cleanAtMinute', 'timezone', 'handoffEnabled', 'handoffEvent']
  var SHORT_LABELS = { timezone: '时区', autoClean: '自动清理', cleanAtHour: '清理时间', cleanAtMinute: '清理分钟', updateCheck: '更新检查', autoScan: '自动扫描', handoffEnabled: '交接清单', handoffEvent: '交接事件' }
  var globalSaveTimer = null

  var FIELDS = [
    ['裁切', [
      ['keepTurns', '裁切后至少保留最近几轮', 'number'],
      ['compactPoint', '官方压缩阈值（token）', 'number'],
      ['triggerRatio', '强制裁切线 = compactPoint × 本比例', 'number'],
      ['keepTokens', '无摘要时裁切后保留 token', 'number'],
      ['summaryTrigger', '摘要触发线（与 summaryPoint 联动）', 'number'],
      ['longtextLimit', '单条 user 消息超多少字落盘', 'number'],
      ['eraMerge', '时代摘要合并（门牌/旧摘要堆积时合并）', 'bool'],
      ['eraMergePlates', '时代合并触发：门牌块数 ≥', 'number'],
      ['eraMergeSummaries', '时代合并触发：旧摘要条数 ≥', 'number'],
      ['archiveDir', '归档目录（留空用默认）', 'text'],
      ['mirrorDir', '镜像目录（留空用默认）', 'text'],
    ]],
    ['摘要任务', [
      ['summaryEnabled', '插件自己排摘要任务', 'bool'],
      ['summaryPoint', '摘要触发线（token）', 'number'],
      ['summaryIntervalMs', '轮询间隔（毫秒）', 'number'],
      ['summaryCooldownMs', '同会话最小间隔（毫秒）', 'number'],
      ['summaryIgnoreRatio', '低于阈值多少比例就忽略摘要任务', 'number'],
      ['summaryApiUrl', '本机 API 地址（例 http://127.0.0.1:3099）', 'text'],
      ['summaryClientPath', '摘要客户端模块的绝对路径', 'text'],
      ['preArchive', '后台预归档（接近摘要线就提前补档）', 'bool'],
    ]],
    ['检索', [
      ['plainEnabled', '写明文副本 <day>.txt', 'bool'],
      ['plainMaxChars', '单条正文写盘截断字数', 'number'],
      ['plainKeepDays', '明文 .txt 保留天数', 'number'],
      ['idxKeepDays', '索引 .idx 保留天数（0=永久）', 'number'],
    ]],
    ['其他设置', [
      ['timezone', '时区（IANA，如 Asia/Shanghai）', 'text'],
      ['autoClean', '每天自动清理（全局生效）', 'bool'],
      ['cleanAtHour', '自动清理时间（全局生效）', 'number'],
      ['cleanAtMinute', '', 'number'],
      ['updateCheck', '自动检查更新（关掉不发任何外网请求）', 'bool'],
      ['autoScan', '打开界面自动扫描会话列表', 'bool'],
      ['handoffEnabled', '裁切后写清单并发事件', 'bool'],
      ['handoffEvent', '发事件 log-prune/pruned', 'bool'],
    ]],
  ]

  // 输入框清空后显示的半透明提示：推荐范围 / 注意事项 / 默认路径
  // 插件图标（内联 SVG，颜色交给 CSS 控制）
  var ICON_ON = '<svg t="1794666408485" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2585" xmlns:xlink="http://www.w3.org/1999/xlink" width="128" height="128"><path d="M882.515023 665.633011q33.407092 21.259059 53.653815 56.690823t20.246723 77.949882q0 33.407092-12.654202 62.258672t-34.419428 50.110638-50.616806 33.91326-62.258672 12.654202q-42.518117 0-77.443714-20.246723t-56.184655-52.641479q-4.049345-4.049345-7.086353-8.604857t-8.098689-9.617193q-16.197378-22.271395-20.246723-54.666151t-3.037008-67.320352 2.024672-68.838857-5.061681-60.234q-11.135697-20.246723-25.308403-44.036622t-31.38242-48.085966q-3.037008-4.049345-5.567849-7.086353t-4.555513-6.074017q-19.234386 23.283731-37.456437 46.567462t-37.456437 48.592134q-5.061681 6.074017-8.604857 12.148034t-8.604857 12.148034q-9.111025 19.234386-9.111025 33.407092t3.543176 27.839244 8.098689 27.839244 5.061681 32.900924-5.061681 44.036622-21.765227 60.740168q-17.209714 45.555126-57.703159 74.406705t-92.122588 28.85158q-33.407092 0-62.258672-12.654202t-50.616806-34.419428-34.419428-50.616806-12.654202-62.258672q0-36.444101 15.185042-67.826521t41.505781-53.653815q25.308403-26.320739 53.147647-44.036622t55.172319-32.900924 52.135311-30.370084 43.024285-36.444101q4.049345-5.061681 7.592521-10.123361t7.592521-10.123361l1.012336-1.012336q4.049345-8.098689 11.135697-15.185042 14.172706-18.22205 28.345412-37.962605t29.357748-39.987277q-26.320739-27.333075-45.048958-44.54279t-35.937933-40.493445q-35.431764-46.567462-59.727832-97.184268t-37.456437-96.171932-13.666538-81.493058 12.654202-53.147647q7.086353-5.061681 20.246723-7.592521t21.259059 9.617193q18.22205 27.333075 41.505781 62.76484t50.616806 76.431378 56.690823 85.542403 58.715495 88.073243q6.074017-8.098689 11.641865-16.703546t11.641865-16.703546q27.333075-39.481109 52.641479-81.493058t47.07363-80.480722 38.468773-69.345025 25.814571-47.07363q7.086353-11.135697 24.296067-11.641865t29.357748 10.629529q6.074017 6.074017 10.629529 34.925596t-3.037008 74.406705-32.394756 104.776789-77.443714 126.035848l-32.394756 40.493445q-16.197378 20.246723-33.407092 40.493445 23.283731 35.431764 44.036622 66.814184t37.962605 56.690823q25.308403 26.320739 51.122974 41.505781t49.098302 25.814571 43.530453 19.740554 35.431764 23.283731zM292.32306 874.174253q32.394756 0 55.172319-23.283731t22.777563-55.678487-22.777563-55.678487-55.172319-23.283731-55.678487 23.283731-23.283731 55.678487 23.283731 55.678487 55.678487 23.283731zM795.454116 874.174253q32.394756 0 55.172319-22.777563t22.777563-55.172319-22.777563-55.678487-55.172319-23.283731-55.678487 23.283731-23.283731 55.678487q0 16.197378 6.074017 30.370084t16.703546 24.802235 25.308403 16.703546 30.876252 6.074017z" p-id="2586" fill="#2c2c2c"></path></svg>'
  var ICON_OFF = '<svg t="1794665974959" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1730" xmlns:xlink="http://www.w3.org/1999/xlink" width="128" height="128"><path d="M882.515023 665.633011q33.407092 21.259059 53.653815 56.690823t20.246723 77.949882q0 33.407092-12.654202 62.258672t-34.419428 50.110638-50.616806 33.91326-62.258672 12.654202q-42.518117 0-77.443714-20.246723t-56.184655-52.641479q-4.049345-4.049345-7.086353-8.604857t-8.098689-9.617193q-16.197378-22.271395-20.246723-54.666151t-3.037008-67.320352 2.024672-68.838857-5.061681-60.234q-11.135697-20.246723-25.308403-44.036622t-31.38242-48.085966q-3.037008-4.049345-5.567849-7.086353t-4.555513-6.074017q-19.234386 23.283731-37.456437 46.567462t-37.456437 48.592134q-5.061681 6.074017-8.604857 12.148034t-8.604857 12.148034q-9.111025 19.234386-9.111025 33.407092t3.543176 27.839244 8.098689 27.839244 5.061681 32.900924-5.061681 44.036622-21.765227 60.740168q-17.209714 45.555126-57.703159 74.406705t-92.122588 28.85158q-33.407092 0-62.258672-12.654202t-50.616806-34.419428-34.419428-50.616806-12.654202-62.258672q0-36.444101 15.185042-67.826521t41.505781-53.653815q25.308403-26.320739 53.147647-44.036622t55.172319-32.900924 52.135311-30.370084 43.024285-36.444101q4.049345-5.061681 7.592521-10.123361t7.592521-10.123361l1.012336-1.012336q4.049345-8.098689 11.135697-15.185042 14.172706-18.22205 28.345412-37.962605t29.357748-39.987277q-26.320739-27.333075-45.048958-44.54279t-35.937933-40.493445q-35.431764-46.567462-59.727832-97.184268t-37.456437-96.171932-13.666538-81.493058 12.654202-53.147647q7.086353-5.061681 20.246723-7.592521t21.259059 9.617193q18.22205 27.333075 41.505781 62.76484t50.616806 76.431378 56.690823 85.542403 58.715495 88.073243q6.074017-8.098689 11.641865-16.703546t11.641865-16.703546q27.333075-39.481109 52.641479-81.493058t47.07363-80.480722 38.468773-69.345025 25.814571-47.07363q7.086353-11.135697 24.296067-11.641865t29.357748 10.629529q6.074017 6.074017 10.629529 34.925596t-3.037008 74.406705-32.394756 104.776789-77.443714 126.035848l-32.394756 40.493445q-16.197378 20.246723-33.407092 40.493445 23.283731 35.431764 44.036622 66.814184t37.962605 56.690823q25.308403 26.320739 51.122974 41.505781t49.098302 25.814571 43.530453 19.740554 35.431764 23.283731zM292.32306 874.174253q32.394756 0 55.172319-23.283731t22.777563-55.678487-22.777563-55.678487-55.172319-23.283731-55.678487 23.283731-23.283731 55.678487 23.283731 55.678487 55.678487 23.283731zM795.454116 874.174253q32.394756 0 55.172319-22.777563t22.777563-55.172319-22.777563-55.678487-55.172319-23.283731-55.678487 23.283731-23.283731 55.678487q0 16.197378 6.074017 30.370084t16.703546 24.802235 25.308403 16.703546 30.876252 6.074017z" p-id="1731" fill="#707070"></path></svg>'

  // p = 输入框里的短提示（一行放得下）；t = 悬停时看的完整说明
  var HINTS = {
    keepTurns: ['推荐 2~5 轮', '裁切后至少保留最近几轮对话（推荐 2~5）'],
    compactPoint: ['只读 · 由预设决定', '官方压缩阈值由当前会话的预设决定，插件改这里也不会生效'],
    triggerRatio: ['推荐 0.80~0.90', '强制裁切线 = 官方压缩阈值 × 本比例，推荐 0.80~0.90（略早于官方压缩）'],
    keepTokens: ['推荐 8~15 万', '没有摘要时，裁切后保留多少 token（推荐 80000~150000）'],
    summaryTrigger: ['推荐 35~45 万', '摘要派发线的面板联动字段：改这里会同步 summaryPoint；实际派发看 summaryPoint（推荐 350000~450000）'],
    longtextLimit: ['推荐 6000~12000', '单条 user 消息超过多少字就落盘，界面上只留一行指针（推荐 6000~12000）'],
    archiveDir: ['留空 = 默认目录', '裁切掉的内容归档到哪；留空用 <DSH_HOME>/记忆/日志存档'],
    mirrorDir: ['留空 = 默认目录', '实时镜像目录；留空用 <DSH_HOME>/记忆/镜像'],
    summaryPoint: ['跟随摘要触发线', '该数值会自动检测裁切阈值线同步'],
    summaryIgnoreRatio: ['推荐 0.4', '摘要任务里，当前上下文低于摘要线这个比例（0.1~0.9）就直接忽略；默认 0.4'],
    summaryApiUrl: ['留空 = 默认端口', '派发摘要用的本机 API 地址；留空用环境变量 DSH_DISPATCH_API 或本机默认端口'],
    summaryClientPath: ['留空 = 未配置', '能导出 NodeApiClient 的模块绝对路径（在 DSH 安装目录里搜 "class NodeApiClient"）；不填不会自动排摘要'],
    summaryIntervalMs: ['10000~60000 ms', '多久扫一次各会话的 token 状态（毫秒，推荐 10000~60000）'],
    summaryCooldownMs: ['300000~900000 ms', '同一会话两次摘要请求的最小间隔（毫秒，推荐 300000~900000）'],
    updateCheck: ['', '允许插件每 6 小时最多查一次 GitHub 新版本（5 秒超时，失败静默）；关掉后不发任何外网请求'],
    autoClean: ['默认关 · 只建议 7×24 机器', '到点自动派发离线清理（停 DSH → 侧车+清理 → 校验 → 拉起）。默认关；只建议 7×24 运行的机器打开。笔记本/日常关机的机器：休眠或关机错过时间后不补跑，醒来不会被突然重启'],
    cleanAtHour: ['默认 4:30', '24 小时制：时 0-23、分 0-59；下午四点三十写 16:30。全局生效，改完下一分钟按新时间排'],
    summaryEnabled: ['', '让插件自己给会话排摘要任务；关掉后只能手动排摘要'],
    handoffEnabled: ['', '裁切后写一份交接清单文件，方便别的模块接着处理'],
    handoffEvent: ['', '裁切后发一个 log-prune/pruned 事件，其他插件可以监听它'],
    plainEnabled: ['', '写 <day>.txt 明文副本：当天裁的内容当天就能读全文；关掉只留轻索引（检索仍可用，只是读不到未日封全文）'],
    plainMaxChars: ['推荐 10000~40000', '单条正文写盘前截断的字数（tool 结果是体积主因）；0 = 不截断（不建议）'],
    plainKeepDays: ['推荐 14~60', '明文 .txt 的保留天数；过期自动删。索引 .idx 由下一行单独控制'],
    idxKeepDays: ['0 = 永久', '轻索引 .idx 的保留天数（每条约 200~300 字节）；0 = 永久保留，历史内容永远可搜（检索层永续化）'],
    eraMerge: ['默认关 · 先灰度', '门牌/旧摘要堆积到阈值时，自动派一次「合并模式」摘要任务，把旧摘要+旧门牌收敛成一份时代摘要+一块总门牌；常驻 token 从线性变常数'],
    eraMergePlates: ['默认 4', '门牌块数达到该值触发时代合并；推荐 3~6'],
    eraMergeSummaries: ['默认 2', '旧摘要条数达到该值触发时代合并；推荐 2~3'],
    preArchive: ['默认开', 'token 接近摘要线（summaryPoint × 比例）时后台提前补归档，首次裁切不用现场等 60 秒'],
  }

  var CSS = [
    '#lpPanel{display:none;flex-direction:column;max-height:70vh;max-height:70dvh;overflow:hidden;box-sizing:border-box;background:#12161e;color:#d6dee9;',
    'border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:0;',
    'font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);display:none}',
    '#lpRoot.open #lpPanel{display:flex;flex-direction:column}',
    '#lpPanel h3{margin:12px 0 4px;font-size:13px;color:#8fc7ff}',
    '.lpRow{display:grid;grid-template-columns:1fr 150px;gap:8px;align-items:center;padding:3px 0}',
    '.lpRow label{font-size:12px;color:#aab6c6}',
    '.lpRow input,.lpRow select{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);',
    'border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#e6edf7;padding:3px 6px;font-size:12px}',
    '.lpRow select option{color:#0f1319;background:#fff}',
    '.ocLogSel option{color:#d6dee9;background:#1a2029}',
    '.ocLogSel option:checked,.ocLogSel option:hover{color:#fff;background:#2b3a55}',
    '#lpWsSel option{background:#1a2029;color:#e6edf7}',
    '#lpWsSel option:checked{background:#2b3a55;color:#fff}',
    '.lpRow input::placeholder{color:rgba(200,210,226,.32)}',
    // 布尔行：复选框贴右、不要被 .lpRow input 的 width:100% 拉满（16:51 恢复原版时丢过）
    '.lpRow input[type=checkbox]{width:16px;height:16px;margin:0;padding:0;justify-self:start;accent-color:#5a8cdc;cursor:pointer}',
    '.lpRow.lpBool{align-items:center}',
    '.lpRow.lpBool{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0}',
    '.lpRow.lpBool label{flex:1 1 auto}',
    '.lpRow.lpBool input{flex:0 0 auto}',
    '.lpTop{flex:0 0 auto;background:#12161e;padding:8px 16px 0}',
    '#lpContent{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;padding:2px 20px 14px 16px}',
    '#lpContent{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}',
    '#lpContent::-webkit-scrollbar{width:8px}',
    '#lpContent::-webkit-scrollbar-track{background:transparent}',
    '#lpContent::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px}',
    '#lpTabs{display:flex;gap:2px;padding:4px 0 6px;margin:0 0 8px;background:rgba(255,255,255,.03);',
    'border:1px solid rgba(255,255,255,.10);border-radius:8px}',
    '.lpTab{width:32px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:6px;cursor:pointer;padding:0}',
    '.lpTab svg{width:18px;height:18px;filter:invert(1);opacity:.35;transition:opacity .12s}',
    '.lpTab.on svg{opacity:1}',
    '.lpTab:hover svg{opacity:.7}',
    '.lpMsg{font-size:12px;margin:8px 0;color:#9fd28f;white-space:pre-wrap;word-break:break-all}',
    '.lpBox{border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;margin:8px 0}',
    '.lpFoot{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
    '.lpFoot button{padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);',
    'background:rgba(90,140,220,.25);color:#dbe4f0;cursor:pointer;font-size:12px;flex:1}',
    '.lpFoot button.weak{background:rgba(255,255,255,.06)}',
    '.lpFoot button:disabled{opacity:.5;cursor:default}',
    '@media (max-width:600px){',
    '.lpRow{grid-template-columns:1fr;gap:2px}',
    '#lpContent{padding-bottom:calc(14px + env(safe-area-inset-bottom))}',
    '}',
    '#lpRoot.embed{position:static!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;z-index:auto;height:100%}',
    '#lpRoot.embed #lpHead{display:none!important}',
    '#lpRoot.embed #lpTabs{display:none!important}',
    '#lpRoot.embed #lpPanel{position:static!important;display:flex!important;width:100%!important;height:100%!important;max-height:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;transform:none!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;padding-bottom:0!important}',
  ].join('')

  function el(tag, attrs, kids) {
    var n = document.createElement(tag)
    // 按钮别抢焦点：点完浏览器会把它 scrollIntoView，滚动容器会自己挪 1px
    if (tag === 'button') n.addEventListener('mousedown', function (e) { e.preventDefault() })
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k]
      else if (k === 'cls') n.className = attrs[k]
      else n.setAttribute(k, attrs[k])
    }
    ;(kids || []).forEach(function (c) { n.appendChild(c) })
    return n
  }

  var root, panel, msg, inputs = {}, sid = '', hasOverride = false, cfgNow = {}, wsFilter = ''

  var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
  var typedSid = ''
  // 锁定会话：两个插件（裁切/健康）共用同一个 localStorage 键，锁定后不可删除（可修复）
  var LOCK_KEY = 'dshLockedSessions'
  function readLocked() {
    try { var a = JSON.parse(localStorage.getItem(LOCK_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch (e) { return [] }
  }
  // S6：服务端文件是唯一真源，localStorage 只做首屏缓存；POST 成功后才回写缓存
  function writeLocked(a) {
    try {
      fetch('/dsh-log-prune/locked', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: a }) })
        .then(function (r) { return r.json() })
        .then(function (j) { if (j && j.ok) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(a)) } catch (e) {} } })
        .catch(function () {})
    } catch (e) {}
  }
  // 打开面板时从服务端文件恢复一次（清过缓存/换浏览器时用；读不到就用浏览器里现成的）
  function syncLocked(done) {
    try {
      fetch('/dsh-log-prune/locked?v=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.json() })
        .then(function (j) { if (j && j.ok && Array.isArray(j.ids)) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(j.ids)) } catch (e) {} } if (done) done() })
        .catch(function () { if (done) done() })
    } catch (e) { if (done) done() }
  }

  function fmtAt(at) {
    try {
      var d = new Date(at), p = function (n) { return (n < 10 ? '0' : '') + n }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '' }
  }

  // 会话 id 必须带 session- 前缀，跟列表/服务端里的写法对齐（少了它永远匹配不上）
  function normSid(u) {
    u = String(u == null ? '' : u).trim()
    if (!u) return ''
    return u.indexOf('session-') === 0 ? u : 'session-' + u
  }

  function detectSid() {
    // 0) 面板在 iframe 里时，先看祖先页面（宿主）上的会话 id —— 宿主 DOM 的 data-conversation-session 最可靠
    try {
      var w = window
      for (var depth = 0; depth < 6 && w.parent && w.parent !== w; depth++) {
        w = w.parent
        try {
          var pd = w.document
          var pns = pd ? pd.querySelectorAll('[data-conversation-session]') : []
          for (var pj = pns.length - 1; pj >= 0; pj--) {
            var pv = pns[pj].getAttribute('data-conversation-session')
            var pm = pv ? UUID_RE.exec(pv) : null
            if (pm) return normSid(pv.indexOf('session-') === 0 ? pv : pm[1])
          }
        } catch (e) {}
        try {
          var pb = w.__DSH_BOOT__
          var pc = [w.__DSH_SESSION_ID__, w.__dshSessionId, w.__DSH_SESSION__,
            pb && pb.sessionId, pb && pb.currentSessionId, pb && pb.session && pb.session.id]
          for (var pi = 0; pi < pc.length; pi++) {
            var pg = UUID_RE.exec(String(pc[pi] == null ? '' : pc[pi]))
            if (pg) return normSid(pg[1])
          }
        } catch (e) {}
        try {
          var pm2 = /session[\/]([0-9a-fA-F-]{30,40})/.exec(String(w.location.href || ''))
          if (pm2) return normSid(pm2[1])
        } catch (e) {}
      }
    } catch (e) {}
    // 1) 会话容器自己带着 id（DSH 的 data-conversation-session，最可靠）
    try {
      var node = document.querySelector('[data-conversation-session]')
      var v = node && node.getAttribute('data-conversation-session')
      var dm = v ? UUID_RE.exec(v) : null
      if (dm) return normSid(v.indexOf('session-') === 0 ? v : dm[1])
    } catch (e) {}
    // 1) 宿主全局里直接就有会话 id（web/桌面壳都可能带）
    try {
      var boot = ''
      try { boot = window.__DSH_BOOT__ ? String(JSON.stringify(window.__DSH_BOOT__)).slice(0, 400000) : '' } catch (e) {}
      var cands = [window.__DSH_SESSION_ID__, window.__dshSessionId, window.__DSH_SESSION__, boot]
      for (var c = 0; c < cands.length; c++) {
        var g = UUID_RE.exec(String(cands[c] == null ? '' : cands[c]))
        if (g) return normSid(g[1])
      }
    } catch (e) {}
    try {
      var re = /session[\/]([0-9a-fA-F-]{30,40})/
      var hit = ''
      var list = (performance.getEntriesByType('resource') || []).slice(-80)
      for (var i = list.length - 1; i >= 0; i--) {
        var m = re.exec(list[i].name || '')
        if (m) { hit = m[1]; break }
      }
      if (hit) return normSid(hit)
    } catch (e) {}
    try {
      var m2 = /session[\/]([0-9a-fA-F-]{30,40})/.exec(location.href)
      if (m2) return normSid(m2[1])
    } catch (e) {}
    return ''
  }

  function header() {
    var h = el('div', { id: 'lpHead' })
    // 整块头部都可拖动：铺满面板宽度并向外扩一点，留出抓取余量
    h.style.cssText = 'display:flex;align-items:center;padding:6px 0 8px;' +
      (window.innerWidth > 600 ? 'cursor:move;' : '') + 'user-select:none;touch-action:none'
    h.style.minHeight = '22px'
    return h
  }

  function tabbar() {
    var bar = el('div', { id: 'lpTabs' })
    var list = window.__dshPanelTabs || []
    if (!list.length) return bar
    var cur = window.__dshPanelTab || list[0].id
    list.forEach(function (t) {
      var b = el('button', { cls: 'lpTab' + (t.id === cur ? ' on' : '') })
      b.innerHTML = t.id === cur ? (t.iconOn || '') : (t.iconOff || '')
      b.title = t.title || t.id
      b.onclick = function () { window.__dshPanelTab = t.id; load(undefined, true) }
      bar.appendChild(b)
    })
    return bar
  }

  function render(j) {
    if (!sid && j.recentSessionId) { sid = j.recentSessionId; load(); return }
    var presetInfo = j.preset || null
    cfgNow = j.config || {}
    hasOverride = !!j.session
    // 重绘会把滚动位置归零，先记下来、画完再放回去
    var prevContent = panel.querySelector('#lpContent')
    var keepTop = prevContent ? prevContent.scrollTop : 0
    panel.innerHTML = ''
    var top = el('div', { cls: 'lpTop' })
    top.appendChild(header())
    top.appendChild(tabbar())
    panel.appendChild(top)
    var content = el('div', { id: 'lpContent' })
    panel.appendChild(content)
    // V1：能力不够时在顶部说清缺什么，而不是让用户逐个按钮撞不同报错
    capsNow = j.capabilities || null
    if (capsNow && capsNow.ok === false) {
      var capWarn = el('div', { cls: 'lpMsg' })
      capWarn.style.cssText = 'padding:8px 10px;margin:0 0 8px;border:1px solid #a8602a;border-radius:8px;background:rgba(168,96,42,.15);color:#f0b46a'
      capWarn.textContent = '当前 Node 缺少 zstd 写入能力（' + (capsNow.node || '未知版本') + '）：修复会话与离线清理不可用，请升级 Node 到 22.15+，或安装 zstd 命令行后重启 DSH。'
      content.appendChild(capWarn)
    }
    if (capsNow && capsNow.tz && capsNow.tz.ok === false) {
      var tzWarn = el('div', { cls: 'lpMsg' })
      tzWarn.style.cssText = 'padding:8px 10px;margin:0 0 8px;border:1px solid #a8602a;border-radius:8px;background:rgba(168,96,42,.12);color:#f0b46a'
      tzWarn.textContent = '当前 Node 的 ICU 不完整，配置的时区可能被忽略，归档日期会错一天；可设 DSH_TZ_OFFSET（单位分钟）兜底，或改用 UTC。'
      content.appendChild(tzWarn)
    }
    if (keepTop) requestAnimationFrame(function () { content.scrollTop = keepTop })
    // 当前选中的不是裁切页：交给那个插件自己渲染（没有 render 就显示占位）
    var curId = window.__dshPanelTab || 'prune'
    if (curId !== 'prune') {
      var curTab = (window.__dshPanelTabs || []).filter(function (t) { return t.id === curId })[0]
      if (curTab && curTab.render) { try { curTab.render(content) } catch (e) { content.textContent = '渲染失败：' + e.message } }
      else content.textContent = '这个插件还没提供配置界面'
      return
    }
    var bind = el('div', { cls: 'lpBox' })
    bind.appendChild(el('div', { cls: 'lpMsg', text: hasOverride ? '本会话：有覆盖（只写与全局不同的项）' : '本会话：跟随全局' }))
    bind.appendChild(el('div', { cls: 'lpMsg', text: '会话 id：' + (sid || '（没识别到，可粘贴下面填）') }))
    // 工作区筛选：会话一多，先按工作区收窄
    var all = j.sessions || []
    var wsList = []
    all.forEach(function (s) { var w = s.ws || ''; if (w && wsList.indexOf(w) < 0) wsList.push(w) })
    var filterRow = el('div')
    filterRow.style.cssText = 'position:relative;display:flex;gap:6px;align-items:center;padding:3px 0'
    var fsel = el('select')
    fsel.style.cssText = 'flex:0 0 auto;max-width:48%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#e6edf7;font-size:12px;padding:3px 6px'
    fsel.title = '工作区'
    fsel.id = 'lpWsSel'
    fsel.appendChild(el('option', { value: '', text: '全部工作区' }))
    wsList.forEach(function (w) {
      var o = el('option', { value: w, text: w })
      if (wsFilter === w) o.selected = true
      fsel.appendChild(o)
    })
    var selWrap = el('div')
    selWrap.style.cssText = 'position:relative;flex:1 1 auto;min-width:0'
    var ICON_OK = '<svg viewBox="0 0 1024 1024" width="11" height="11" style="flex:none"><circle cx="512" cy="512" r="116" fill="#1afa29"/></svg>'
    var ICON_BAD = '<svg viewBox="0 0 1024 1024" width="11" height="11" style="flex:none"><circle cx="512" cy="512" r="116" fill="#d81e06"/></svg>'
    var selBtn = el('button', { text: (j && j.listSkipped) ? '— 点「刷新列表」加载列表 —' : '— 选一个最近会话 —' })
    selBtn.style.cssText = 'width:100%;text-align:left;padding:4px 8px;font-size:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#e6edf7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer'
    var selList = el('div')
    selList.style.cssText = 'display:none;position:absolute;z-index:9200;left:0;right:0;top:calc(100% + 4px);background:#1a2029;border:1px solid rgba(255,255,255,.2);border-radius:8px;max-height:320px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)'
    // 从列表里隐藏的会话（只隐藏显示，不删数据）
    var hiddenKey = 'lpHiddenSessions'
    var hidden = []
    try { hidden = JSON.parse(localStorage.getItem(hiddenKey) || '[]') } catch (e) {}
    var multiMode = false
    var selected = new Set()
    // 固定表头：多选 / 删除
    var selHead = el('div')
    selHead.style.cssText = 'position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 8px;background:#1a2029;border-bottom:1px solid rgba(255,255,255,.12)'
    var multiBtn = el('button', { text: '多选', cls: 'weak' })
    multiBtn.style.cssText = 'padding:2px 8px;font-size:12px;flex:none'
    var selCnt = el('span', { text: '' })
    selCnt.style.cssText = 'font-size:11px;color:#8a97a8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    var delBtn = el('button', { text: '删除', cls: 'weak' })
    delBtn.style.cssText = 'padding:2px 8px;font-size:12px;flex:none'
    // 全选：保留少数、删多数时先全选再取消要留的
    var allBtn = el('button', { text: '全选', cls: 'weak' })
    allBtn.style.cssText = 'padding:2px 8px;font-size:12px;flex:none'
    allBtn.onclick = function () {
      if (!multiMode) { multiMode = true; multiBtn.textContent = '取消多选' }
      var locked0 = readLocked()
      var vis = all.filter(function (s) { return (!wsFilter || (s.ws || '') === wsFilter) && hidden.indexOf(s.id) < 0 && locked0.indexOf(s.id) < 0 })
      var allSel = vis.length > 0 && vis.every(function (s) { return selected.has(s.id) })
      if (allSel) selected.clear()
      else vis.forEach(function (s) { selected.add(s.id) })
      fillSel()
    }
    selHead.appendChild(multiBtn); selHead.appendChild(allBtn); selHead.appendChild(selCnt); selHead.appendChild(delBtn)
    var selOpen = false
    var closeSel = function () { selOpen = false; selList.style.display = 'none' }
    selBtn.onclick = function (ev) {
      ev.stopPropagation()
      selOpen = !selOpen
      selList.style.display = selOpen ? 'block' : 'none'
    }
    multiBtn.onclick = function () {
      multiMode = !multiMode
      if (!multiMode) selected.clear()
      multiBtn.textContent = multiMode ? '取消多选' : '多选'
      fillSel()
    }
    // 自定义确认浮层（替代 window.confirm；其他界面不一定是 web）
    function showConfirm(text, anchor, onOk) {
      var old = document.getElementById('lpConfirmBox')
      if (old) old.remove()
      var box = el('div')
      box.id = 'lpConfirmBox'
      box.style.cssText = 'position:absolute;z-index:9600;left:8px;right:8px;top:calc(100% + 6px);background:#1b222c;border:1px solid rgba(255,255,255,.18);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.6);padding:12px 12px 10px;font-size:12px;color:#d6dee9'
      var t = el('div', { text: text })
      t.style.cssText = 'margin-bottom:12px;line-height:1.6;white-space:pre-wrap'
      var row = el('div')
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
      var cancel = el('button', { text: '取消', cls: 'weak' })
      cancel.onclick = function () { box.remove() }
      var ok = el('button', { text: '确认' })
      ok.onclick = function () { box.remove(); onOk() }
      row.appendChild(cancel); row.appendChild(ok)
      box.appendChild(t); box.appendChild(row)
      filterRow.appendChild(box)
      var closeOnOut = function (e) { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', closeOnOut) } }
      setTimeout(function () { document.addEventListener('mousedown', closeOnOut) }, 0)
    }
    delBtn.onclick = function () {
      if (!multiMode) { multiBtn.click(); return }
      if (!selected.size) { if (msg) msg.textContent = '先勾选要删除的会话'; return }
      var lockedNow = readLocked()
      var keep = Array.from(selected).filter(function (id) { return lockedNow.indexOf(id) < 0 })
      var skipped = selected.size - keep.length
      if (!keep.length) { if (msg) msg.textContent = '选中的会话都已锁定，先解锁再删除'; return }
      showConfirm('确定把选中的 ' + keep.length + ' 个会话从列表里移除吗？\n不会删除会话数据，只是不再显示。' + (skipped ? '\n（已跳过 ' + skipped + ' 个锁定会话）' : ''), delBtn, function () {
        hidden = Array.from(new Set(hidden.concat(keep)))
        try { localStorage.setItem(hiddenKey, JSON.stringify(hidden)) } catch (e) {}
        selected.clear()
        multiMode = false
        multiBtn.textContent = '多选'
        fillSel()
        if (msg) msg.textContent = '已从列表移除 ' + hidden.length + ' 个会话' + (skipped ? '，跳过 ' + skipped + ' 个锁定会话' : '')
      })
    }
    function fillSel() {
      var locked = readLocked()
      selList.innerHTML = ''
      selList.appendChild(selHead)
      selCnt.textContent = multiMode ? (selected.size ? '已选 ' + selected.size + ' 个' : '勾选会话后点删除') : ''
      var visAll = all.filter(function (s) { return (!wsFilter || (s.ws || '') === wsFilter) && hidden.indexOf(s.id) < 0 })
      allBtn.textContent = multiMode && visAll.length > 0 && visAll.every(function (s) { return selected.has(s.id) }) ? '取消全选' : '全选'
      all.filter(function (s) { return (!wsFilter || (s.ws || '') === wsFilter) && hidden.indexOf(s.id) < 0 })
        .forEach(function (s) {
          var label = s.title || '未命名'
          var name = label + ' · ' + s.id.slice(0, 18)
          if (s.at) name += ' · ' + fmtAt(s.at)
          var row = el('div')
          // 整行选中高亮（16:51 恢复原版时丢过，2026-11-16 20:59 补回）
          var on = multiMode ? selected.has(s.id) : (String(sid) === String(s.id))
          row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:12px;color:#d6dee9;border-bottom:1px solid rgba(255,255,255,.05)' + (on ? ';background:rgba(90,140,220,.22);box-shadow:inset 2px 0 0 #5a8cdc' : '')
          if (multiMode) {
            var chk = el('span', { text: selected.has(s.id) ? '☑' : '☐' })
            chk.style.cssText = 'flex:none;font-size:13px;color:#9fd28f'
            row.appendChild(chk)
          }
          var dot = el('span')
          dot.style.cssText = 'display:inline-flex;flex:none'
          // X3：三态——unknown 显示灰色圆点，不把「没检查/检查不了」画成正常
          var st = s.unknown ? 'unknown' : (s.bad ? 'bad' : 'ok')
          dot.innerHTML = st === 'bad' ? ICON_BAD : (st === 'unknown' ? '<span style="opacity:.4">●</span>' : ICON_OK)
          var statusText = st === 'bad' ? '会话状态：错误' : (st === 'unknown' ? '会话状态：未检测' : '会话状态：正常')
          dot.title = statusText
          row.title = statusText
          row.appendChild(dot)
          var txt = el('span', { text: name })
          txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          row.appendChild(txt)
          var isLocked = locked.indexOf(s.id) >= 0
          var lockBtn = el('span', { text: isLocked ? '🔒' : '🔓' })
          lockBtn.style.cssText = 'flex:none;cursor:pointer;font-size:12px;opacity:' + (isLocked ? '1' : '.45')
          lockBtn.title = isLocked ? '已锁定：不可删除（可修复），点一下解锁' : '点一下锁定这个会话，防误删（可修复）'
          lockBtn.onclick = function (ev) {
            ev.stopPropagation()
            var arr = readLocked()
            var k = arr.indexOf(s.id)
            var nowLocked
            if (k >= 0) { arr.splice(k, 1); nowLocked = false } else { arr.push(s.id); nowLocked = true }
            writeLocked(arr)
            lockBtn.textContent = nowLocked ? '🔒' : '🔓'
            lockBtn.style.opacity = nowLocked ? '1' : '.45'
            lockBtn.title = nowLocked ? '已锁定：不可删除（可修复），点一下解锁' : '点一下锁定这个会话，防误删（可修复）'
          }
          row.appendChild(lockBtn)
          if (multiMode) {
            row.onclick = function () {
              if (selected.has(s.id)) selected.delete(s.id); else selected.add(s.id)
              fillSel()
            }
          } else {
            row.onclick = function () { sid = s.id; typedSid = ''; closeSel(); load() }
          }
          selList.appendChild(row)
        })
    }
    syncLocked(fillSel)
    if (lpSelClose) { try { document.removeEventListener('pointerdown', lpSelClose, true) } catch (e) {} }
    lpSelClose = function (ev) { if (selOpen && !selWrap.contains(ev.target)) closeSel() }
    document.addEventListener('pointerdown', lpSelClose, true)
    fsel.onchange = function () { wsFilter = fsel.value; fillSel() }
    selWrap.appendChild(selBtn)
    selWrap.appendChild(selList)
    selBtn.title = '最近会话'
    filterRow.appendChild(fsel)
    filterRow.appendChild(selWrap)
    bind.appendChild(filterRow)
    // 名字和 id 分开放：上面一行只说这是哪个会话，下面一行只放 id
    var cur = null
    ;(j.sessions || []).forEach(function (s) { if (s.id === sid) cur = s })
    var nameLine = el('div', { cls: 'lpMsg' })
    nameLine.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin:2px 0 4px'
    nameLine.appendChild(el('span', { text: '当前会话' }))
    // 打开面板时为了轻量加载会跳过会话列表（listSkipped），此时 sessions 为空，
    // 不能据此说「不在最近列表里」——那会把已识别成功的会话误报成找不到。
    var noList = j.listSkipped || !Array.isArray(j.sessions) || j.sessions.length === 0
    var curName = cur ? (((cur.title || '未命名') + (cur.at ? ' · ' + fmtAt(cur.at) : '')))
      : (j.listSkipped ? '（已识别；列表未加载，点「刷新列表」核对）' : (noList ? '（列表为空）' : '（不在最近列表里）'))
    var nameVal = el('span', { text: curName })
    nameVal.style.cssText = 'color:#e8eef7;font-weight:600'
    nameLine.appendChild(nameVal)
    bind.appendChild(nameLine)
    var sidRow = el('div', { cls: 'lpRow' })
    // 这一行不用 .lpRow 的两列网格：输入框吃掉全部剩余宽度，载入按钮贴右边，跟下面两个按钮的边缘对齐
    sidRow.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 0'
    var sidInput = el('input', { type: 'text', placeholder: '粘贴完整会话 id' })
    sidInput.style.cssText = 'flex:1;min-width:0'
    sidInput.value = typedSid || sid
    sidInput.oninput = function () { typedSid = sidInput.value }
    var sidBtn = el('button', { text: '载入' })
    sidBtn.style.cssText = 'flex:none;width:72px;padding:4px 0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.2);color:#dbe4f0;border-radius:8px;cursor:pointer;font-size:13px'
    sidBtn.onclick = function () { sid = sidInput.value.trim(); typedSid = sid; load() }
    sidRow.appendChild(sidInput); sidRow.appendChild(sidBtn)
    bind.appendChild(sidRow)
    // 列表是每次请求现扫的，这两个按钮只是把「再扫一次」和「再认一次」摆出来
    var sidTools = el('div', { cls: 'lpFoot' })
    sidTools.style.cssText = 'display:flex;gap:8px;align-items:center'
    var rBtn = el('button', { text: '扫描', cls: 'weak' })
    rBtn.title = '重新扫描会话列表'
    rBtn.style.cssText = 'flex:1;padding:3px 10px;font-size:12px'
    rBtn.onclick = function () { load(true) }
    var dBtn = el('button', { text: '识别', cls: 'weak' })
    dBtn.title = '重新识别当前打开的会话'
    dBtn.style.cssText = 'flex:1;padding:3px 10px;font-size:12px'
    dBtn.onclick = function () { sid = ''; sid = detectSid(); typedSid = sid; load() }
    var repBtn = el('button', { text: '修复', cls: 'weak' })
    repBtn.style.cssText = 'flex:1;padding:3px 10px;font-size:12px'
    repBtn.title = '如果无法加载历史会话，点击后尝试修复'
    // Q8：判断放到按钮创建之后，隐藏才真的生效
    if (pendingDoctorHide) { repBtn.style.display = 'none'; repBtn.title = '已由会话健康巡检插件接管' }
    function repairSession() {
      // 修「面板输入框里显示的那个会话」；输入框空时以面板当前选中的会话为准（可以是旧会话），
      // 最后才回退到浏览器当前打开的会话。以前 detectSid() 优先，导致选了旧会话也被当成当前会话拦住。
      var target = ''
      try { target = String((sidInput && sidInput.value) || '').trim() } catch (e) {}
      if (!target && typedSid && typedSid.trim()) target = typedSid.trim()
      if (!target) target = String(sid || '').trim()
      if (!target) { try { target = String(detectSid() || '') } catch (e) {} }
      if (!target) { msg.textContent = '没能定位到会话：先在「最近会话」里选一个，或在上面输入框填会话 id'; return }
      var curSid = ''
      try { curSid = String(detectSid() || '') } catch (e) {}
      if (curSid && target === curSid) { msg.textContent = '这是当前打开的会话（正在运行），不能直接修；要修旧会话，请在上面的「最近会话」里选一个，或在输入框填它的 id'; return }
      msg.textContent = '定位到 ' + target.slice(0, 8) + '，检索孤立事件…'
      fetch('/dsh-log-prune/repair', {
        method: 'POST', credentials: 'same-origin',
        headers: lpHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ sid: target }),
      }).then(function (r) { return r.text() }).then(function (t) {
        var j = null
        try { j = t ? JSON.parse(t) : null } catch (e) {}
        if (!j) throw new Error('服务无响应（可能正在重启或修复中断），请稍后重试')
        if (!j.ok) throw new Error(j.error || '修复失败')
        msg.textContent = j.message || '修复完成'
        // P4/H8：没有焦点在输入框里才自动刷新，避免冲掉没保存的编辑；跳过时说明原因
        setTimeout(function () {
          try {
            var ae = document.activeElement
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) {
              msg.textContent = (msg.textContent || '修复完成') + '（检测到正在编辑，面板未刷新；重新打开面板可见最新状态）'
              return
            }
            load()
          } catch (e) {}
        }, 800)
      }).catch(function (e) { msg.textContent = '修复失败：' + e.message })
    }
    repBtn.onclick = function () { repairSession() }
    // 2026-11-20：离线深度清理（关 DSH → 侧车+清理 → 校验 → 拉起）
    // 与「识别」等按钮统一：灰底描边（weak）
    var offBtn = el('button', { text: '清理', cls: 'weak' })
    offBtn.style.cssText = 'flex:1;padding:3px 10px;font-size:12px'
    // 悬停提示：原生 title 放不下富文本（换行/红色/加粗），这里自绘一个只读 tooltip
    var offTip = null
    var hideOffTip = function () { if (offTip) { try { offTip.remove() } catch (e) {} offTip = null } }
    var showOffTip = function () {
      hideOffTip()
      var rect = offBtn.getBoundingClientRect()
      var tip = el('div')
      tip.style.cssText = 'position:fixed;z-index:9600;pointer-events:none;background:#1a2029;border:1px solid rgba(255,255,255,.22);' +
        'border-radius:8px;padding:8px 10px;width:420px;max-width:calc(100vw - 24px);box-sizing:border-box;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px/1.6 system-ui,sans-serif;color:#d6dee9'
      tip.appendChild(el('div', { text: '关闭 DSH 后离线清理：补侧车归档 + 清会话 data.stream + 清归档文件里的残留 stream；校验通过自动拉起 DSH（在线清会被内存缓存回写覆盖）' }))
      var warnLine = el('div')
      warnLine.style.cssText = 'color:#ff7a45;margin-top:6px'
      warnLine.appendChild(el('span', { text: '❗清理功能会' }))
      var bold = el('span', { text: '重启DSH' })
      bold.style.fontWeight = '700'
      bold.style.color = '#d32f2f'
      warnLine.appendChild(bold)
      warnLine.appendChild(el('span', { text: ' 请在执行前确认所有任务/后台任务均已完成' }))
      tip.appendChild(warnLine)
      document.body.appendChild(tip)
      var th = tip.offsetHeight
      var left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left))
      var top = rect.bottom + 6
      if (top + th > window.innerHeight - 8) top = Math.max(8, rect.top - th - 6)
      tip.style.left = left + 'px'
      tip.style.top = top + 'px'
      offTip = tip
      try { window.addEventListener('scroll', hideOffTip, { once: true, capture: true }) } catch (e) {}
    }
    offBtn.addEventListener('mouseenter', showOffTip)
    offBtn.addEventListener('mouseleave', hideOffTip)
    offBtn.addEventListener('focus', showOffTip)
    offBtn.addEventListener('blur', hideOffTip)
    offBtn.addEventListener('click', hideOffTip)
    var ocCard = null
    var ocLogOpen = false, ocLogText = '', ocLogQuery = '', ocLogRunId = '', ocRuns = []
    var ocCloseCard = function () { if (ocCard) { ocCard.remove(); ocCard = null } }
    var ocAsk = function (info) {
      ocCloseCard()
      var card = el('div')
      card.style.cssText = 'position:fixed;z-index:9500;background:#1a2029;border:1px solid rgba(255,255,255,.22);' +
        'border-radius:10px;padding:14px 16px;width:360px;max-width:calc(100vw - 24px);box-sizing:border-box;max-height:70vh;overflow:auto;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.6);font:13px/1.6 system-ui,sans-serif;color:#d6dee9'
      // 相对配置面板居中（不是贴着「清理」按钮弹）
      var hostRect = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      card.style.left = (hostRect.left + hostRect.width / 2) + 'px'
      card.style.top = (hostRect.top + hostRect.height / 2) + 'px'
      card.style.transform = 'translate(-50%, -50%)'
      card.appendChild(el('div', { text: '预检完成（未修改任何文件）' }))
      card.lastChild.style.cssText = 'font-weight:600;margin:0 0 8px'
      var sum = el('div', { text: '会话 ' + info.sessions + ' 个；待侧车归档 ' + info.toArchive + ' 条（补历史空洞 ' + info.holes + ' 条）；待清理会话 stream ' + info.streams + ' 条。执行时还会把归档 .日志 里残留的 data.stream 一并剥掉（预检阶段只列会话，不扫归档）。' + (info.errors ? '注意：预检发现 ' + info.errors + ' 项错误，建议先排查再执行。' : '') })
      sum.style.cssText = 'color:#a9b6c6;margin:0 0 10px;white-space:pre-wrap'
      var warn = el('div')
      warn.style.cssText = 'color:#e0a64a;margin:0 0 12px;line-height:1.7'
      warn.appendChild(el('span', { text: '点「确认执行」后将依次：' }))
      var warnRed = el('span', { text: '① 关闭 DSH' })
      warnRed.style.cssText = 'color:#ff5a5f;font-weight:600'
      warn.appendChild(warnRed)
      warn.appendChild(el('span', { text: '（界面会断开，属正常）→ ② 离线补侧车 + 清会话 data.stream + 清归档残留 stream → ③ 全量校验 → ④ 校验通过自动拉起 DSH。重启后回本面板看清理日志；清理期间请勿手动启动 DSH（脚本崩溃也有 15 分钟保险丝兜底拉起）。' }))
      var btns = el('div', { cls: 'lpFoot' })
      var okBtn = el('button', { text: '确认执行' })
      var dryBtn = el('button', { text: '只再预检一次', cls: 'weak' })
      var noBtn = el('button', { text: '取消', cls: 'weak' })
      okBtn.onclick = function () { ocCloseCard(); ocDispatch(false) }
      dryBtn.onclick = function () { ocCloseCard(); ocDispatch(true) }
      noBtn.onclick = function () { ocCloseCard(); msg.textContent = '已取消（未修改）' }
      btns.appendChild(okBtn); btns.appendChild(dryBtn); btns.appendChild(noBtn)
      card.appendChild(sum); card.appendChild(warn); card.appendChild(btns)
      ocCard = card
      root.appendChild(card)
    }
    var ocDispatch = function (dry) {
      if (capsNow && capsNow.ok === false) {
        msg.textContent = '当前 Node 缺少 zstd 写入能力（' + (capsNow.node || '未知版本') + '），离线清理不可用'
        return
      }
      msg.textContent = dry ? '离线清理：正在预检…' : '离线清理：已派发，脚本即将接管…'
      fetch('/dsh-log-prune/offclean/dispatch', {
        method: 'POST', credentials: 'same-origin',
        headers: lpHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ dry: !!dry }),
      }).then(function (r) { return r.json() }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '派发失败')
        if (dry) { ocPoll(j.runId, 0); return }
        msg.textContent = '已派发（任务 ' + j.runId + '）：DSH 即将关闭，清理完成后自动拉起。重启后打开本面板即可看到清理日志。'
      }).catch(function (e) { msg.textContent = '离线清理派发失败：' + e.message })
    }
    var ocPoll = function (runId, n) {
      fetch('/dsh-log-prune/offclean/run?id=' + encodeURIComponent(runId), { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
        .then(function (r) { return r.json() }).then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '预检状态读取失败')
          var st = j.status || {}
          if (st.ok === true) {
            var c = st.counts || {}
            var plan = (j.report && j.report.plan) || []
            var toArchive = plan.reduce(function (a, p) { return a + (p.toArchive || 0) }, 0)
            var streams = plan.reduce(function (a, p) { return a + (p.streamEvents || 0) }, 0)
            var holes = plan.reduce(function (a, p) { return a + (p.holes || 0) }, 0)
            ocAsk({ sessions: c.sessionsScanned || 0, toArchive: toArchive, holes: holes, streams: streams, errors: c.errors || 0 })
            msg.textContent = ''
          } else if (st.ok === false) {
            msg.textContent = '预检失败：' + (st.lastMsg || '详见运行日志 ' + runId)
          } else if (n < 120) {
            setTimeout(function () { ocPoll(runId, n + 1) }, 1500)
          } else {
            msg.textContent = '预检 3 分钟未结束，请稍后重试或查看运行记录（runId ' + runId + '）'
          }
        }).catch(function (e) {
          // dispatch 已先建目录+初始 status；这里再兜底重试几次，避免首轮询早于脚本创建目录时 404
          if (n < 5) { setTimeout(function () { ocPoll(runId, n + 1) }, 250 * Math.pow(2, n)); return }
          msg.textContent = '预检读取失败：' + e.message
        })
    }
    offBtn.onclick = function () { ocDispatch(true) }
    function ocRunLabel(r) {
      var id = r.id || ''
      var m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)
      var t = m ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : id
      var st = r.status || {}
      return t + ' · ' + (st.dry ? '预检' : '清理') + ' · ' + (st.ok === true ? '成功' : st.ok === false ? '失败' : '未完成')
    }
    function ocRenderLog(node) {
      var old = node.querySelector('.ocLogWrap')
      if (old) old.remove()
      if (!ocLogOpen) return
      var box = el('div', { cls: 'ocLogWrap' })
      box.style.cssText = 'margin-top:6px'
      var bar = el('div')
      bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px'
      // 最近三次运行：切换下拉即加载对应 run.log
      if (ocRuns.length) {
        var sel = el('select', { cls: 'ocLogSel' })
        sel.style.cssText = 'font-size:12px;padding:4px 6px;max-width:170px;background:#1a2029;border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#d6dee9;outline:none'
        ocRuns.forEach(function (r) {
          var o = el('option', { text: ocRunLabel(r) })
          o.value = r.id
          if (r.id === ocLogRunId) o.selected = true
          sel.appendChild(o)
        })
        sel.onchange = function () {
          var id = sel.value
          if (!id || id === ocLogRunId) return
          sel.disabled = true
          fetch('/dsh-log-prune/offclean/run?id=' + encodeURIComponent(id), { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
            .then(function (r) { return r.json() }).then(function (k) {
              if (!k || !k.ok) throw new Error((k && k.error) || '读取失败')
              ocLogText = k.log || '（无日志）'
              ocLogRunId = id
              ocRenderLog(node)
            }).catch(function (e) { sel.disabled = false; msg.textContent = '日志读取失败：' + e.message })
        }
        bar.appendChild(sel)
      }
      var q = el('input', { type: 'text', placeholder: '在日志里搜（输入即过滤）' })
      q.value = ocLogQuery
      // 与图 2 的会话 id 输入框同款深色底：不在 .lpRow 里，直接补主题样式
      q.style.cssText = 'flex:1;min-width:0;font-size:12px;padding:4px 8px;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#d6dee9;outline:none'
      var cnt = el('span', { text: '' })
      cnt.style.cssText = 'font-size:11px;color:#8a97a8;white-space:nowrap'
      var pre = el('div')
      pre.style.cssText = 'max-height:260px;overflow:auto;background:rgba(0,0,0,.25);border-radius:8px;padding:8px;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;color:#a9b6c6'
      function applyLogFilter() {
        var all = String(ocLogText || '').split('\n')
        var kw = q.value.trim()
        // 首行「简报：」单独拎出来：字号放大 + 橙色，其余保持等宽小字
        var brief = all.length && /^简报：/.test(all[0]) ? all[0] : ''
        var lines = brief ? all.slice(1) : all
        var showBrief = !!brief && (!kw || brief.indexOf(kw) >= 0)
        if (kw) lines = lines.filter(function (l) { return l.indexOf(kw) >= 0 })
        var escHtml = function (s) {
          return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
          })
        }
        pre.innerHTML = ''
        if (showBrief) {
          var b = el('div', { text: brief })
          b.style.cssText = 'font-size:14px;line-height:1.6;color:#ff9f43;font-weight:600;margin-bottom:6px;font-family:system-ui,sans-serif'
          pre.appendChild(b)
        }
        if (!lines.length && !showBrief) { pre.textContent = '（没有匹配的行）'; cnt.textContent = '0 行'; return }
        if (!kw) {
          pre.appendChild(document.createTextNode(lines.join('\n')))
        } else {
          var kwEsc = escHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          var re = new RegExp(kwEsc, 'gi')
          var span = el('span')
          span.innerHTML = lines.map(function (l) {
            return escHtml(l).replace(re, function (m) {
              return '<mark style="background:#e0a64a;color:#12161e;border-radius:2px;padding:0 1px">' + m + '</mark>'
            })
          }).join('\n')
          pre.appendChild(span)
        }
        cnt.textContent = kw ? ('匹配 ' + (lines.length + (showBrief ? 1 : 0)) + ' 行') : ((lines.length + (showBrief ? 1 : 0)) + ' 行')
      }
      q.oninput = function () { ocLogQuery = q.value; applyLogFilter() }
      applyLogFilter()
      bar.appendChild(q); bar.appendChild(cnt)
      box.appendChild(bar); box.appendChild(pre)
      node.appendChild(box)
    }
    // P10 补丁：接口刚起来/status.json 还没写完时，卡片会短暂拿不到可渲染的 run；
    // 失败或空列表时 2s 后重试，最多 3 次，避免「拉起后第一次打开没有日志按钮」。
    function scheduleOffCleanRetry(node) {
      var n = (node.__ocRetry || 0) + 1
      node.__ocRetry = n
      if (n > 3) return
      setTimeout(function () {
        if (node.isConnected) showOffClean(node)
      }, 2000)
    }
    // P10：日志入口做成独立函数，运行中分支也能显示「上次清理日志」
    function appendLogEntry(node, run, label) {
      var more = el('button', { text: ocLogOpen ? '收起清理日志' : (label || '查看清理日志'), cls: 'weak' })
      // 这个按钮在 .lpMsg 里，不在 .lpFoot 内，weak 的 CSS 选择器命中不了；直接给同款灰底描边
      more.style.cssText = 'display:block;width:100%;margin-top:6px;padding:5px 10px;font-size:12px;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.2);color:#dbe4f0;border-radius:8px;cursor:pointer'
      more.onclick = function () {
        if (ocLogOpen) {
          ocLogOpen = false
          var w = node.querySelector('.ocLogWrap')
          if (w) w.remove()
          more.textContent = label || '查看清理日志'
          return
        }
        more.textContent = '读取日志…'
        fetch('/dsh-log-prune/offclean/run?id=' + encodeURIComponent(run.id), { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
          .then(function (r) { return r.json() }).then(function (k) {
            if (!k || !k.ok) throw new Error((k && k.error) || '读取失败')
            ocLogText = k.log || '（无日志）'
            ocLogRunId = run.id
            ocLogOpen = true
            more.textContent = '收起清理日志'
            ocRenderLog(node)
          }).catch(function (e) { more.textContent = label || '查看清理日志'; msg.textContent = '日志读取失败：' + e.message })
      }
      node.appendChild(more)
      if (ocLogOpen && ocLogText) ocRenderLog(node)
    }
    function showOffClean(node) {
      if (document.visibilityState === 'hidden') { setTimeout(function () { showOffClean(node) }, 5000); return }
      fetch('/dsh-log-prune/offclean/runs', { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
        .then(function (r) { return r.json() }).then(function (j) {
          if (!j || !j.ok) { node.textContent = ''; scheduleOffCleanRetry(node); return }
          var list = j.runs || []
          ocRuns = list.slice(0, 3)
          // 取最近一条「有结果」的 run：首条可能还在 P0/无 ok（比如被后续预检顶掉的真跑），
          // 不能因此把整块摘要和「查看清理日志」按钮都清空。
          var last = null
          for (var i = 0; i < list.length; i++) {
            var x = list[i]
            if (x && x.status && x.status.ok != null) { last = x; break }
          }
          if (j.running) {
            node.style.color = '#7fb8ff'
            node.textContent = ''
            node.appendChild(el('span', { text: '离线清理运行中（' + (j.runId || '') + '，阶段：' + ((j.status && j.status.label) || '?') + '，' + ((j.status && j.status.lastMsg) || '') + '）' }))
            // P10：锁未释放期间也要保留日志入口，不能整块隐藏。
            // 没有已完成的 run 时退回本次运行的 run.log（此时日志已写到 P8，可看）。
            if (last) appendLogEntry(node, last, '查看上次清理日志')
            else if (j.runId) appendLogEntry(node, { id: j.runId }, '查看本次清理日志')
            node.__ocRetry = 0
            setTimeout(function () { showOffClean(node) }, 2000)
            return
          }
          if (!last) { node.textContent = ''; scheduleOffCleanRetry(node); return }
          var st = last.status || {}
          var c = last.counts || {}
          var when = ''
          try {
            var d = new Date(st.updatedAt || Date.now())
            var p2 = function (n) { return (n < 10 ? '0' : '') + n }
            when = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
          } catch (e) {}
          var text
          if (st.dry && last.planSummary) {
            var ps = last.planSummary
            text = '上次离线清理（' + when + '，预检）：' + ps.sessions + ' 个会话，待清理 stream ' + ps.streams + ' 条，待侧车 ' + ps.toArchive + ' 条（未执行）'
          } else {
            text = '上次离线清理（' + when + (st.dry ? '，预检' : '') + '）：侧车 ' + (c.archivedEvents || 0) + ' 条；清理 stream ' + (c.streamEventsCleaned || 0) + ' 条（' + (c.sessionsCleaned || 0) + ' 个会话）；归档重写 ' + (c.archivesCleaned || 0) + ' 个；错误 ' + (c.errors || 0)
          }
          node.textContent = ''
          node.style.color = st.ok ? '#8bc49a' : '#e0a64a'
          node.appendChild(el('span', { text: (st.ok ? '[成功] ' : '[失败] ') + text }))
          appendLogEntry(node, last, '')
          node.__ocRetry = 0
        }).catch(function () { node.textContent = ''; scheduleOffCleanRetry(node) })
    }
    sidTools.appendChild(rBtn); sidTools.appendChild(dBtn); sidTools.appendChild(repBtn); sidTools.appendChild(offBtn)
    // O5：体积分析（只读）——先看清再决定清不清，直接服务 F2 分级放量
    var volBtn = el('button', { text: '体积', cls: 'weak' })
    volBtn.style.cssText = 'flex:1;padding:3px 10px;font-size:12px'
    volBtn.title = '分析当前会话文件的体积构成（stream / 正文 / 门牌 / 系统 / 元数据），只读不改'
    volBtn.onclick = function () {
      if (!sid) { msg.textContent = '先在上面选一个会话'; return }
      msg.textContent = '正在分析会话体积…'
      fetch('/dsh-log-prune/volume?sid=' + encodeURIComponent(sid), { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '分析失败')
          var mb = function (n) { return (n / 1048576).toFixed(1) + 'MB' }
          // 分项都是解压后字节，占比用 totalBytes；文件大小单独显示（压缩后）
          var pct = function (n) { return j.totalBytes ? Math.round((n / j.totalBytes) * 100) + '%' : '0%' }
          var t = '体积（解压后）' + mb(j.totalBytes) + ' · 文件 ' + mb(j.sizeBytes) + ' · ' + j.events + ' 条事件：'
            + 'stream ' + mb(j.streamBytes) + '（' + pct(j.streamBytes) + '）'
            + ' · 正文 ' + mb(j.contentBytes) + '（' + pct(j.contentBytes) + '）'
            + ' · 门牌/占位 ' + mb(j.plateBytes) + '（' + pct(j.plateBytes) + '）'
            + ' · 系统 ' + mb(j.systemBytes) + ' · 元数据 ' + mb(j.metaBytes)
          if (j.assistantWithStream) t += '；含 stream 的 assistant ' + j.assistantWithStream + ' 条，置空节省解压字节 ' + mb(j.emptyableBytes) + '（' + j.emptyableRatio + '%），按压缩比折算落盘约省 ' + mb(j.emptyableCompressedBytes || 0)
          if (j.top && j.top.length) t += '\n最大事件：' + j.top.map(function (x) { return 'seq=' + x.seq + '(' + x.type + '，' + mb(x.bytes) + '）' }).join('、')
          msg.textContent = t
        })
        .catch(function (e) { msg.textContent = '体积分析失败：' + e.message })
    }
    sidTools.appendChild(volBtn)
    // P4/H7：孤儿提示。兼容旧字符串形状（补齐 at/reason），文案用「替换范围」区分于孤儿事件 seq
    var orph = j.status && j.status.orphanRisk
    if (orph && typeof orph === 'string') {
      orph = { range: orph, seq: 0, at: (j.status.orphanAt || ''), reason: (j.status.reason || '') }
    }
    if (orph && !pendingDoctorHide) {
      repBtn.style.borderColor = 'rgba(220,140,60,.65)'
      repBtn.style.background = 'rgba(220,140,60,.22)'
      repBtn.title = '上次裁切在替换范围 ' + (orph.range || '?') + ' 留下孤儿 prune，下次加载可能报 corrupt，建议点这里修复'
    }
    bind.appendChild(sidTools)
    if (orph) {
      var orphanLine = el('div', { cls: 'lpMsg' })
      orphanLine.style.color = '#e0a64a'
      orphanLine.style.fontSize = '12px'
      orphanLine.style.lineHeight = '1.5'
      orphanLine.style.margin = '2px 0 0'
      orphanLine.textContent = '⚠ 上次裁切在替换范围 ' + (orph.range || '?') + ' 留下孤儿 prune，下次加载会话可能报 corrupt，建议点上方「尝试修复会话」'
      bind.appendChild(orphanLine)
    }
    content.appendChild(bind)
    // 2026-11-20：上次离线清理结果摘要（重启后回来第一眼就能看到；运行中每 2 秒自刷新）
    var offRow = el('div', { cls: 'lpMsg', text: '' })
    offRow.style.cssText = 'font-size:12px;line-height:1.6;margin:2px 0 0'
    content.appendChild(offRow)
    showOffClean(offRow)
    // 裁切状态：放在全局重置提示之前，字号比普通提示大一点、用蓝色区分
    var fuseRow = el('div', { cls: 'lpMsg', text: '' })
    fuseRow.style.cssText = 'font-size:13px;color:#7fb8ff;margin:8px 0'
    content.appendChild(fuseRow)
    showFuse(fuseRow)
    msg = el('div', { cls: 'lpMsg', text: '' })
    content.appendChild(msg)
    var tip = el('div', { cls: 'lpMsg', text: '' })
    tip.style.color = '#8a97a8'
    tip.appendChild(el('div', { text: '全局重置（自己执行，面板不做按钮）：' }))
    tip.appendChild(el('div', { text: 'node <插件目录>/bin/log-prune.mjs reset-global' }))
    tip.appendChild(el('div', { text: '清掉某会话覆盖：… reset-session <session-id>' }))
    content.appendChild(tip)
    if (globalSaveTimer) { clearTimeout(globalSaveTimer); globalSaveTimer = null }
    inputs = {}
    // 其他设置：改完自动保存到全局（收集整组一次提交，避免逐键覆盖）
    var scheduleGlobalSave = function () {
      if (globalSaveTimer) clearTimeout(globalSaveTimer)
      globalSaveTimer = setTimeout(function () {
        globalSaveTimer = null
        var payload = {}
        GLOBAL_KEYS.forEach(function (k) {
          var it = inputs[k]
          if (!it) return
          if (it.kind === 'bool') payload[k] = it.input.checked
          else if (it.kind === 'number') payload[k] = it.input.value === '' ? '' : Number(it.input.value)
          else payload[k] = String(it.input.value)
        })
        if (payload.timezone !== undefined && !validTZ(payload.timezone)) {
          if (msg) msg.textContent = '时区无效：' + payload.timezone + '（示例 Asia/Shanghai、UTC、America/New_York），未保存'
          return
        }
        var changed = []
        GLOBAL_KEYS.forEach(function (k) {
          var it = inputs[k]
          if (!it) return
          var v = it.kind === 'bool' ? it.input.checked : (it.kind === 'number' ? (it.input.value === '' ? '' : Number(it.input.value)) : String(it.input.value))
          if (String(v) !== String(cfgNow[k])) changed.push(k)
        })
        fetch(API, {
          method: 'POST', credentials: 'same-origin',
          headers: lpHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ config: payload, scope: 'global' }),
        }).then(function (r) { return r.json() }).then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
          if (j.config) cfgNow = j.config
          if (msg) msg.textContent = ''
          showToast('已自动保存' + (changed.length ? '：' + changed.map(function (k) { return SHORT_LABELS[k] || k }).join('、') : ''))
        }).catch(function (e) { if (msg) msg.textContent = '其他设置自动保存失败：' + e.message })
      }, 400)
    }
    // 分组展开状态记忆：与导航页同款，存 localStorage，刷新/重开面板不重置
    var GROUP_STATE_KEY = 'dsh-log-prune.groups.v1'
    var groupsState = (function () {
      try { var m = JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || '{}'); return m && typeof m === 'object' ? m : {} } catch (e) { return {} }
    })()
    var saveGroupsState = function () {
      try { localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groupsState)) } catch (e) {}
    }
    FIELDS.forEach(function (g) {
      var title = el('h3', { text: g[0] })
      var body = el('div')
      if (g[0] === '裁切' || g[0] === '摘要任务' || g[0] === '检索' || g[0] === '其他设置') {
        var savedOpen = groupsState[g[0]] === true
        title.textContent = (savedOpen ? '▾ ' : '▸ ') + g[0]
        title.style.cursor = 'pointer'
        title.style.userSelect = 'none'
        title.style.fontSize = '14px'
        title.style.fontWeight = '600'
        title.title = '点击展开/收起' + g[0] + '配置（状态会记住）'
        body.style.display = savedOpen ? '' : 'none'
        title.onclick = function () {
          var next = body.style.display === 'none'
          body.style.display = next ? '' : 'none'
          title.textContent = (next ? '▾ ' : '▸ ') + g[0]
          groupsState[g[0]] = next
          saveGroupsState()
        }
      }
      content.appendChild(title)
      content.appendChild(body)
      if (g[0] === '摘要任务') {
        var hint = el('div', { cls: 'lpMsg', text: '摘要要调本机 API：把 DSH 安装目录里导出 NodeApiClient 的模块绝对路径填到 summaryClientPath（搜 "class NodeApiClient"）；summaryApiUrl 填 http://127.0.0.1:端口。这两项现在面板里也能直接改（上面对着「摘要任务」组），不填则不会自动排摘要。' })
        hint.style.color = '#8a97a8'
        body.appendChild(hint)
      }
      if (g[0] === '其他设置') {
        var ghint = el('div', { cls: 'lpMsg', text: '以下均为全局设置，修改后自动保存（不用再点底部按钮）' })
        ghint.style.cssText = 'color:#8a97a8;font-size:12px;margin:0 0 4px'
        body.appendChild(ghint)
      }
      g[1].forEach(function (f) {
        var key = f[0], label = f[1], kind = f[2]
        var tzCaret = null
        // 自动清理时间：时、分两个输入框并排（24 小时制，0-23 / 0-59）
        if (key === 'cleanAtHour') {
          var rowT = el('div', { cls: 'lpRow' })
          rowT.appendChild(el('label', { text: label }))
          var wrapT = el('div')
          wrapT.style.cssText = 'display:flex;align-items:center;gap:6px'
          var hIn = el('input', { type: 'number' })
          var mIn = el('input', { type: 'number' })
          hIn.min = '0'; hIn.max = '23'; hIn.step = '1'
          mIn.min = '0'; mIn.max = '59'; mIn.step = '1'
          ;[hIn, mIn].forEach(function (x) {
            x.style.cssText = 'flex:1;min-width:0;text-align:center'
            x.title = HINTS.cleanAtHour[1]
          })
          hIn.value = cfgNow.cleanAtHour == null ? 4 : cfgNow.cleanAtHour
          mIn.value = cfgNow.cleanAtMinute == null ? 30 : cfgNow.cleanAtMinute
          hIn.placeholder = '4'; mIn.placeholder = '30'
          var sepT = el('span', { text: ':' })
          sepT.style.color = '#8a97a8'
          hIn.addEventListener('blur', function () { clampTime(hIn, 0, 23, 4) })
          mIn.addEventListener('blur', function () { clampTime(mIn, 0, 59, 30) })
          hIn.addEventListener('change', function () { clampTime(hIn, 0, 23, 4); scheduleGlobalSave() })
          mIn.addEventListener('change', function () { clampTime(mIn, 0, 59, 30); scheduleGlobalSave() })
          wrapT.appendChild(hIn); wrapT.appendChild(sepT); wrapT.appendChild(mIn)
          rowT.appendChild(wrapT)
          inputs.cleanAtHour = { input: hIn, kind: 'number' }
          inputs.cleanAtMinute = { input: mIn, kind: 'number' }
          body.appendChild(rowT)
          return
        }
        if (key === 'cleanAtMinute') return
        var input = kind === 'bool' ? el('input', { type: 'checkbox' }) : el('input', { type: kind === 'number' ? 'number' : 'text' })
        if (kind === 'bool') input.checked = !!cfgNow[key]
        else if (typeof cfgNow[key] === 'number' && !Number.isInteger(cfgNow[key])) input.value = cfgNow[key].toFixed(2)
        else input.value = cfgNow[key] == null ? '' : cfgNow[key]
        // 时区：输入框 + 自定义候选菜单（与面板同色），保存前校验；拼错不会写进配置
        if (key === 'timezone') {
          input.setAttribute('autocomplete', 'off')
          input.placeholder = 'Asia/Shanghai'
          // 常用时区排前面；后面接 Intl 的完整 IANA 列表（不支持时至少还有常用项）
          var COMMON_TZ = ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Bangkok', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland']
          var zones = COMMON_TZ.slice()
          try {
            Intl.supportedValuesOf('timeZone').forEach(function (z) { if (zones.indexOf(z) < 0) zones.push(z) })
          } catch (e) {}
          var menu = document.createElement('div')
          menu.style.cssText = 'position:fixed;z-index:9999;max-height:220px;overflow:auto;' +
            'background:#12161e;border:1px solid rgba(255,255,255,.18);border-radius:8px;' +
            'box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;padding:2px;box-sizing:border-box'
          ;(document.body || document.documentElement).appendChild(menu)
          // 匹配度：完全相等 > 时区名开头 > 城市段开头 > 其他段开头 > 路径段开头 > 任意包含；
          // 同分时常用时区优先、再按名字长度/字典序，保证输入 Asia 时 Asia/Shanghai 置顶
          var scoreTz = function (z, q) {
            var zl = z.toLowerCase()
            var lab = tzLabel(z).toLowerCase()
            var segs = zl.split('/')
            var last = segs[segs.length - 1]
            var s = 0
            if (zl === q || lab === q) s = 1000
            else if (zl.indexOf(q) === 0) s = 600
            else if (lab.indexOf(q) === 0) s = 580
            else if (last.indexOf(q) === 0) s = 550
            else if (segs.some(function (seg) { return seg.indexOf(q) === 0 })) s = 500
            else if (zl.indexOf('/' + q) >= 0) s = 400
            else if (zl.indexOf(q) >= 0) s = 300
            else if (lab.indexOf(q) >= 0) s = 280
            else return 0
            var ci = COMMON_TZ.indexOf(z)
            if (ci >= 0) s += (COMMON_TZ.length - ci)
            return s
          }
          var renderTz = function (filter) {
            menu.innerHTML = ''
            var q = String(filter || '').toLowerCase()
            var list = zones
            if (q) {
              var scored = []
              zones.forEach(function (z) { var s = scoreTz(z, q); if (s > 0) scored.push({ z: z, s: s }) })
              scored.sort(function (a, b) {
                if (b.s !== a.s) return b.s - a.s
                if (a.z.length !== b.z.length) return a.z.length - b.z.length
                return a.z < b.z ? -1 : (a.z > b.z ? 1 : 0)
              })
              list = scored.map(function (x) { return x.z })
            }
            var shown = 0
            list.forEach(function (z) {
              var it = document.createElement('div')
              it.textContent = tzLabel(z)
              it.title = z
              it.style.cssText = 'padding:4px 7px;border-radius:5px;font-size:12px;color:#d6dee9;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
              it.onmouseenter = function () { it.style.background = '#2b3a55' }
              it.onmouseleave = function () { it.style.background = 'transparent' }
              it.onmousedown = function (e) {
                e.preventDefault()
                input.value = z
                menu.style.display = 'none'
                input.dispatchEvent(new Event('change', { bubbles: true }))
              }
              menu.appendChild(it)
              shown++
            })
            if (!shown) {
              var none = document.createElement('div')
              none.textContent = '没有匹配的时区'
              none.style.cssText = 'padding:4px 7px;font-size:12px;color:#8a97a8'
              menu.appendChild(none)
            }
          }
          input.style.paddingRight = '20px'
          tzCaret = document.createElement('span')
          tzCaret.textContent = '▾'
          tzCaret.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);color:#8a97a8;font-size:10px;pointer-events:none'
          // 菜单挂到 body 上，避开面板滚动容器的 overflow 裁剪；位置随输入框实时算
          var showTz = function () {
            var r = input.getBoundingClientRect()
            var w = Math.min(Math.max(r.width, 280), window.innerWidth - 16)
            var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
            var below = window.innerHeight - r.bottom - 8
            var above = r.top - 8
            var openUp = below < 160 && above > below
            menu.style.left = left + 'px'
            menu.style.width = w + 'px'
            menu.style.top = (openUp ? Math.max(8, r.top - 222) : r.bottom + 2) + 'px'
            menu.style.maxHeight = Math.max(120, Math.min(220, openUp ? above : below)) + 'px'
            menu.style.display = 'block'
          }
          var hideTz = function () { menu.style.display = 'none' }
          input.addEventListener('focus', function () { renderTz(''); showTz() })
          input.addEventListener('click', function () { renderTz(''); showTz() })
          input.addEventListener('input', function () { renderTz(input.value); showTz() })
          input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTz() })
          document.addEventListener('pointerdown', function (e) { if (e.target !== input && !menu.contains(e.target)) hideTz() })
          window.addEventListener('scroll', function (e) { if (!menu.contains(e.target)) hideTz() }, true)
          window.addEventListener('resize', hideTz)
        }
        inputs[key] = { input: input, kind: kind }
        // 其他设置整组都是全局项：change 即自动保存（布尔勾选/数字失焦都触发）
        if (g[0] === '其他设置' && GLOBAL_KEYS.indexOf(key) >= 0) input.addEventListener('change', scheduleGlobalSave)
        if (HINTS[key]) { if (kind !== 'bool' && HINTS[key][0]) input.placeholder = HINTS[key][0]; input.title = HINTS[key][1] }
        // 摘要触发线和「摘要裁切线」绑死：前者只读、永远跟随后者，免得两个值差太远
        if (key === 'summaryTrigger') {
          input.addEventListener('input', function () {
            if (inputs.summaryPoint) inputs.summaryPoint.input.value = input.value
          })
        }
        if (key === 'summaryPoint') {
          input.readOnly = true
          input.style.opacity = '.85'
          input.style.pointerEvents = 'none'
          input.value = cfgNow.summaryTrigger == null ? '' : cfgNow.summaryTrigger
        }
        var row = el('div', { cls: kind === 'bool' ? 'lpRow lpBool' : 'lpRow' })
        var lab = el('label', { text: label })
        row.appendChild(lab); row.appendChild(input)
        // summaryPoint 是只读且 pointer-events:none，标题挂到行/标签上才 hover 得到
        if (key === 'summaryPoint') {
          row.title = HINTS.summaryPoint[1]
          lab.title = HINTS.summaryPoint[1]
          row.style.cursor = 'help'
        }
        if (tzCaret) { row.style.position = 'relative'; row.appendChild(tzCaret) }
        body.appendChild(row)
        if (key === 'compactPoint') {
          // 官方压缩阈值由预设决定，插件改了也不生效 —— 只读展示，连同来源
          input.readOnly = true
          input.style.opacity = '.85'
          input.style.pointerEvents = 'none'
          if (presetInfo && presetInfo.point) input.value = presetInfo.point
          var hint = el('div', { cls: 'lpMsg', text: '' })
          hint.style.cssText = 'color:#8a97a8;font-size:12px;margin:-2px 0 2px'
          hint.textContent = presetInfo && presetInfo.point
            ? '只读：预设 ' + presetInfo.name + ' × ' + presetInfo.ratio + '（窗口 ' + presetInfo.window + '），来源 ' + presetInfo.source
            : '只读：没读到预设的 thresholdRatio，显示的是默认配置值'
          body.appendChild(hint)
        }
      })
    })
    var foot = el('div', { cls: 'lpFoot' })
    var bS = el('button', { text: '保存到当前会话', cls: 'weak' })
    var bF = el('button', { text: '跟随全局', cls: 'weak' })
    var bG = el('button', { text: '保存到全局', cls: 'weak' })
    bS.title = '保存配置内容到当前会话设置'
    bF.title = '当前会话配置设置为全局默认'
    bG.title = '保存配置内容为全局默认设置'
    bS.onclick = function () { save('session') }
    bF.onclick = function () { save('follow') }
    // 全局是影响所有会话的开关，先弹一层确认，别手滑
    bG.onclick = function () {
      // 确认框贴着按钮弹（用视口坐标 fixed），不做全屏遮罩，免得被滚到看不见的地方
      var rect = bG.getBoundingClientRect()
      var card = el('div')
      card.style.cssText = 'position:fixed;z-index:9500;background:#1a2029;border:1px solid rgba(255,255,255,.22);' +
        'border-radius:10px;padding:14px 16px;width:280px;box-sizing:border-box;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.6);font:13px/1.6 system-ui,sans-serif;color:#d6dee9'
      card.style.left = Math.max(8, Math.min(window.innerWidth - 288, rect.left - 140)) + 'px'
      card.style.top = Math.max(8, rect.top - 108) + 'px'
      var tip = el('div', { text: '请确认是否要保存到全局' })
      tip.style.margin = '0 0 10px'
      var btns = el('div', { cls: 'lpFoot' })
      var ok2 = el('button', { text: '确认' })
      var no2 = el('button', { text: '取消', cls: 'weak' })
      var close = function () { card.remove(); document.removeEventListener('pointerdown', off, true) }
      var off = function (ev) { if (!card.contains(ev.target)) close() }
      ok2.onclick = function () { close(); save('global') }
      no2.onclick = function () { close() }
      btns.appendChild(ok2); btns.appendChild(no2)
      card.appendChild(tip); card.appendChild(btns)
      // 挂到 root 里而不是 body：面板的「点外面收起」判断的是 root.contains，
      // 卡片放外面的话，点确认/取消就会被当成点外面，把整个面板关掉
      root.appendChild(card)
      setTimeout(function () { document.addEventListener('pointerdown', off, true) }, 0)
    }
    foot.appendChild(bS); foot.appendChild(bF); foot.appendChild(bG)
    content.appendChild(foot)
    var upd = el('div', { cls: 'lpMsg', text: '' })
    upd.style.color = '#8a97a8'
    content.appendChild(upd)
    showUpdate(upd)
    // 打开面板时如果开了 autoScan，补一次带列表的扫描（nolist 轻加载后 listSkipped=true）
    if (cfgNow.autoScan === true && j.listSkipped) load(true)
  }

  var updText = ''
  var capsNow = null // V1：启动自检结果，面板顶部提示 + 拦住不可用的清理动作
  var lpSelClose = null
  var pendingDoctorHide = false // 巡检插件已停用；保留变量只为下面按钮逻辑的兼容

  // 裁切状态：正常 / 最近失败 N 次 / 已熔断，熔断时给「修复并解除」按钮
  // （这段在 16:51 恢复 GitHub 原版时被一起冲掉了，2026-11-16 20:52 补回）
  function showFuse(node) {
    node.textContent = ''
    node.style.display = 'flex'
    node.style.alignItems = 'center'
    node.style.gap = '8px'
    var line = el('span', { text: '' })
    line.style.cssText = 'flex:1 1 auto;min-width:0'
    node.appendChild(line)
    line.textContent = '裁切状态：读取中…'
    // 时间戳是 ISO/UTC（writeStatus 用 toISOString），这里必须转成本地时间显示，
    // 以前直接 slice(0,16) 会把 UTC 当本地时间贴出来（19:31 的裁切显示成 11:31）
    var when = function (s) {
      try {
        var d = new Date(s)
        if (!s || isNaN(d.getTime())) return String(s || '').slice(0, 16).replace('T', ' ')
        var p = function (n) { return (n < 10 ? '0' : '') + n }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
          ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return String(s || '').slice(0, 16).replace('T', ' ') }
    }
    fetch('/dsh-log-prune/fuse?sid=' + encodeURIComponent(sid), { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) { line.textContent = '裁切状态：读取失败'; return }
        if (j.fused) {
          line.style.color = '#f0b46a'
          line.textContent = '裁切已熔断（' + when(j.at) + '）：' + (j.reason || '连续失败')
          var btn = el('button', { text: '修复并解除', cls: 'weak' })
          btn.style.cssText = 'padding:4px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#dbe4f0;cursor:pointer;font-size:12px;flex:0 0 auto'
          btn.onclick = function () {
            btn.disabled = true
            line.textContent = '正在检查并修复…'
            fetch('/dsh-log-prune/fuse/reset', {
              method: 'POST', credentials: 'same-origin',
              headers: lpHeaders({ 'content-type': 'application/json' }),
              body: JSON.stringify({ sid: sid }),
            })
              .then(function (r) { return r.json() })
              .then(function (k) {
                if (!k || !k.ok) throw new Error((k && k.error) || '解除失败')
                showFuse(node)
              })
              .catch(function (e) { btn.disabled = false; line.textContent = '解除失败：' + e.message })
          }
          node.appendChild(btn)
          return
        }
        var st = j.status
        var base
        if (st && st.ok === false) base = '裁切状态：最近失败 ' + (st.fails || 1) + ' 次（' + when(st.at) + '）'
        else if (st && st.ok) base = '裁切状态：正常（' + when(st.at) + ' 成功）' + (st.verify && st.verify !== 'ok' ? '；自检：' + st.verify : '')
        else base = '裁切状态：正常'
        line.textContent = base
      })
      .catch(function () { line.textContent = '裁切状态：读取失败' })
  }

  function showUpdate(node) {
    // 「立即检查一次」按钮：16:51 恢复原版时丢过，2026-11-16 20:58 补回
    // 绕过开关和 6 小时缓存，只发这一个请求
    node.style.display = 'flex'
    node.style.alignItems = 'center'
    node.style.gap = '8px'
    if (updText) { node.textContent = updText; }
    var line = el('span', { text: updText || '' })
    line.style.cssText = 'flex:1 1 auto;min-width:0'
    var btn = el('button', { text: '立即检查', cls: 'weak' })
    btn.style.cssText = 'padding:2px 8px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#c9d4e2;cursor:pointer;font-size:12px;flex:0 0 auto'
    btn.onclick = function () {
      if (btn.disabled) return
      btn.disabled = true
      line.textContent = '检查中…'
      fetch('/dsh-log-prune/update-check?force=1', { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
        .then(function (r) { return r.json() })
        .then(function (j) {
          btn.disabled = false
          if (j && j.disabled) { line.textContent = '自动检查已关闭（不发外网请求）'; return }
          if (!j || !j.ok) { line.textContent = '检查失败：' + ((j && j.error) || '未返回结果'); return }
          if (!j.latest) { line.textContent = '没有查到发布信息'; return }
          updText = j.hasUpdate ? '有新版本 ' + j.latest + '（当前 ' + j.current + '）' : '已是最新版 ' + j.current
          line.textContent = updText
        })
        .catch(function (e) { btn.disabled = false; line.textContent = '检查失败：' + e.message })
    }
    node.textContent = ''
    node.appendChild(line)
    node.appendChild(btn)
    if (updText) return
    fetch('/dsh-log-prune/update-check', { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.disabled) { updText = '自动检查已关闭（不发外网请求）'; line.textContent = updText; return }
        if (!j || !j.ok || !j.latest) return
        updText = j.hasUpdate ? '有新版本 ' + j.latest + '（当前 ' + j.current + '）' : '已是最新版 ' + j.current
        line.textContent = updText
      })
      .catch(function () {})
  }

  function clampTime(x, lo, hi, dft) {
    var v = x.value === '' ? NaN : Number(x.value)
    if (!Number.isFinite(v)) v = dft
    x.value = String(Math.min(hi, Math.max(lo, Math.floor(v))))
  }

  function collect() {
    var out = {}
    Object.keys(inputs).forEach(function (k) {
      var it = inputs[k]
      if (it.kind === 'bool') out[k] = it.input.checked
      else if (it.kind === 'number') out[k] = it.input.value === '' ? '' : Number(it.input.value)
      // Q5：text 字段（归档/镜像目录）以前也走 Number()，路径变 NaN→null 被静默丢掉
      else out[k] = String(it.input.value)
    })
    return out
  }

  function showLoading() {
    panel.innerHTML = ''
    var top = el('div', { cls: 'lpTop' })
    top.appendChild(header())
    top.appendChild(tabbar())
    panel.appendChild(top)
    var content = el('div', { id: 'lpContent' })
    panel.appendChild(content)
    msg = el('div', { cls: 'lpMsg', text: '读取中…' })
    content.appendChild(msg)
  }

  function load(forceBad, light) {
    showLoading()
    var q = []
    if (sid) q.push('sid=' + encodeURIComponent(sid))
    if (forceBad) q.push('refresh=1')
    // light：只取配置/状态，不扫会话列表（列表交给「刷新列表」按钮，避免打开面板就卡）
    if (light) q.push('nolist=1')
    var url = API + (q.length ? '?' + q.join('&') : '')
    fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: lpHeaders() })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '读取失败')
        render(j)
      })
      .catch(function (e) { if (msg) msg.textContent = '读取失败：' + e.message })
  }

  function save(mode) {
    if (!sid && mode !== 'global') { msg.textContent = '没识别到会话 id，先在上面填一个'; return }
    msg.textContent = '保存中…'
    fetch(API, {
      method: 'POST', credentials: 'same-origin',
      headers: lpHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ config: collect(), scope: mode, sid: sid }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
        var okText = mode === 'global' ? '已保存到全局，已生效'
          : mode === 'follow' ? '已取消本会话覆盖，已跟随全局'
          : '已保存到当前会话，已生效'
        msg.textContent = ''
        showToast(okText)
        if (j.config) cfgNow = j.config
        if (j.scope === 'follow') hasOverride = false
      })
      .catch(function (e) { msg.textContent = '保存失败：' + e.message })
  }

  // 多插件共用一个设置窗：其他插件往这个数组里 push
  // { id, title, iconOn, iconOff, render(container) }，然后调 window.__dshPanelRefresh()
  window.__dshPanelTabs = window.__dshPanelTabs || []
  if (!window.__dshPanelTabs.some(function (t) { return t.id === 'prune' })) {
    window.__dshPanelTabs.push({ id: 'prune', title: '日志裁切', iconOn: ICON_ON, iconOff: ICON_OFF })
  }
  window.__dshPanelTab = window.__dshPanelTab || 'prune'
  window.__dshPanelRefresh = function () { try { load(undefined, true) } catch (e) {} }

  var EMBED = /[?&]embed=1/.test(location.search)

  function tabUrl() {
    var s = ''
    try { s = detectSid() } catch (e) {}
    return '/dsh-log-prune/panel?embed=1' + (s ? '&sid=' + encodeURIComponent(s) : '')
  }

  // 只用于工具箱页签里的整页面板（?embed=1）。独立浮窗已删除，外壳只由工具箱提供。
  function boot() {
    document.head.appendChild(el('style', { text: CSS }))
    root = el('div', { id: 'lpRoot', cls: 'open embed' })
    panel = el('div', { id: 'lpPanel' })
    var head = el('div', { id: 'lpHead' })
    panel.__head = head
    root.appendChild(panel)
    document.body.appendChild(root)
    try { var q = new URLSearchParams(location.search).get('sid'); if (q) sid = normSid(q) } catch (e) {}
    if (!sid) { try { var ds0 = detectSid(); if (ds0) sid = ds0 } catch (e) {} }
    try { ensureToken() } catch (e) {}
    // 打开面板先轻量加载：配置/状态立刻出来，会话列表等用户点「刷新列表」
    load(undefined, true)
  }

  // 只注册页签；工具箱没就绪就持续重连，不再退回独立浮窗。
  // registerTab 按 id 去重，重复调用安全。
  function tryRegister() {
    if (!(window.dshToolbox && typeof window.dshToolbox.registerTab === 'function')) return
    try { window.dshToolbox.registerTab({ id: 'prune', title: '日志裁切', icon: ICON_ON, order: 20, url: tabUrl() }) } catch (e) {}
  }

  function startRegister() {
    tryRegister()
    ;[200, 500, 1000, 2000, 4000].forEach(function (d) { setTimeout(tryRegister, d) })
    var iv = setInterval(tryRegister, 5000)
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tryRegister() })
    window.addEventListener('pagehide', function () { clearInterval(iv) })
  }

  if (EMBED) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
    else boot()
  } else startRegister()
})()
