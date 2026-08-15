#!/usr/bin/env node
/**
 * 大邑县住宿业税收监控模拟 (花水湾镇试点 → 可扩全县)
 *
 * 功能:
 * - 生成(或导入)县域住宿类商家: 酒店/温泉民宿/客栈/农家乐, 分布在 11 个乡镇/街道
 * - 逐商家模拟一个月经营: 每天 00:00/08:00/14:00/20:00 四个时点抓取 6 家 OTA 的
 *   "剩余X间"与价格 → 20:00 剩余反推入住率 → 入住率×房量×成交价 = 营业额
 * - 税收引擎: 增值税 + 附加税费 + 所得税 (口径见 TAX_CONFIG, 可配置)
 * - 输出: 商家明细/逐日聚合/逐时点长表 CSV + 单文件 HTML 仪表盘
 *
 * 用法:
 *   node simulate_county.js                                          # 花水湾镇试点, 2026-10
 *   node simulate_county.js --towns all                              # 全县 11 个乡镇/街道
 *   node simulate_county.js --roster import/商家名册.csv             # 用真实名册替代随机生成
 *   node simulate_county.js --check                                  # 运行并执行数值自检
 *   node simulate_county.js --month 2026-05 --seed 7 --out out/county
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ================================================================ 税收政策常量 (可配置)

const TAX_CONFIG = {
  // 增值税: 小规模纳税人月销售额≤10万免征; 超则 3%征收率减按 1% (财政部 税务总局公告2023年第19号, 执行至2027-12-31)
  exemptThreshold: 100000,
  smallVatRate: 0.01,
  // 一般纳税人: 住宿服务 6%, 进项按可配置抵扣率简化(假设)
  generalVatRate: 0.06,
  deductRate: 0.6,
  // 附加税费 = 增值税 × (城建税5%+教育费附加3%+地方教育附加2%); 小规模纳税人六税两费减半 (公告2023年第12号)
  surchargeRate: 0.1,
  halfSurcharge: true,
  // 所得税: 个体户经营所得核定征收率 1%, 年应纳税所得额≤200万减半 (公告2023年第12号, 核定征收率为假设)
  incomeRate: 0.01,
  halfIncome: true,
  // 企业所得税: 应纳税所得额=营业额×利润率(假设); 小型微利企业 25%×20% 实际 5%
  profitRate: 0.12,
  smallCoRate: 0.05,
  generalCoRate: 0.25,
  policyRef: '口径依据: 财政部 税务总局公告2023年第19号、第12号 (均执行至2027-12-31); 核定征收率/利润率/进项抵扣率为测算假设, 可在脚本顶部 TAX_CONFIG 调整',
};

/**
 * 逐商家税收测算
 * @param {string} taxType 个体户 | 小规模企业 | 一般纳税人
 * @param {number} monthlyRev 月营业额(元, 含税口径按不含税换算后计税)
 * @returns {{exempt:boolean, vat:number, surcharge:number, income:number, total:number, rate:number}}
 */
function taxEngine(taxType, monthlyRev) {
  const t = TAX_CONFIG;
  let vat = 0;
  let exempt = false;
  if (taxType === '一般纳税人') {
    // 销项 6% 减进项(按抵扣率简化)
    vat = (monthlyRev / (1 + t.generalVatRate)) * t.generalVatRate * (1 - t.deductRate);
  } else {
    if (monthlyRev <= t.exemptThreshold) {
      exempt = true;
    } else {
      vat = (monthlyRev / (1 + t.smallVatRate)) * t.smallVatRate;
    }
  }
  // 附加税费: 小规模(含个体户)六税两费减半
  const surFactor = t.surchargeRate * (taxType !== '一般纳税人' && t.halfSurcharge ? 0.5 : 1);
  const surcharge = vat * surFactor;
  // 所得税
  let income;
  if (taxType === '个体户') {
    income = monthlyRev * t.incomeRate * (t.halfIncome ? 0.5 : 1);
  } else if (taxType === '小规模企业') {
    income = monthlyRev * t.profitRate * t.smallCoRate;
  } else {
    income = monthlyRev * t.profitRate * t.generalCoRate;
  }
  const total = vat + surcharge + income;
  // 不含税营业收入: 增值税计税基础 (免征=含税口径; 小规模按1%价税分离; 一般纳税人按6%)
  const netRevenue = taxType === '一般纳税人'
    ? monthlyRev / (1 + t.generalVatRate)
    : (exempt ? monthlyRev : monthlyRev / (1 + t.smallVatRate));
  return { exempt, vat, surcharge, income, total, rate: monthlyRev > 0 ? total / monthlyRev : 0, netRevenue };
}

