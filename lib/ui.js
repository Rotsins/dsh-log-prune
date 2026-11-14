// dsh-log-prune · 设置面板（注入式，纯 DOM）：全局 + 按会话覆盖
;(function () {
  'use strict'
  if (window.__logPruneInited) return
  window.__logPruneInited = true
  var API = '/dsh-log-prune/config'

  var FIELDS = [
    ['裁切', [
      ['keepTurns', '裁切后至少保留最近几轮', 'number'],
      ['compactPoint', '官方压缩阈值（token）', 'number'],
      ['triggerRatio', '强制裁切线 = compactPoint × 本比例', 'number'],
      ['keepTokens', '无摘要时裁切后保留 token', 'number'],
      ['summaryTrigger', '有摘要后到多少就裁摘要前内容', 'number'],
      ['longtextLimit', '单条 user 消息超多少字落盘', 'number'],
      ['archiveDir', '归档目录（留空用默认）', 'text'],
      ['mirrorDir', '镜像目录（留空用默认）', 'text'],
    ]],
    ['摘要任务', [
      ['summaryEnabled', '插件自己排摘要任务', 'bool'],
      ['summaryPoint', '摘要触发线（token）', 'number'],
      ['summaryIntervalMs', '轮询间隔（毫秒）', 'number'],
      ['summaryCooldownMs', '同会话最小间隔（毫秒）', 'number'],
    ]],
    ['交接', [
      ['handoffEnabled', '裁切后写清单并发事件', 'bool'],
      ['handoffEvent', '发事件 log-prune/pruned', 'bool'],
    ]],
  ]

  var CSS = [
    '#lpRoot{position:fixed;right:16px;bottom:120px;z-index:9000}',
    '#lpBtn{display:block;padding:6px 12px;border-radius:16px;',
    'border:1px solid rgba(255,255,255,.25);background:rgba(20,24,32,.85);color:#dbe4f0;font-size:12px;',
    'cursor:grab;user-select:none;touch-action:none;backdrop-filter:blur(6px)}',
    '#lpBtn:hover{background:rgba(40,48,64,.95)}',
    '#lpRoot.open #lpBtn{display:none}',
    '#lpPanel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:9001;width:480px;',
    'max-height:70vh;overflow:auto;box-sizing:border-box;background:#12161e;color:#d6dee9;',
    'border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:14px 16px;',
    'font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);display:none}',
    '#lpRoot.open #lpPanel{display:block}',
    '#lpPanel h3{margin:12px 0 4px;font-size:13px;color:#8fc7ff}',
    '.lpRow{display:grid;grid-template-columns:1fr 150px;gap:8px;align-items:center;padding:3px 0}',
    '.lpRow label{font-size:12px;color:#aab6c6}',
    '.lpRow input,.lpRow select{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);',
    'border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#e6edf7;padding:3px 6px;font-size:12px}',
    '.lpMsg{font-size:12px;margin:8px 0;color:#9fd28f;white-space:pre-wrap;word-break:break-all}',
    '.lpBox{border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;margin:8px 0}',
    '.lpFoot{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
    '.lpFoot button{padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);',
    'background:rgba(90,140,220,.25);color:#dbe4f0;cursor:pointer;font-size:12px;flex:1}',
    '.lpFoot button.weak{background:rgba(255,255,255,.06)}',
    '.lpFoot button:disabled{opacity:.5;cursor:default}',
    '@media (max-width:600px){',
    '#lpRoot{right:10px;bottom:110px}',
    '#lpBtn{font-size:12px;padding:5px 10px}',
    '#lpPanel{position:fixed;left:50%;right:auto;top:88px;bottom:auto;transform:translateX(-50%);',
    'width:calc(100vw - 32px);max-width:420px;max-height:calc(100dvh - 170px);padding-bottom:calc(18px + env(safe-area-inset-bottom, 0px))}',
    '.lpRow{grid-template-columns:1fr;gap:2px}',
    '}',
  ].join('')

  function el(tag, attrs, kids) {
    var n = document.createElement(tag)
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k]
      else if (k === 'cls') n.className = attrs[k]
      else n.setAttribute(k, attrs[k])
    }
    ;(kids || []).forEach(function (c) { n.appendChild(c) })
    return n
  }

  var root, panel, msg, inputs = {}, sid = '', hasOverride = false, cfgNow = {}

  function detectSid() {
    try {
      var re = /session[\/]([0-9a-fA-F-]{30,40})/
      var hit = ''
      var list = (performance.getEntriesByType('resource') || []).slice(-80)
      for (var i = list.length - 1; i >= 0; i--) {
        var m = re.exec(list[i].name || '')
        if (m) { hit = m[1]; break }
      }
      if (hit) return hit
    } catch (e) {}
    try {
      var m2 = /session[\/]([0-9a-fA-F-]{30,40})/.exec(location.href)
      if (m2) return m2[1]
    } catch (e) {}
    return ''
  }

  function header() {
    var h = el('div', { style: 'display:flex;justify-content:space-between;align-items:center' })
    h.id = 'lpHead'
    h.style.cursor = window.innerWidth > 600 ? 'move' : 'auto'
    attachDrag(h)
    h.appendChild(el('div', { text: '日志裁切 · dsh-log-prune' }))
    var x = el('button', { text: '关闭' })
    x.style.cssText = 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);color:#c8d2e0;border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px'
    x.onclick = function () { root.classList.remove('open') }
    h.appendChild(x)
    return h
  }

  function render(j) {
    cfgNow = j.config || {}
    hasOverride = !!j.session
    panel.innerHTML = ''
    panel.appendChild(header())
    var bind = el('div', { cls: 'lpBox' })
    bind.appendChild(el('div', { cls: 'lpMsg', text: hasOverride ? '本会话：有覆盖（只写与全局不同的项）' : '本会话：跟随全局' }))
    bind.appendChild(el('div', { cls: 'lpMsg', text: '会话 id：' + (sid || '（没识别到，可粘贴下面填）') }))
    var selRow = el('div', { cls: 'lpRow' })
    var sel = el('select')
    var ph = el('option', { value: '', text: '— 选一个最近会话 —' })
    sel.appendChild(ph)
    ;(j.sessions || []).forEach(function (s) {
      var name = (s.cwd ? s.cwd.split('/').filter(Boolean).slice(-1)[0] + ' · ' : '') + s.id.slice(0, 18)
      var op = el('option', { value: s.id, text: name })
      if (s.id === sid) op.selected = true
      sel.appendChild(op)
    })
    sel.onchange = function () { sid = sel.value; load() }
    selRow.appendChild(el('label', { text: '最近会话' })); selRow.appendChild(sel)
    bind.appendChild(selRow)
    var sidRow = el('div', { cls: 'lpRow' })
    var sidInput = el('input', { type: 'text', placeholder: '或粘贴完整会话 id，再点「载入」' })
    sidInput.value = sid
    var sidBtn = el('button', { text: '载入' })
    sidBtn.onclick = function () { sid = sidInput.value.trim(); load() }
    sidRow.appendChild(sidInput); sidRow.appendChild(sidBtn)
    bind.appendChild(sidRow)
    panel.appendChild(bind)
    msg = el('div', { cls: 'lpMsg', text: '' })
    panel.appendChild(msg)
    var tip = el('div', { cls: 'lpMsg', text: '' })
    tip.style.color = '#8a97a8'
    tip.appendChild(el('div', { text: '全局重置（自己执行，面板不做按钮）：' }))
    tip.appendChild(el('div', { text: 'node <插件目录>/bin/log-prune.mjs reset-global' }))
    tip.appendChild(el('div', { text: '清掉某会话覆盖：… reset-session <session-id>' }))
    panel.appendChild(tip)
    inputs = {}
    FIELDS.forEach(function (g) {
      panel.appendChild(el('h3', { text: g[0] }))
      if (g[0] === '摘要任务') {
        var hint = el('div', { cls: 'lpMsg', text: '摘要要调本机 API：把 DSH 安装目录里导出 NodeApiClient 的模块绝对路径填到 summaryClientPath（搜 "class NodeApiClient"）；summaryApiUrl 填 http://127.0.0.1:端口。不填则不会自动排摘要。' })
        hint.style.color = '#8a97a8'
        panel.appendChild(hint)
      }
      g[1].forEach(function (f) {
        var key = f[0], label = f[1], kind = f[2]
        var input = kind === 'bool' ? el('input', { type: 'checkbox' }) : el('input', { type: kind === 'number' ? 'number' : 'text' })
        if (kind === 'bool') input.checked = !!cfgNow[key]
        else input.value = cfgNow[key] == null ? '' : cfgNow[key]
        inputs[key] = { input: input, kind: kind }
        var row = el('div', { cls: 'lpRow' })
        row.appendChild(el('label', { text: label })); row.appendChild(input)
        panel.appendChild(row)
      })
    })
    var foot = el('div', { cls: 'lpFoot' })
    var bS = el('button', { text: '保存到当前会话' })
    var bG = el('button', { text: '保存到全局' })
    var bF = el('button', { text: '跟随全局', cls: 'weak' })
    bS.onclick = function () { save('session') }
    bG.onclick = function () { save('global') }
    bF.onclick = function () { save('follow') }
    foot.appendChild(bS); foot.appendChild(bG); foot.appendChild(bF)
    panel.appendChild(foot)
  }

  function collect() {
    var out = {}
    Object.keys(inputs).forEach(function (k) {
      var it = inputs[k]
      if (it.kind === 'bool') out[k] = it.input.checked
      else out[k] = it.input.value === '' ? '' : Number(it.input.value)
    })
    return out
  }

  function showLoading() {
    panel.innerHTML = ''
    panel.appendChild(header())
    msg = el('div', { cls: 'lpMsg', text: '读取中…' })
    panel.appendChild(msg)
  }

  function load() {
    showLoading()
    var url = API + (sid ? '?sid=' + encodeURIComponent(sid) : '')
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: collect(), scope: mode, sid: sid }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
        msg.textContent = mode === 'global' ? '已保存到全局，下一轮生效'
          : mode === 'follow' ? '已取消本会话覆盖，跟随全局'
          : '已保存到当前会话，下一轮生效'
        if (j.config) cfgNow = j.config
        if (j.scope === 'follow') hasOverride = false
      })
      .catch(function (e) { msg.textContent = '保存失败：' + e.message })
  }

  var lpRootEl, lpDrag = null, lpMoved = false

  function savePos() {
    try {
      localStorage.setItem('lpBtnPos', JSON.stringify({ left: lpRootEl.offsetLeft, top: lpRootEl.offsetTop }))
    } catch (e) {}
  }

  function clampRoot() {
    if (!lpRootEl || window.innerWidth <= 600) return
    var w = lpRootEl.offsetWidth || 40
    var h = lpRootEl.offsetHeight || 30
    var maxL = Math.max(6, window.innerWidth - w - 6)
    var maxT = Math.max(6, window.innerHeight - h - 6)
    var left = lpRootEl.offsetLeft, top = lpRootEl.offsetTop
    if (lpRootEl.style.right === 'auto' || lpRootEl.style.left) {
      lpRootEl.style.left = Math.max(6, Math.min(maxL, left)) + 'px'
      lpRootEl.style.top = Math.max(6, Math.min(maxT, top)) + 'px'
      lpRootEl.style.right = 'auto'; lpRootEl.style.bottom = 'auto'
    }
  }

  function clampPanel() {
    if (!panel || window.innerWidth <= 600 || !lpRootEl.classList.contains('open')) return
    var pr = panel.getBoundingClientRect()
    var dx = 0, dy = 0
    if (pr.left < 8) dx = 8 - pr.left
    if (pr.right > window.innerWidth - 8) dx = (window.innerWidth - 8) - pr.right
    if (pr.top < 8) dy = 8 - pr.top
    if (pr.bottom > window.innerHeight - 8) dy = (window.innerHeight - 8) - pr.bottom
    if (dx || dy) {
      lpRootEl.style.left = (lpRootEl.offsetLeft + dx) + 'px'
      lpRootEl.style.top = (lpRootEl.offsetTop + dy) + 'px'
      lpRootEl.style.right = 'auto'; lpRootEl.style.bottom = 'auto'
      savePos()
    }
  }

  function place(el2) {
    try {
      var saved = JSON.parse(localStorage.getItem('lpBtnPos') || 'null')
      if (saved && typeof saved.left === 'number') {
        el2.style.left = saved.left + 'px'; el2.style.top = saved.top + 'px'
        el2.style.right = 'auto'; el2.style.bottom = 'auto'
      }
    } catch (e) {}
  }

  function attachDrag(handle) {
    handle.addEventListener('pointerdown', function (ev) {
      if (window.innerWidth <= 600) return
      if (ev.target && ev.target.closest && ev.target.closest('button')) return
      lpDrag = { x: ev.clientX, y: ev.clientY, left: lpRootEl.offsetLeft, top: lpRootEl.offsetTop }
      lpMoved = false
      try { handle.setPointerCapture(ev.pointerId) } catch (e) {}
    })
    handle.addEventListener('pointermove', function (ev) {
      if (!lpDrag) return
      var dx = ev.clientX - lpDrag.x, dy = ev.clientY - lpDrag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) lpMoved = true
      if (!lpMoved) return
      var maxL = window.innerWidth - lpRootEl.offsetWidth - 6
      var maxT = window.innerHeight - lpRootEl.offsetHeight - 6
      lpRootEl.style.left = Math.max(6, Math.min(maxL, lpDrag.left + dx)) + 'px'
      lpRootEl.style.top = Math.max(6, Math.min(maxT, lpDrag.top + dy)) + 'px'
      lpRootEl.style.right = 'auto'; lpRootEl.style.bottom = 'auto'
    })
    handle.addEventListener('pointerup', function (ev) {
      if (!lpDrag) return
      lpDrag = null
      try { handle.releasePointerCapture(ev.pointerId) } catch (e) {}
      savePos()
    })
  }

  function openPanel() {
    if (!sid) sid = detectSid()
    lpRootEl.classList.add('open')
    clampPanel()
    load()
  }

  function closePanel() {
    lpRootEl.classList.remove('open')
    // 收起后按钮尺寸变了，重新夹回视口，别让它跑出去
    clampRoot()
    savePos()
  }

  function boot() {
    document.head.appendChild(el('style', { text: CSS }))
    root = el('div', { id: 'lpRoot' })
    lpRootEl = root
    var btn = el('button', { id: 'lpBtn', text: '日志裁切' })
    panel = el('div', { id: 'lpPanel' })
    place(root)
    attachDrag(btn)
    btn.addEventListener('pointerup', function () {
      if (lpMoved) { lpMoved = false; return }
      if (root.classList.contains('open')) closePanel()
      else openPanel()
    })
    var head = el('div', { id: 'lpHead' })
    panel.__head = head
    root.appendChild(btn)
    root.appendChild(panel)
    document.body.appendChild(root)
    clampRoot()
    window.addEventListener('resize', function () { clampRoot(); clampPanel() })
    // 点面板外自动收起（拖拽不算）
    document.addEventListener('pointerdown', function (ev) {
      if (!root.classList.contains('open')) return
      if (root.contains(ev.target)) return
      closePanel()
    }, true)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
