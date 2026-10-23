// 影响因素分析用到的统计：双向固定效应分解、同店同日去均值回归、门店属性回归的独有贡献、对数方差拆分。
// 纯函数，不依赖数值库；矩阵最多约 60 列，用正规方程加高斯消元。

// 解正规方程 (X'X) b = X'y；共线的列系数记 0。
export function leastSquares(columns: readonly Float64Array[], y: Float64Array): number[] {
  const k = columns.length; const n = y.length;
  const a = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let i = 0; i < k; i++) {
    const ci = columns[i];
    for (let j = i; j < k; j++) { const cj = columns[j]; let s = 0; for (let r = 0; r < n; r++) s += ci[r] * cj[r]; a[i][j] = s; a[j][i] = s; }
    let s = 0; for (let r = 0; r < n; r++) s += ci[r] * y[r]; a[i][k] = s;
  }
  const beta = new Array<number>(k).fill(0); const pivotOf = new Array<number>(k).fill(-1);
  let row = 0;
  for (let col = 0; col < k && row < k; col++) {
    let best = row; for (let r = row + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[best][col])) best = r;
    if (Math.abs(a[best][col]) < 1e-9 * Math.max(1, Math.abs(a[col][col]))) continue;
    [a[row], a[best]] = [a[best], a[row]];
    for (let r = 0; r < k; r++) if (r !== row) { const f = a[r][col] / a[row][col]; if (f) for (let c = col; c <= k; c++) a[r][c] -= f * a[row][c]; }
    pivotOf[col] = row; row++;
  }
  for (let col = 0; col < k; col++) if (pivotOf[col] >= 0) beta[col] = a[pivotOf[col]][k] / a[pivotOf[col]][col];
  return beta;
}

export function rSquared(columns: readonly Float64Array[], y: Float64Array): number {
  const beta = leastSquares(columns, y); const n = y.length;
  let mean = 0; for (let r = 0; r < n; r++) mean += y[r]; mean /= n;
  let ss = 0; let tot = 0;
  for (let r = 0; r < n; r++) { let fit = 0; for (let i = 0; i < columns.length; i++) fit += beta[i] * columns[i][r]; ss += (y[r] - fit) ** 2; tot += (y[r] - mean) ** 2; }
  return tot > 0 ? 1 - ss / tot : 0;
}

const groupIndex = (keys: readonly string[]) => { const map = new Map<string, number>(); return { index: keys.map((k) => { let i = map.get(k); if (i === undefined) { i = map.size; map.set(k, i); } return i; }), size: () => map.size }; };

// 门店 + 日期双向固定效应：交替求两组均值直到收敛，返回门店、日期、残差各占总平方和的份额（%）。
export function twoWayShares(storeKeys: readonly string[], dayKeys: readonly string[], y: Float64Array): { store: number; day: number; resid: number } {
  const s = groupIndex(storeKeys); const d = groupIndex(dayKeys); const n = y.length;
  const ns = s.size(); const nd = d.size();
  let mean = 0; for (let r = 0; r < n; r++) mean += y[r]; mean /= n;
  const a = new Float64Array(ns); const b = new Float64Array(nd);
  const cs = new Float64Array(ns); const cd = new Float64Array(nd);
  for (let r = 0; r < n; r++) { cs[s.index[r]]++; cd[d.index[r]]++; }
  for (let iter = 0; iter < 60; iter++) {
    a.fill(0); for (let r = 0; r < n; r++) a[s.index[r]] += y[r] - mean - b[d.index[r]]; for (let i = 0; i < ns; i++) a[i] /= cs[i];
    b.fill(0); for (let r = 0; r < n; r++) b[d.index[r]] += y[r] - mean - a[s.index[r]]; for (let i = 0; i < nd; i++) b[i] /= cd[i];
  }
  let tot = 0; let st = 0; let dt = 0; let re = 0;
  for (let r = 0; r < n; r++) { const ai = a[s.index[r]]; const bi = b[d.index[r]]; tot += (y[r] - mean) ** 2; st += ai ** 2; dt += bi ** 2; re += (y[r] - mean - ai - bi) ** 2; }
  return tot > 0 ? { store: st / tot * 100, day: dt / tot * 100, resid: re / tot * 100 } : { store: 0, day: 0, resid: 0 };
}