/** 三层聚合: 商家→镇→县域 (数值用分位储存以保持守恒) */
function aggregateTax(merchants) {
  const sum = { rev: 0, netRevenue: 0, vat: 0, surcharge: 0, income: 0, total: 0, n: 0, occSum: 0, rooms: 0 };
  const towns = {};
  for (const m of merchants) {
    const a = { rev: 0, netRevenue: 0, vat: 0, surcharge: 0, income: 0, total: 0, n: 0, occSum: 0, rooms: 0 };
    if (!towns[m.townId]) towns[m.townId] = Object.assign({ townId: m.townId, townName: m.townName }, a);
    const tt = towns[m.townId];
    for (const k of ['vat', 'surcharge', 'income', 'total', 'netRevenue']) {
      const v = Math.round(m.tax[k] * 100);
      tt[k] += v; sum[k] += v;
    }
    tt.rev += Math.round(m.monthlyRev * 100);
    sum.rev += Math.round(m.monthlyRev * 100);
    tt.n++; sum.n++;
    tt.occSum += m.avgOcc; sum.occSum += m.avgOcc;
    tt.rooms += m.rooms; sum.rooms += m.rooms;
  }
  const fin = (obj) => {
    obj.vat /= 100; obj.surcharge /= 100; obj.income /= 100; obj.total /= 100; obj.rev /= 100; obj.netRevenue /= 100;
    obj.avgOcc = obj.n ? obj.occSum / obj.n : 0;
    obj.rate = obj.rev > 0 ? obj.total / obj.rev : 0;
    delete obj.occSum;
    return obj;
  };
  return { county: fin(sum), towns: Object.values(towns).map(fin) };
}

// ================================================================ 参数

function parseArgs(argv) {
  const cfg = { month: '2026-10', seed: 42, towns: 'huashuiwan', roster: null, check: false, out: 'out/county' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(`用法:
  node simulate_county.js [选项]
选项:
  --month  YYYY-MM   模拟月份 (默认 2026-10, 含国庆假期)
  --towns  乡镇范围   huashuiwan=花水湾试点(默认) | all=全县11乡镇 | 逗号分隔列表
  --roster 名册CSV    存在则用真实名册替代随机生成 (模板: import/商家名册_模板.csv)
  --seed   随机种子   (默认 42)
  --out    输出目录   (默认 out/county)
  --check  运行后执行数值自检 (免征边界/税负分档/聚合守恒等)`);
      process.exit(0);
    }
    const m = /^--([a-z-]+)$/.exec(a);
    if (m && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      cfg[m[1]] = argv[i + 1];
      i++;
    }
  }
  if (argv.includes('--check')) cfg.check = true;
  cfg.seed = Number(cfg.seed);
  return cfg;
}

// ================================================================ 节假日表 (2026, 简化)

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

// ================================================================ 经营模型参数

const SNAPSHOT_TIMES = ['00:00', '08:00', '14:00', '20:00'];

// 日期类型 → 入住率基准 / 价格系数
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

// 6 家平台: 价格系数 + 剩余展示抖动
const OTAS = [
  { key: 'ctrip', name: '携程', priceFactor: 1.0, jitter: [-1, 0, 0, 1] },
  { key: 'meituan', name: '美团', priceFactor: 0.97, jitter: [-1, 0, 1, 1] },
  { key: 'feizhu', name: '飞猪', priceFactor: 0.99, jitter: [-1, 0, 0, 1] },
  { key: 'qunar', name: '去哪儿', priceFactor: 0.98, jitter: [-1, 0, 0, 0] },
  { key: 'tongcheng', name: '同程', priceFactor: 0.98, jitter: [0, 0, 1, 1] },
  { key: 'tujia', name: '途家', priceFactor: 1.02, jitter: [-1, -1, 0, 0] },
];
const OTA_BY_NAME = Object.fromEntries(OTAS.map(o => [o.name, o.key]));

