// O1：大文件解压 + JSON 解析放 worker 线程，别卡主线程（59MB 会话日志同步解压约 5.6 秒）
// 只回传 [seq, time] 元组数组：比回传 158MB 文本便宜得多（后者结构化克隆本身就要十几秒）。
// 解压库由主线程从工具箱拿路径传进来（fzstd 只留工具箱一份）
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

let decompress = null
let DecompressCtor = null
try {
  if (workerData.vendorPath) {
    const mod = await import(pathToFileURL(workerData.vendorPath).href)
    if (typeof mod.decompress === 'function') decompress = mod.decompress
    if (typeof mod.Decompress === 'function') DecompressCtor = mod.Decompress
  }
} catch (e) {}
if (typeof decompress !== 'function') {
  parentPort.postMessage({ ok: false, error: '解压库未就绪（工具箱未提供 fzstd 路径）' })
} else {
  try {
    const buf = fs.readFileSync(workerData.file)
    const maxText = Number(workerData.maxTextBytes) || (512 * 1024 * 1024)
    // F7：流式解压，超上限立刻中止，避免先吃掉整份内存再报错
    let raw
    if (typeof DecompressCtor === 'function') {
      const chunks = []
      let total = 0, over = false
      const d = new DecompressCtor((c) => {
        total += c.length
        if (total > maxText) { over = true; throw new Error('LIMIT') }
        chunks.push(Buffer.from(c))
      })
      try { d.push(new Uint8Array(buf), true) } catch (e) {
        if (over) throw new Error('解压后超过上限 ' + Math.round(maxText / 1048576) + 'MB')
        throw e
      }
      raw = Buffer.concat(chunks)
    } else {
      raw = Buffer.from(decompress(buf))
      if (raw.length > maxText) throw new Error('解压后约 ' + Math.round(raw.length / 1048576) + 'MB，超过上限 ' + Math.round(maxText / 1048576) + 'MB')
    }
    const text = raw.toString('utf8')
    // B2（2026-11-17）：两种模式 —— 带 wantedSeqs 时只回传命中 seq 的正文（读原文用，体量极小）；
    // 不带时维持旧行为，回传 [seq, time] 元组（readEntriesAsync 用）。
    const wanted = Array.isArray(workerData.wantedSeqs) ? new Set(workerData.wantedSeqs) : null
    if (wanted) {
      const texts = []
      for (const line of text.split('\n')) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (typeof e.seq !== 'number' || !wanted.has(e.seq)) continue
        const c = e?.data?.message?.content ?? e?.data?.content ?? e?.content
        let body = ''
        if (typeof c === 'string') body = c
        else if (Array.isArray(c)) body = c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') // N1：与 messageText 对齐
        texts.push([e.seq, body])
      }
      parentPort.postMessage({ ok: true, texts })
    } else {
      const entries = []
      for (const line of text.split('\n')) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (typeof e.seq !== 'number' || e.seq < 0) continue
        entries.push([e.seq, typeof e.time === 'number' ? e.time : Date.now()])
      }
      parentPort.postMessage({ ok: true, entries })
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message ? e.message : e) })
  }
}
