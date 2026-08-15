#!/usr/bin/env node
/**
 * OTA 后台模拟报价 + 入住率反推
 *
 * 模拟说明:
 * - 每天按四个时点(00:00 / 08:00 / 14:00 / 20:00)抓取携程/美团展示的"剩余X间"与价格
 * - 当日预订到达时段权重: 前日18:00-24:00 预售 20% / 00-08 5% / 08-14 25% / 14-20 45% / 20-24 5%
 * - 20:00 之后仍有少量临时到店(约当日预订量 5%), 因此反推入住率略低于真实入住率
 * - 入住率反推: (总房量 - 20:00 剩余) / 总房量  →  60 间剩 5 间 ≈ 91.7%
 * - 价格 = 基准价 × 日期系数 × (1 + 0.45×已售占比) × 平台系数 × ±2% 噪声
 * - 节假日按内置 2026 年中国节假日表(简化)判定, 仅用于模拟演示
 *
 * 用法:
 *   node simulate_ota.js
 *   node simulate_ota.js --month 2026-10 --rooms 60 --base-price 388 --seed 42 --out out
 *   node simulate_ota.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const cfg = { month: '2026-10', rooms: 60, 'base-price': 388, seed: 42, out: 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(`用法:
  node simulate_ota.js [--month 2026-10] [--rooms 60] [--base-price 388] [--seed 42] [--out out]
参数:
  --month      模拟月份 YYYY-MM (默认 2026-10, 含国庆假期)
  --rooms      酒店总房量 (默认 60)
  --base-price 基准房价, 元 (默认 388)
  --seed       随机种子, 相同种子结果可复现 (默认 42)
  --out        输出目录 (默认 out)`);
      process.exit(0);
    }
    const m = /^--([a-z-]+)$/.exec(a);
    if (m && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      cfg[m[1]] = argv[i + 1];
      i++;
    }
  }
  cfg.rooms = Number(cfg.rooms);
  cfg['base-price'] = Number(cfg['base-price']);
  cfg.seed = Number(cfg.seed);
  return cfg;
}

// ---------------------------------------------------------------- 节假日表 (2026, 简化, 含连休区间)

const HOLIDAY_LIST_2026 = [
  ['元旦', '2026-01-01', '2026-01-03'],
  ['春节', '2026-02-15', '2026-02-21'],
  ['清明', '2026-04-04', '2026-04-06'],
  ['劳动节', '2026-05-01', '2026-05-05'],
  ['端午', '2026-06-19', '2026-06-21'],
  ['中秋', '2026-09-25', '2026-09-27'],
  ['国庆', '2026-10-01', '2026-10-08'],
];

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildHolidays(list) {
  const map = {};
  for (const [name, from, to] of list) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    for (let d = new Date(fy, fm - 1, fd); d <= new Date(ty, tm - 1, td); d.setDate(d.getDate() + 1)) {
      map[fmtDate(d)] = name;
    }
  }
  return map;
}

const HOLIDAYS_2026 = buildHolidays(HOLIDAY_LIST_2026);

// ---------------------------------------------------------------- 模型参数

const SNAPSHOT_TIMES = ['00:00', '08:00', '14:00', '20:00'];

// 日期类型 → 入住率均值 / 价格系数
const DAY_PARAMS = {
  workday: { p: 0.55, price: 1.0, label: '工作日' },
  weekend: { p: 0.78, price: 1.18, label: '周末' },
  holiday: { p: 0.95, price: 1.6, label: '节假日' },
};

// 预订到达时段权重: [前日18:00-24:00, 00-08, 08-14, 14-20, 20-24]
const ARRIVAL_WINDOWS = [
  { w: 0.2, until: '00:00' },
  { w: 0.05, until: '08:00' },
  { w: 0.25, until: '14:00' },
  { w: 0.45, until: '20:00' },
  { w: 0.05, until: '24:00' },
];

// 两个 OTA 平台: 价格系数 + 剩余房量展示抖动(±间, 模拟同步延迟)
const OTAS = [
  { key: 'ctrip', name: '携程', priceFactor: 1.0, jitter: [-1, 0, 0, 1] },
  { key: 'meituan', name: '美团', priceFactor: 0.97, jitter: [-1, 0, 1, 1] },
];

// ---------------------------------------------------------------- 可复现随机数 (mulberry32)

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 单日模拟

function simulateDay(date, cfg, rnd) {
  const key = fmtDate(date);
  const holidayName = HOLIDAYS_2026[key] || null;
  const dow = date.getDay();
  const type = holidayName ? 'holiday' : dow === 0 || dow === 6 ? 'weekend' : 'workday';
  const { p, price: dayFactor } = DAY_PARAMS[type];

  // 当日总预订量 (逐间二项抽样, 带自然波动)
  let demand = 0;
  for (let i = 0; i < cfg.rooms; i++) if (rnd() < p) demand++;

  // 每笔预订落在一个到达时段
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < demand; i++) {
    const r = rnd();
    let acc = 0;
    for (let k = 0; k < ARRIVAL_WINDOWS.length; k++) {
      acc += ARRIVAL_WINDOWS[k].w;
      if (r < acc) { counts[k]++; break; }
    }
  }

  // 各抓取时点的累计已售: 00:00=预售, 08:00, 14:00, 20:00; 24:00=最终
  let cum = 0;
  const soldBySnapshot = [];
  for (let k = 0; k < 4; k++) { cum += counts[k]; soldBySnapshot.push(cum); }
  const finalSold = cum + counts[4];

  const snapshots = [];
  const otaAvg = {};
  for (const ota of OTAS) otaAvg[ota.key] = 0;

  for (let i = 0; i < SNAPSHOT_TIMES.length; i++) {
    const sold = soldBySnapshot[i];
    const hotelRem = cfg.rooms - sold;
    const snap = { t: SNAPSHOT_TIMES[i], rem: hotelRem };

    for (const ota of OTAS) {
      // OTA 展示剩余 = 酒店剩余 + 同步抖动 (截断到 [0, rooms])
      const jitter = ota.jitter[Math.floor(rnd() * ota.jitter.length)];
      const displayed = Math.max(0, Math.min(cfg.rooms, hotelRem + jitter));
      // 价格 = 基准价 × 日期系数 × 稀缺加价 × 平台系数 × ±2% 噪声
      const scarcity = 1 + 0.45 * (sold / cfg.rooms);
      const noise = 1 + (rnd() * 0.04 - 0.02);
      const price = Math.round(cfg['base-price'] * dayFactor * scarcity * ota.priceFactor * noise);
      snap[ota.key] = { rem: displayed, price };
      otaAvg[ota.key] += price;
    }
    snapshots.push(snap);
  }
  for (const ota of OTAS) otaAvg[ota.key] = Math.round(otaAvg[ota.key] / SNAPSHOT_TIMES.length);

  // 20:00 反推: 取两平台展示剩余的平均, 平滑同步抖动
  const s20 = snapshots[3];
  const inferredRem = (s20.ctrip.rem + s20.meituan.rem) / 2;
  const inferredOcc = (cfg.rooms - inferredRem) / cfg.rooms;
  const trueOcc = finalSold / cfg.rooms;

  return {
    date: key,
    label: `${date.getMonth() + 1}/${date.getDate()}`,
    type,
    typeLabel: holidayName || DAY_PARAMS[type].label,
    demand: finalSold,
    trueOcc,
    inferredOcc,
    snapshots,
    otaAvg,
  };
}

// ---------------------------------------------------------------- 整月模拟 + 汇总

function runMonth(cfg) {
  const [y, m] = cfg.month.split('-').map(Number);
  const rnd = mulberry32(cfg.seed);
  const daysIn = new Date(y, m, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysIn; d++) days.push(simulateDay(new Date(y, m - 1, d), cfg, rnd));

  const agg = { workday: { n: 0, t: 0, i: 0, c: 0, m: 0 }, weekend: { n: 0, t: 0, i: 0, c: 0, m: 0 }, holiday: { n: 0, t: 0, i: 0, c: 0, m: 0 } };
  for (const day of days) {
    const s = agg[day.type];
    s.n++; s.t += day.trueOcc; s.i += day.inferredOcc;
    s.c += day.otaAvg.ctrip; s.m += day.otaAvg.meituan;
  }
  const monthStats = {};
  for (const [k, s] of Object.entries(agg)) {
    monthStats[k] = {
      n: s.n,
      trueAvg: s.n ? s.t / s.n : 0,
      inferredAvg: s.n ? s.i / s.n : 0,
      ctripAvg: s.n ? Math.round(s.c / s.n) : 0,
      meituanAvg: s.n ? Math.round(s.m / s.n) : 0,
      label: DAY_PARAMS[k].label,
    };
  }
  return { days, monthStats, monthLabel: `${y}年${m}月`, key: `${y}-${String(m).padStart(2, '0')}` };
}

// ---------------------------------------------------------------- 输出: 控制台

// 按显示宽度填充 (中文全角按 2 列计)
function dispWidth(s) {
  return Array.from(String(s)).reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
}
function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));
}

function printConsole(cfg, result) {
  const { days, monthStats, monthLabel, key } = result;
  const line = '='.repeat(96);
  console.log(line);
  console.log(`OTA 模拟报价 · ${monthLabel}    (${'示例酒店'} · ${cfg.rooms} 间 · 基准价 ¥${cfg['base-price']} · seed ${cfg.seed})`);
  console.log(line);
  console.log(`${pad('日期', 13)}${pad('类型', 9)}${pad('携程剩20:00', 13)}${pad('美团剩20:00', 13)}${pad('反推入住率', 11)}${pad('真实入住率', 11)}${pad('携程价20:00', 13)}${pad('美团价20:00', 13)}`);
  console.log('-'.repeat(96));
  for (const day of days) {
    const s20 = day.snapshots[3];
    console.log(
      `${pad(day.date, 13)}${pad(day.typeLabel, 9)}${pad(s20.ctrip.rem, 13)}${pad(s20.meituan.rem, 13)}` +
      `${pad((day.inferredOcc * 100).toFixed(1) + '%', 11)}${pad((day.trueOcc * 100).toFixed(1) + '%', 11)}` +
      `${pad('¥' + s20.ctrip.price, 13)}${pad('¥' + s20.meituan.price, 13)}`,
    );
  }
  console.log(line);
  console.log('月度汇总 (按日期类型):');
  for (const [k, s] of Object.entries(monthStats)) {
    console.log(
      `  ${pad(s.label, 7)}${pad(s.n + ' 天', 6)}真实 ${pad((s.trueAvg * 100).toFixed(1) + '%', 8)}` +
      `反推 ${pad((s.inferredAvg * 100).toFixed(1) + '%', 8)}携程均价 ${pad('¥' + s.ctripAvg, 7)}美团均价 ${pad('¥' + s.meituanAvg, 7)}`,
    );
  }
  // 公式验证: 找 20:00 平均剩余最接近 5 间的一天
  let best = days[0];
  let bestGap = Infinity;
  for (const day of days) {
    const s20 = day.snapshots[3];
    const rem = (s20.ctrip.rem + s20.meituan.rem) / 2;
    if (Math.abs(rem - 5) < bestGap) { bestGap = Math.abs(rem - 5); best = { day, rem }; }
  }
  console.log(`公式验证: ${best.day.date} 20:00 平均剩余 ${best.rem.toFixed(1)} 间 → 反推入住率 ${(best.day.inferredOcc * 100).toFixed(1)}%  (${cfg.rooms} 间, 剩 5 间 ≈ 91.7%)`);
  console.log(line);
  console.log(`产出文件 (${cfg.out}/):`);
  console.log(`  daily_${key}.csv        每日汇总 (含反推 vs 真实入住率、误差)`);
  console.log(`  snapshots_${key}.csv    逐时点明细 (长表: 日期×时点×平台)`);
  console.log(`  report_${key}.html      可视化报告 (浏览器打开)`);
}

// ---------------------------------------------------------------- 输出: CSV / HTML

function toCSV(rows) {
  return '﻿' + rows.map(r => r.join(',')).join('\n') + '\n';
}

function writeOutputs(cfg, result) {
  const { days, monthStats, monthLabel, key } = result;
  fs.mkdirSync(cfg.out, { recursive: true });

  // 每日汇总 (宽表)
  const dailyRows = [['日期', '日期类型', '节假日', '当日预订量', '携程剩00:00', '携程剩08:00', '携程剩14:00', '携程剩20:00', '美团剩20:00', '反推入住率%', '真实入住率%', '误差pp', '携程价20:00', '美团价20:00', '携程日均价', '美团日均价']];
  for (const day of days) {
    const [s0, s1, s2, s3] = day.snapshots;
    dailyRows.push([
      day.date, day.type, day.type !== 'workday' && day.type !== 'weekend' ? day.typeLabel : '',
      day.demand,
      s0.ctrip.rem, s1.ctrip.rem, s2.ctrip.rem, s3.ctrip.rem, s3.meituan.rem,
      (day.inferredOcc * 100).toFixed(2), (day.trueOcc * 100).toFixed(2),
      ((day.trueOcc - day.inferredOcc) * 100).toFixed(2),
      s3.ctrip.price, s3.meituan.price, day.otaAvg.ctrip, day.otaAvg.meituan,
    ]);
  }
  fs.writeFileSync(path.join(cfg.out, `daily_${key}.csv`), toCSV(dailyRows), 'utf8');

  // 逐时点明细 (长表)
  const snapRows = [['日期', '日期类型', '抓取时点', '平台', '剩余间数', '价格元']];
  for (const day of days) {
    for (const snap of day.snapshots) {
      for (const ota of OTAS) {
        snapRows.push([day.date, day.type, snap.t, ota.name, snap[ota.key].rem, snap[ota.key].price]);
      }
    }
  }
  fs.writeFileSync(path.join(cfg.out, `snapshots_${key}.csv`), toCSV(snapRows), 'utf8');

  // HTML 报告
  const template = fs.readFileSync(path.join(__dirname, 'report_template.html'), 'utf8');
  const payload = {
    monthLabel,
    config: { hotel: '示例酒店', rooms: cfg.rooms, basePrice: cfg['base-price'], seed: cfg.seed, times: SNAPSHOT_TIMES },
    days,
    monthStats,
  };
  const html = template.replace('/*__DATA__*/', JSON.stringify(payload));
  fs.writeFileSync(path.join(cfg.out, `report_${key}.html`), html, 'utf8');
}

// ---------------------------------------------------------------- 入口

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const result = runMonth(cfg);
  printConsole(cfg, result);
  writeOutputs(cfg, result);
}

main();