// 商家类型画像: 房量/基准价区间, 入住率区间(按日期类型), 平台数区间, 纳税人类型分布
const TYPE_PARAMS = {
  '温泉民宿': { rooms: [8, 25], basePrice: [258, 688], occ: { wd: [0.5, 0.62], wk: [0.8, 0.9], hol: [0.94, 0.97] }, platforms: [2, 4], tax: [['个体户', 70], ['小规模企业', 30]] },
  '客栈': { rooms: [15, 50], basePrice: [168, 488], occ: { wd: [0.5, 0.6], wk: [0.78, 0.88], hol: [0.93, 0.97] }, platforms: [2, 4], tax: [['个体户', 80], ['小规模企业', 20]] },
  '农家乐': { rooms: [5, 20], basePrice: [128, 328], occ: { wd: [0.4, 0.55], wk: [0.7, 0.85], hol: [0.9, 0.96] }, platforms: [1, 3], tax: [['个体户', 100]] },
  '酒店': { rooms: [60, 200], basePrice: [388, 988], occ: { wd: [0.5, 0.62], wk: [0.78, 0.88], hol: [0.92, 0.96] }, platforms: [3, 5], tax: [['小规模企业', 60], ['一般纳税人', 40]] },
};

// 大邑县 11 个乡镇/街道画像: 商家权重 / 类型权重 / 入住率系数 / 价格系数
const TOWN_PARAMS = [
  { id: 'huashuiwan', name: '花水湾镇', w: 25, types: { '温泉民宿': 6, '酒店': 3, '客栈': 2, '农家乐': 1 }, occMul: { wd: 1.15, wk: 1.1, hol: 1.0 }, priceMul: { wd: 1.0, wk: 1.1, hol: 1.25 }, tag: '温泉度假集群' },
  { id: 'xiling', name: '西岭镇', w: 12, types: { '客栈': 4, '酒店': 3, '农家乐': 3, '温泉民宿': 1 }, occMul: { wd: 0.9, wk: 1.1, hol: 1.1 }, priceMul: { wd: 1.0, wk: 1.2, hol: 1.3 }, tag: '西岭雪山景区' },
  { id: 'anren', name: '安仁镇', w: 12, types: { '客栈': 5, '酒店': 4, '农家乐': 1 }, occMul: { wd: 0.9, wk: 1.0, hol: 1.2 }, priceMul: { wd: 1.0, wk: 1.05, hol: 1.2 }, tag: '安仁古镇' },
  { id: 'jinyuan', name: '晋原街道', w: 8, types: { '酒店': 7, '客栈': 2, '农家乐': 0 }, occMul: { wd: 1.15, wk: 0.9, hol: 0.85 }, priceMul: { wd: 1.0, wk: 0.95, hol: 1.05 }, tag: '县城商务' },
  { id: 'shaqu', name: '沙渠街道', w: 8, types: { '酒店': 5, '客栈': 3, '农家乐': 1 }, occMul: { wd: 1.1, wk: 0.95, hol: 0.9 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.05 }, tag: '工业园商务' },
  { id: 'qingxia', name: '青霞街道', w: 8, types: { '酒店': 5, '客栈': 3, '农家乐': 1 }, occMul: { wd: 1.1, wk: 0.95, hol: 0.9 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.05 }, tag: '商务' },
  { id: 'wangsi', name: '王泗镇', w: 5, types: { '客栈': 4, '农家乐': 4, '酒店': 2 }, occMul: { wd: 1.0, wk: 1.0, hol: 1.0 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.1 }, tag: '乡村' },
  { id: 'xinchang', name: '新场镇', w: 5, types: { '客栈': 5, '农家乐': 3, '酒店': 1 }, occMul: { wd: 0.95, wk: 1.05, hol: 1.15 }, priceMul: { wd: 1.0, wk: 1.05, hol: 1.2 }, tag: '新场古镇' },
  { id: 'yuelai', name: '悦来镇', w: 5, types: { '客栈': 4, '农家乐': 4, '酒店': 1 }, occMul: { wd: 1.0, wk: 1.0, hol: 1.0 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.1 }, tag: '乡村' },
  { id: 'chujiang', name: '䢺江镇', w: 5, types: { '农家乐': 4, '客栈': 4, '酒店': 1 }, occMul: { wd: 1.0, wk: 1.0, hol: 1.0 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.1 }, tag: '乡村' },
  { id: 'heming', name: '鹤鸣镇', w: 5, types: { '客栈': 4, '农家乐': 3, '酒店': 2 }, occMul: { wd: 0.95, wk: 1.0, hol: 1.1 }, priceMul: { wd: 1.0, wk: 1.0, hol: 1.15 }, tag: '道源景区' },
];

