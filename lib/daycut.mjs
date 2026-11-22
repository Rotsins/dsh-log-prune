// daycut —— 全系统唯一的「作息日」口径。
//
// 只管两个数：/data/dsh/state/day-cut.json 的 hour（现在 5 点）与当前时区（log-prune 配置 timezone，默认 Asia/Shanghai）。
// 它牵连的地方（改之前先看这份清单，别漏）：
//   1. dsh-log-mirror 插件 —— 镜像文件名 <作息日>_<会话>.jsonl；封存窗口 = 切点起两小时内且 10 分钟无新写入
//   2. /data/dsh/bin/mirror-seal.mjs —— 按作息日判断「哪些文件算昨天」，只搬 /data/dsh/记忆/镜像 里更早的
//   3. /data/dsh/bin/索引-重建.sh —— cron 每小时轮询，只有切点那小时真跑（封存后还会再触发一次）
//   4. /data/dsh/bin/拾星-每日.sh —— cron 每小时轮询，切点+40 分那轮切上一个作息日的料
//   5. dsh-log-prune 插件 —— 门牌上的日期、可裁的天、「今天」的判断
// 插件是每次现读这个文件，改切点不用重启；shell 那边要等 cron 下一轮。
// 配置文件：/data/dsh/state/day-cut.json  {"hour": 5}
// 一天 = 从切点小时开始，到次日切点前一分钟结束。2026-11-07 管理员定：所有按天落盘的地方都从这里取，别再各写各的日历日。
import fs from 'node:fs';
import path from 'node:path';

import { resolveHome } from './home.mjs';
import { DEFAULT_TZ, getTimeZone, logicalDayKey, setTimeZone, timezoneState } from './tz.mjs';

export const CUT_FILE = process.env.DSH_DAY_CUT_FILE ?? path.join(resolveHome(), 'state', 'day-cut.json');
// 兼容旧导入：真正的当前时区从 tz.mjs 的 getTimeZone() 取
export const TZ = DEFAULT_TZ;

/** 切点小时；配置坏了就退回 5 点，不抛错 */
export function cutHour() {
  try {
    const j = JSON.parse(fs.readFileSync(CUT_FILE, 'utf8'));
    const h = Number(j.hour ?? j['小时']);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  } catch {}
  return 5;
}

/** 供 capabilities 等模块复用同一次探测结论 */
export const tzState = () => timezoneState();

/** V5：Intl 时区能力探测。small-icu 构建会忽略 timeZone（或抛 RangeError），
 *  此时退回 DSH_TZ_OFFSET（分钟，东八区=480）手工偏移；都没有就按进程本地时区。 */
export function timezoneSupport() {
  return timezoneState();
}

/** 作息日 YYYYMMDD：把切点之前的小时归到前一天 */
export function dayOf(ms = Date.now(), hour = cutHour()) {
  return logicalDayKey(ms, hour, getTimeZone());
}

export const prettyDay = (d) => d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);

export { setTimeZone, getTimeZone };
