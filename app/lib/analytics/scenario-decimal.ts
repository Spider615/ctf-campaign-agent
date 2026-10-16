// 固定十进制运算用于金额到分、比例情景；不执行字符串表达式。
export function decimalFraction(value: string | number): { numerator: bigint; denominator: bigint } {
  const source = String(value); const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!match || source.length > 80 || !Number.isFinite(Number(source))) throw new Error("情景数值不是有效十进制数");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 30) throw new Error("情景数值精度超过支持范围");
  const numerator = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
  return scale >= 0 ? { numerator, denominator: BigInt("1" + "0".repeat(scale)) } : { numerator: numerator * BigInt("1" + "0".repeat(-scale)), denominator: BigInt(1) };
}
export function roundFraction(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) throw new Error("情景计算分母必须为正");
  const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1); const absolute = numerator * sign;
  return sign * (absolute / denominator + (absolute % denominator * BigInt(2) >= denominator ? BigInt(1) : BigInt(0)));
}
export function safeScenarioInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("情景金额超出按分安全计算范围");
  return Number(value);
}
export function scenarioCents(value: string | number): bigint {
  const fraction = decimalFraction(value); return roundFraction(fraction.numerator * BigInt(100), fraction.denominator);
}
export function scenarioProductCents(amount: string, units: string | number): bigint {
  const a = decimalFraction(amount), b = decimalFraction(units);
  return roundFraction(a.numerator * b.numerator * BigInt(100), a.denominator * b.denominator);
}
export function scenarioRateCents(cents: bigint, rate: string): bigint {
  const fraction = decimalFraction(rate); return roundFraction(cents * fraction.numerator, fraction.denominator);
}
export function scenarioRevenue(baseCents: number, lossCents: number, netChange: string): { afterCents: number; changeCents: number } {
  if (![baseCents, lossCents].every(Number.isSafeInteger) || baseCents <= 0 || lossCents < 0 || lossCents > baseCents) throw new Error("情景基线与损失必须是同范围有效分金额");
  const q = decimalFraction(netChange);
  if (q.numerator <= -q.denominator) throw new Error("情景净增比例必须大于负百分之百");
  const after = roundFraction(BigInt(baseCents - lossCents) * (q.denominator + q.numerator), q.denominator);
  return { afterCents: safeScenarioInteger(after), changeCents: safeScenarioInteger(after - BigInt(baseCents)) };
}