// 名称池 (模拟名册用)
const NAME_POOL = {
  '温泉民宿': { prefix: ['溪云栖', '玉凡', '半山', '云中漫步', '栖溪', '山语', '汤泉', '雅舍', '山房', '小筑', '竹里', '逸景'], suffix: '温泉民宿' },
  '客栈': { prefix: ['巷里', '水岸', '青瓦', '石桥', '老街', '溪边', '山脚', '云居', '初见', '慢时光'], suffix: '客栈' },
  '农家乐': { prefix: ['刘家', '张家', '山泉', '竹林', '老院子', '李家', '溪谷', '果园'], suffix: '农家乐' },
  '酒店': { prefix: ['中铁', '豪生', '凤栖林', '巴登', '第一村', '罗马假日', '逸景', '圣索亚', '兰庭', '邑境苑'], suffix: ['温泉大酒店', '温泉酒店', '假日酒店', '国际温泉度假酒店', '大酒店'] },
};

// ================================================================ 可复现随机数

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ================================================================ 商家名册 (生成 / 导入)

function weightedPick(rnd, obj) {
  const entries = Object.entries(obj).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [k, w] of entries) { r -= w; if (r < 0) return k; }
  return entries[entries.length - 1][0];
}

function loadRoster(file) {
  if (!file || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (rows.length < 2) return null;
  const header = rows[0].split(',');
  const col = {};
  header.forEach((h, i) => { col[h.trim()] = i; });
  const merchants = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i].split(',');
    const get = (name) => (c[col[name]] || '').trim();
    const type = get('类型');
    const townName = get('乡镇');
    const town = TOWN_PARAMS.find(t => t.name === townName);
    const platforms = get('平台列表').split(/[/、,;|]/).map(s => s.trim()).filter(Boolean)
      .map(n => OTA_BY_NAME[n]).filter(Boolean);
    if (!type || !TYPE_PARAMS[type] || !town || !platforms.length) {
      console.warn(`名册第 ${i + 1} 行跳过 (类型/乡镇/平台不识别): ${rows[i]}`);
      continue;
    }
    let taxType = get('纳税人类型') || '个体户';
    if (!['个体户', '小规模企业', '一般纳税人'].includes(taxType)) {
      console.warn(`名册第 ${i + 1} 行纳税人类型不识别, 按个体户处理: ${taxType}`);
      taxType = '个体户';
    }
    // 名册导入无真实入住观测 → 取类型画像区间中值作为模拟基准 (与随机生成的画像分布一致)
    const tp = TYPE_PARAMS[type];
    const mid = (r) => (r[0] + r[1]) / 2;
    merchants.push({
      id: `m${merchants.length + 1}`,
      name: get('商家名称') || `${town.name}${type}${merchants.length + 1}`,
      type, townId: town.id, townName: town.name,
      rooms: Number(get('房间数')) || 20,
      basePrice: Number(get('基准价')) || tp.basePrice[0],
      occ: { wd: mid(tp.occ.wd), wk: mid(tp.occ.wk), hol: mid(tp.occ.hol) },
      taxType,
      platforms,
    });
  }
  return merchants.length ? merchants : null;
}

function generateMerchants(cfg, rnd) {
  const towns = cfg.towns === 'all'
    ? TOWN_PARAMS
    : TOWN_PARAMS.filter(t => cfg.towns.split(',').includes(t.id));
  const merchants = [];
  for (const town of towns) {
    const n = Math.max(1, Math.round(town.w));
    for (let i = 0; i < n; i++) {
      const type = weightedPick(rnd, town.types);
      const tp = TYPE_PARAMS[type];
      const rooms = Math.round(tp.rooms[0] + rnd() * (tp.rooms[1] - tp.rooms[0]));
      const basePrice = Math.round(tp.basePrice[0] + rnd() * (tp.basePrice[1] - tp.basePrice[0]));
      const occ = {};
      for (const dt of ['wd', 'wk', 'hol']) {
        occ[dt] = tp.occ[dt][0] + rnd() * (tp.occ[dt][1] - tp.occ[dt][0]);
      }
      // 平台: 数量按类型区间; 途家对民宿类加权
      const nPlat = tp.platforms[0] + Math.floor(rnd() * (tp.platforms[1] - tp.platforms[0] + 1));
      const pool = OTAS.slice();
      if (type === '温泉民宿' || type === '农家乐') pool.push({ key: 'tujia', name: '途家', priceFactor: 1.02, jitter: [-1, -1, 0, 0] });
      const platforms = [];
      for (let k = 0; k < nPlat && pool.length; k++) {
        const idx = Math.floor(rnd() * pool.length);
        platforms.push(pool.splice(idx, 1)[0].key);
      }
      platforms.sort((a, b) => OTAS.findIndex(o => o.key === a) - OTAS.findIndex(o => o.key === b));
      // 纳税人类型
      let taxType = weightedPick(rnd, Object.fromEntries(tp.tax));
      if (type === '酒店' && rooms >= 120) taxType = weightedPick(rnd, { '一般纳税人': 70, '小规模企业': 30 });
      // 名称
      const np = NAME_POOL[type];
      const suffix = Array.isArray(np.suffix) ? np.suffix[Math.floor(rnd() * np.suffix.length)] : np.suffix;
      const name = `${town.name.replace(/镇$|街道$/, '')}${np.prefix[Math.floor(rnd() * np.prefix.length)]}${suffix}`;
      merchants.push({ id: `m${merchants.length + 1}`, name, type, townId: town.id, townName: town.name, rooms, basePrice, occ, taxType, platforms });
    }
  }
  return merchants;
}