// 按门店、日期交替去均值（双向固定效应），返回的函数把一列数换成「比本店平时、比全国这一天」高多少。
function twoWayDemeaner(storeKeys: readonly string[], dayKeys: readonly string[]): (v: Float64Array) => Float64Array {
  const s = groupIndex(storeKeys); const d = groupIndex(dayKeys); const n = storeKeys.length;
  const cs = new Float64Array(s.size()); const cd = new Float64Array(d.size());
  for (let r = 0; r < n; r++) { cs[s.index[r]]++; cd[d.index[r]]++; }
  return (v) => {
    const out = Float64Array.from(v); let mean = 0; for (let r = 0; r < n; r++) mean += out[r]; mean /= n; for (let r = 0; r < n; r++) out[r] -= mean;
    for (let iter = 0; iter < 40; iter++) {
      const ms = new Float64Array(cs.length); for (let r = 0; r < n; r++) ms[s.index[r]] += out[r]; for (let r = 0; r < n; r++) out[r] -= ms[s.index[r]] / cs[s.index[r]];
      const md = new Float64Array(cd.length); for (let r = 0; r < n; r++) md[d.index[r]] += out[r]; for (let r = 0; r < n; r++) out[r] -= md[d.index[r]] / cd[d.index[r]];
    }
    return out;
  };
}

// 同店不同日分档：x 和每个 y 都双向去均值后，按 x 从低到高分成 bands 个店日数相同的档，给出每档 x、各 y 的平均。
// 用来看「这一项比本店平时高 / 低的日子，结果怎样」，能看出先升后降这类非线性，回归系数看不出来。
export function withinStoreDayBands(storeKeys: readonly string[], dayKeys: readonly string[], x: Float64Array, ys: readonly Float64Array[], bands: number): Array<{ x: number; ys: number[]; n: number }> {
  const n = x.length; if (n < bands || bands < 1) return [];
  const demean = twoWayDemeaner(storeKeys, dayKeys); const dx = demean(x); const dys = ys.map(demean);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dx[a] - dx[b]);
  return Array.from({ length: bands }, (_, b) => {
    const idx = order.slice(Math.floor(b * n / bands), Math.floor((b + 1) * n / bands));
    const avg = (v: Float64Array) => idx.reduce((a, i) => a + v[i], 0) / idx.length;
    return { x: avg(dx), ys: dys.map(avg), n: idx.length };
  });
}

// 同店同日：把 y 和每个 x 按门店、日期双向去均值，再回归，系数就是「同一家店、同一天」的差。
export function withinStoreDay(storeKeys: readonly string[], dayKeys: readonly string[], y: Float64Array, xs: readonly Float64Array[]): number[] {
  return withinStoreDayFit(storeKeys, dayKeys, y, xs).beta;
}

// 同上，另给出偏 R²（%）：去掉门店、日期差异之后，这几个 x 还能解释剩余差异的多少。
export function withinStoreDayFit(storeKeys: readonly string[], dayKeys: readonly string[], y: Float64Array, xs: readonly Float64Array[]): { beta: number[]; r2: number } {
  const demean = twoWayDemeaner(storeKeys, dayKeys); const n = y.length;
  const dx = xs.map(demean); const dy = demean(y); const beta = leastSquares(dx, dy);
  let ss = 0; let tot = 0;
  for (let r = 0; r < n; r++) { let fit = 0; for (let i = 0; i < dx.length; i++) fit += beta[i] * dx[i][r]; ss += (dy[r] - fit) ** 2; tot += dy[r] ** 2; }
  return { beta, r2: tot > 0 ? (1 - ss / tot) * 100 : 0 };
}

// 类别属性展开成哑变量（第一个取值作基准，不建列）。
export function dummies(values: readonly string[]): Float64Array[] {
  const levels = [...new Set(values)].sort();
  return levels.slice(1).map((level) => Float64Array.from(values, (v) => v === level ? 1 : 0));
}

