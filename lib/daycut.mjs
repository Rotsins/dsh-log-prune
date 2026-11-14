// daycut —— 全系统唯一的「作息日」口径。
//
// 只管一个数：~/.dsh/state/day-cut.json 的 hour（现在 5 点）。
// 它牵连的地方（改之前先看这份清单，别漏）：
//   1. dsh-log-mirror 插件 —— 镜像文件名 <作息日>_<会话>.jsonl；封存窗口 = 切点起两小时内且 10 分钟无新写入
//   2. ~/.dsh/bin/mirror-seal.mjs —— 按作息日判断「哪些文件算昨天」，只搬 ~/.dsh/记忆/镜像 里更早的
//   3. ~/.dsh/bin/索引-重建.sh —— cron 每小时轮询，只有切点那小时真跑（封存后还会再触发一次）
//   4. ~/.dsh/bin/拾星-每日.sh —— cron 每小时轮询，切点+40 分那轮切上一个作息日的料
//   5. dsh-log-prune 插件 —— 门牌上的日期、可裁的天、「今天」的判断
// 插件是每次现读这个文件，改切点不用重启；shell 那边要等 cron 下一轮。
// 配置文件：~/.dsh/state/day-cut.json  {"hour": 5}
// 一天 = 从切点小时开始，到次日切点前一分钟结束。所有按天落盘的地方都从这里取，别再各写各的日历日。
import fs from 'node:fs';

import { resolveHome } from './home.mjs';
export const CUT_FILE = process.env.DSH_DAY_CUT_FILE ?? resolveHome() + '/state/day-cut.json';
export const TZ = 'Asia/Shanghai';

/** 切点小时；配置坏了就退回 5 点，不抛错 */
export function cutHour() {
  try {
    const j = JSON.parse(fs.readFileSync(CUT_FILE, 'utf8'));
    const h = Number(j.hour ?? j['小时']);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  } catch {}
  return 5;
}

/** 作息日 YYYYMMDD：把切点之前的小时归到前一天 */
export function dayOf(ms = Date.now(), hour = cutHour()) {
  return new Date(Number(ms) - hour * 3600e3)
    .toLocaleDateString('sv-SE', { timeZone: TZ })
    .replace(/-/g, '');
}

/** YYYYMMDD 加减天数 */
export function shiftDay(day, delta) {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(4, 6)), d = Number(day.slice(6, 8));
  const t = Date.UTC(y, m - 1, d) + delta * 86400e3;
  const u = new Date(t);
  return String(u.getUTCFullYear()) + String(u.getUTCMonth() + 1).padStart(2, '0') + String(u.getUTCDate()).padStart(2, '0');
}

export const prettyDay = (d) => d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);

/** 当前小时（北京时区） */
export function nowHour(ms = Date.now()) {
  return Number(new Date(Number(ms)).toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).slice(0, 2));
}