// ================================================================ 逐商家月度模拟

function simulateMerchantMonth(m, cfg, rnd, y, mo) {
  const town = TOWN_PARAMS.find(t => t.id === m.townId);
  const otaByKey = Object.fromEntries(OTAS.map(o => [o.key, o]));
  const daysIn = new Date(y, mo, 0).getDate();
  const days = [];
  const snapRows = [];
  let monthlyRev = 0;
  let occSum = 0;

  for (let d = 1; d <= daysIn; d++) {
    const date = new Date(y, mo - 1, d);
    const key = fmtDate(date);
    const holidayName = HOLIDAYS_2026[key] || null;
    const dow = date.getDay();
    const type = holidayName ? 'holiday' : dow === 0 || dow === 6 ? 'weekend' : 'workday';
    const dtKey = { workday: 'wd', weekend: 'wk', holiday: 'hol' }[type];
    const dp = DAY_PARAMS[type];

    // 入住率: 类型画像 × 镇系数, 截断 [0.05, 0.98]
    const p = clamp(m.occ[dtKey] * town.occMul[dtKey], 0.05, 0.98);

    // 当日预订量 (逐间二项抽样)
    let demand = 0;
    for (let i = 0; i < m.rooms; i++) if (rnd() < p) demand++;

    // 到达时段分布
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < demand; i++) {
      const r = rnd();
      let acc = 0;
      for (let k = 0; k < ARRIVAL_WINDOWS.length; k++) {
        acc += ARRIVAL_WINDOWS[k].w;
        if (r < acc) { counts[k]++; break; }
      }
    }
    let cum = 0;
    const soldBySnapshot = [];
    for (let k = 0; k < 4; k++) { cum += counts[k]; soldBySnapshot.push(cum); }
    const finalSold = cum + counts[4];

    // 四个抓取时点 × 各平台
    const snap = [];
    for (let i = 0; i < SNAPSHOT_TIMES.length; i++) {
      const sold = soldBySnapshot[i];
      const hotelRem = m.rooms - sold;
      const row = { t: SNAPSHOT_TIMES[i] };
      for (const okey of m.platforms) {
        const ota = otaByKey[okey];
        const jitter = ota.jitter[Math.floor(rnd() * ota.jitter.length)];
        // 展示剩余只上浮不下浮(平台保守展示), 保证 20:00 反推 ≤ 真实入住率
        const displayed = clamp(hotelRem + jitter, hotelRem, m.rooms);
        const scarcity = 1 + 0.45 * (sold / m.rooms);
        const noise = 1 + (rnd() * 0.04 - 0.02);
        const price = Math.round(m.basePrice * dp.price * town.priceMul[dtKey] * scarcity * ota.priceFactor * noise);
        row[okey] = { rem: displayed, price };
        snapRows.push([key, m.id, m.name, m.townName, ota.name, SNAPSHOT_TIMES[i], displayed, price]);
      }
      snap.push(row);
    }

    // 日聚合: 20:00 反推(各平台平均), 日均价(各平台4时点均值再平均), 营业额=售出×均价
    const s20 = snap[3];
    const inferredRem = m.platforms.reduce((a, o) => a + s20[o].rem, 0) / m.platforms.length;
    const inferredOcc = (m.rooms - inferredRem) / m.rooms;
    const trueOcc = finalSold / m.rooms;
    const plat = m.platforms.map(okey => {
      const avg = snap.reduce((a, s) => a + s[okey].price, 0) / SNAPSHOT_TIMES.length;
      return { key: okey, name: otaByKey[okey].name, rem20: s20[okey].rem, avgPrice: Math.round(avg) };
    });
    const avgPrice = Math.round(plat.reduce((a, q) => a + q.avgPrice, 0) / plat.length);
    const rev = finalSold * avgPrice;
    monthlyRev += rev;
    occSum += trueOcc;
    days.push({
      date: key, label: `${date.getMonth() + 1}/${date.getDate()}`, type, typeLabel: holidayName || dp.label,
      sold: finalSold, trueOcc, inferredOcc, avgPrice, rev, platforms: plat,
    });
  }

  const tax = taxEngine(m.taxType, monthlyRev);
  return {
    ...m, days, snapRows, monthlyRev, avgOcc: occSum / days.length, tax,
  };
}