// 多个类别属性一起回归：整体 R²，以及每个属性拿掉后 R² 掉多少（独有贡献）。extra 是始终保留的连续变量。
export function uniqueContributions(attributes: Record<string, readonly string[]>, y: Float64Array, extra: readonly Float64Array[] = []): { full: number; unique: Record<string, number> } {
  const ones = new Float64Array(y.length).fill(1);
  const blocks = Object.fromEntries(Object.entries(attributes).map(([name, values]) => [name, dummies(values)]));
  const design = (skip?: string) => [ones, ...extra, ...Object.entries(blocks).filter(([name]) => name !== skip).flatMap(([, cols]) => cols)];
  const full = rSquared(design(), y);
  return { full, unique: Object.fromEntries(Object.keys(blocks).map((name) => [name, full - rSquared(design(name), y)])) };
}

// log(销售额) = log(订单数) + log(客单价)：两项各自方差和协方差占总方差的份额（%）。
export function logSplit(sales: readonly number[], orders: readonly number[]): { orders: number; aov: number; cov: number } {
  const ls = sales.map(Math.log); const lo = orders.map(Math.log); const la = ls.map((v, i) => v - lo[i]);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const ms = mean(ls); const mo = mean(lo); const ma = mean(la);
  const vs = mean(ls.map((v) => (v - ms) ** 2)); if (!(vs > 0)) return { orders: 0, aov: 0, cov: 0 };
  const vo = mean(lo.map((v) => (v - mo) ** 2)); const va = mean(la.map((v) => (v - ma) ** 2));
  const cov = mean(lo.map((v, i) => (v - mo) * (la[i] - ma)));
  return { orders: vo / vs * 100, aov: va / vs * 100, cov: 2 * cov / vs * 100 };
}

// 单个分组变量解释了多少方差（组间平方和 ÷ 总平方和，%）。
export function etaSquared(keys: readonly string[], y: Float64Array): number {
  const sum = new Map<string, { s: number; n: number }>(); let mean = 0;
  keys.forEach((k, i) => { const g = sum.get(k) ?? { s: 0, n: 0 }; g.s += y[i]; g.n++; sum.set(k, g); mean += y[i]; });
  mean /= y.length; let tot = 0; for (const v of y) tot += (v - mean) ** 2;
  let between = 0; for (const g of sum.values()) between += g.n * (g.s / g.n - mean) ** 2;
  return tot > 0 ? between / tot * 100 : 0;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null; const s = [...values].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 强弱档由解释度（%）换算：≥ 10 为强，2–10 为中，< 2 为弱。图上显示解释度本身，档位只决定颜色。
export const strengthOf = (share: number) => share >= 10 ? "strong" as const : share >= 2 ? "med" as const : "weak" as const;

// log(ys) = intercept + slope * log(xs) 的一元回归；sigma 是对数尺度残差的标准差（除以 n）。
// xs/ys 里非正数的那一行先丢弃；丢弃后样本不足 2 个时返回全 0（不崩、不产生 NaN），调用方据此判断这段关系算不出来。
export function logLinearFit(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; sigma: number; r2: number } {
  const pairs: Array<[number, number]> = []; for (let i = 0; i < Math.min(xs.length, ys.length); i++) if (xs[i] > 0 && ys[i] > 0) pairs.push([xs[i], ys[i]]);
  if (pairs.length < 2) return { slope: 0, intercept: 0, sigma: 0, r2: 0 };
  const lx = Float64Array.from(pairs, ([x]) => Math.log(x)); const ly = Float64Array.from(pairs, ([, y]) => Math.log(y));
  const ones = new Float64Array(pairs.length).fill(1);
  const [intercept, slope] = leastSquares([ones, lx], ly);
  const n = pairs.length; let ss = 0; for (let i = 0; i < n; i++) ss += (ly[i] - (intercept + slope * lx[i])) ** 2;
  const sigma = Math.sqrt(ss / n);
  const r2 = rSquared([ones, lx], ly);
  return { slope, intercept, sigma, r2 };
}