// ================================================================ 主流程

function run(cfg) {
  const [y, mo] = cfg.month.split('-').map(Number);
  const rnd = mulberry32(cfg.seed);
  const merchants = loadRoster(cfg.roster) || generateMerchants(cfg, rnd);
  const sim = merchants.map(m => simulateMerchantMonth(m, cfg, rnd, y, mo));
  const aggs = aggregateTax(sim);
  const key = `${cfg.month}-${cfg.towns === 'all' ? 'all' : cfg.towns.replace(/,/g, '+')}${cfg.roster ? '-roster' : ''}`;
  const meta = {
    monthLabel: `${y}年${mo}月`,
    key,
    seed: cfg.seed,
    scopeLabel: cfg.towns === 'all' ? '全县 11 个乡镇/街道' : sim[0] ? `${sim[0].townName}试点` : '',
    policyRef: TAX_CONFIG.policyRef,
    taxCfg: TAX_CONFIG,
    townsAll: TOWN_PARAMS.map(t => ({ id: t.id, name: t.name, tag: t.tag })),
    timezone: 'Asia/Shanghai',
    generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hourCycle: 'h23' }),
  };
  return { meta, merchants: sim, county: aggs.county, towns: aggs.towns };
}

// ================================================================ 数值自检

function runChecks(result, cfg) {
  const lines = [];
  const ok = (name, cond, detail) => lines.push({ name, pass: !!cond, detail });

  // ① 免征边界: 阈值两侧翻转
  for (const rev of [95000, 100000, 105000]) {
    const t = taxEngine('个体户', rev);
    ok(`免征边界 rev=${rev}`, rev <= 100000 ? (t.exempt && t.vat === 0) : (!t.exempt && t.vat > 0), `exempt=${t.exempt} vat=${t.vat.toFixed(2)}`);
  }

  // ② 税负分档 (应税区间)
  const band = {
    '个体户': [0.014, 0.018],
    '小规模企业': [0.015, 0.02],
    '一般纳税人': [0.045, 0.065],
  };
  for (const [tt, [lo, hi]] of Object.entries(band)) {
    const r = taxEngine(tt, 300000).rate;
    ok(`税负分档 ${tt}@30万`, r >= lo && r <= hi, `rate=${(r * 100).toFixed(2)}% 期望[${(lo * 100).toFixed(1)}%,${(hi * 100).toFixed(1)}%]`);
  }

  // ③ 同营业额下税负排序
  const r30 = ['个体户', '小规模企业', '一般纳税人'].map(t => taxEngine(t, 300000).total);
  ok('税负排序 个体户<小规模<一般', r30[0] < r30[1] && r30[1] < r30[2], `totals=${r30.map(v => v.toFixed(0)).join(' < ')}`);

  // ④ 聚合守恒: Σ商家 = Σ镇 = 县域 (统一按分位比较, 容差 1 分)
  const mtC = result.merchants.reduce((a, m) => a + Math.round(m.tax.total * 100), 0);
  const ttC = result.towns.reduce((a, t) => a + Math.round(t.total * 100), 0);
  const ctC = Math.round(result.county.total * 100);
  ok('聚合守恒 Σ商家=Σ镇=县域', Math.abs(mtC - ttC) <= 1 && Math.abs(ttC - ctC) <= 1, `${(mtC / 100).toFixed(2)} / ${(ttC / 100).toFixed(2)} / ${(ctC / 100).toFixed(2)}`);

  // ⑤ 每日反推 ≤ 真实
  let bad = 0;
  for (const m of result.merchants) for (const d of m.days) if (d.inferredOcc > d.trueOcc + 1e-9) bad++;
  ok('反推≤真实 (全月全商家)', bad === 0, `违例 ${bad} 条`);

  // ⑥ 县域税负率合理区间 + 免税商家存在
  // 理论上下限: 全一般纳税人≈5.49%(销项-抵扣+附加+所得), 全免征个体户≈0.5%(仅所得税减半)
  ok('县域总税负率∈[0.4%,5.6%]', result.county.rate >= 0.004 && result.county.rate <= 0.056, `rate=${(result.county.rate * 100).toFixed(2)}%`);
  if (!cfg.roster) {
    ok('随机生成画像县域税负率∈[1.2%,4.5%]', result.county.rate >= 0.012 && result.county.rate <= 0.045, `rate=${(result.county.rate * 100).toFixed(2)}%`);
  }
  const exemptN = result.merchants.filter(m => m.tax.exempt).length;
  ok('存在免征商家(月销售额≤10万)', exemptN > 0, `${exemptN}/${result.merchants.length} 家免征`);

  // ⑦ HTML 载荷体积 (与 writeOutputs 同口径: 剔除 snapRows)
  const stripped = { meta: result.meta, county: result.county, towns: result.towns, merchants: result.merchants.map(({ snapRows, ...rest }) => rest) };
  const kb = JSON.stringify(stripped).length / 1024;
  ok('PAYLOAD < 2MB', kb < 2048, `${kb.toFixed(0)} KB`);

  let fails = 0;
  console.log('\n' + '='.repeat(80) + '\n数值自检 (--check)\n' + '='.repeat(80));
  for (const l of lines) {
    console.log(`  ${l.pass ? 'PASS' : 'FAIL'}  ${l.name}${l.detail ? '  → ' + l.detail : ''}`);
    if (!l.pass) fails++;
  }
  console.log('='.repeat(80));
  return fails;
}

// ================================================================ 控制台输出

function dispWidth(s) { return Array.from(String(s)).reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0); }
function pad(s, n) { return String(s) + ' '.repeat(Math.max(0, n - dispWidth(s))); }
function money(v) { return '¥' + Math.round(v).toLocaleString('zh-CN'); }

function printConsole(result) {
  const { meta, county, towns, merchants } = result;
  const line = '='.repeat(100);
  console.log(line);
  console.log(`大邑县住宿业税收监控模拟 · ${meta.monthLabel} · ${meta.scopeLabel}`);
  console.log(`${merchants.length} 家商家 / ${county.rooms} 间房 / 营业收入(含税) ${money(county.rev)} / 测算税收 ${money(county.total)} / 总税负率 ${(county.rate * 100).toFixed(2)}%`);
  console.log(line);
  console.log(`${pad('乡镇/街道', 12)}${pad('商家', 6)}${pad('房间', 6)}${pad('营业收入', 12)}${pad('增值税', 10)}${pad('附加税', 10)}${pad('所得税', 10)}${pad('税收合计', 10)}${pad('税负率', 8)}`);
  console.log('-'.repeat(100));
  for (const t of towns.sort((a, b) => b.total - a.total)) {
    console.log(`${pad(t.townName, 12)}${pad(t.n, 6)}${pad(t.rooms, 6)}${pad(money(t.rev), 12)}${pad(money(t.vat), 10)}${pad(money(t.surcharge), 10)}${pad(money(t.income), 10)}${pad(money(t.total), 10)}${pad((t.rate * 100).toFixed(2) + '%', 8)}`);
  }
  console.log('-'.repeat(100));
  console.log(`${pad('县域合计', 12)}${pad(county.n, 6)}${pad(county.rooms, 6)}${pad(money(county.rev), 12)}${pad(money(county.vat), 10)}${pad(money(county.surcharge), 10)}${pad(money(county.income), 10)}${pad(money(county.total), 10)}${pad((county.rate * 100).toFixed(2) + '%', 8)}`);
  console.log(line);
  console.log('税收 TOP5 商家:');
  for (const m of merchants.slice().sort((a, b) => b.tax.total - a.tax.total).slice(0, 5)) {
    console.log(`  ${pad(m.name, 26)}${pad(m.taxType, 8)}${pad(m.type, 8)}${pad(money(m.tax.total), 10)}  (营业额 ${money(m.monthlyRev)}, 入住率 ${(m.avgOcc * 100).toFixed(1)}%${m.tax.exempt ? ', 增值税免征' : ''})`);
  }
  console.log(line);
  console.log(meta.policyRef);
  console.log('产出目录 out/county/: daily_/snapshots_/tax_/towns_/*.csv + county_report_*.html (浏览器打开仪表盘)');
}

// ================================================================ 输出 CSV / HTML

function toCSV(rows) { return '﻿' + rows.map(r => r.join(',')).join('\n') + '\n'; }

function writeOutputs(cfg, result) {
  const { meta, merchants, towns, county } = result;
  fs.mkdirSync(cfg.out, { recursive: true });
  const p = (name) => path.join(cfg.out, `${name}_${meta.key}.csv`);

  // 商家税收明细 (宽表)
  const taxRows = [['商家ID', '商家名称', '类型', '乡镇', '纳税人类型', '房间数', '基准价', '营业收入(含税)', '营业收入(不含税)', '增值税', '附加税费', '所得税', '税收合计', '税负率%', '增值税免征', '月均入住率%', '入驻平台']];
  for (const m of merchants) {
    taxRows.push([
      m.id, m.name, m.type, m.townName, m.taxType, m.rooms, m.basePrice,
      Math.round(m.monthlyRev), Math.round(m.tax.netRevenue),
      Math.round(m.tax.vat), Math.round(m.tax.surcharge), Math.round(m.tax.income), Math.round(m.tax.total),
      (m.tax.rate * 100).toFixed(2), m.tax.exempt ? '是' : '否', (m.avgOcc * 100).toFixed(1),
      m.platforms.map(k => (OTAS.find(o => o.key === k) || {}).name).join('/'),
    ]);
  }
  fs.writeFileSync(p('tax'), toCSV(taxRows), 'utf8');

  // 乡镇汇总
  const townRows = [['乡镇', '商家数', '房间数', '营业收入(含税)', '营业收入(不含税)', '增值税', '附加税费', '所得税', '税收合计', '税负率%']];
  for (const t of towns) townRows.push([t.townName, t.n, t.rooms, Math.round(t.rev), Math.round(t.netRevenue), Math.round(t.vat), Math.round(t.surcharge), Math.round(t.income), Math.round(t.total), (t.rate * 100).toFixed(2)]);
  townRows.push(['县域合计', county.n, county.rooms, Math.round(county.rev), Math.round(county.netRevenue), Math.round(county.vat), Math.round(county.surcharge), Math.round(county.income), Math.round(county.total), (county.rate * 100).toFixed(2)]);
  fs.writeFileSync(p('towns'), toCSV(townRows), 'utf8');

  // 逐日聚合 (商家×日×平台)
  const dailyRows = [['日期', '商家ID', '商家名称', '乡镇', '类型', '日期类型', '售出房晚', '真实入住率%', '反推入住率%', '日均价', '日营业额', '平台', '平台日均价', '平台20:00剩余']];
  for (const m of merchants) {
    for (const d of m.days) {
      for (const q of d.platforms) {
        dailyRows.push([d.date, m.id, m.name, m.townName, m.type, d.typeLabel, d.sold,
          (d.trueOcc * 100).toFixed(1), (d.inferredOcc * 100).toFixed(1), d.avgPrice, d.rev, q.name, q.avgPrice, q.rem20]);
      }
    }
  }
  fs.writeFileSync(p('daily'), toCSV(dailyRows), 'utf8');

  // 逐时点长表
  const snapHeader = ['日期', '商家ID', '商家名称', '乡镇', '平台', '抓取时点', '剩余间数', '价格元'];
  const snapAll = [snapHeader];
  for (const m of merchants) snapAll.push(...m.snapRows);
  fs.writeFileSync(p('snapshots'), toCSV(snapAll), 'utf8');

  // HTML 仪表盘
  const template = fs.readFileSync(path.join(__dirname, 'county_report_template.html'), 'utf8');
  const payload = {
    meta,
    county,
    towns,
    merchants: merchants.map(({ snapRows, ...rest }) => rest),
  };
  const html = template.replace('/*__DATA__*/', JSON.stringify(payload));
  fs.writeFileSync(path.join(cfg.out, `county_report_${meta.key}.html`), html, 'utf8');
}

// ================================================================ 入口

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const result = run(cfg);
  printConsole(result);
  writeOutputs(cfg, result);
  if (cfg.check) {
    const fails = runChecks(result, cfg);
    process.exitCode = fails > 0 ? 1 : 0;
  }
}

main();
