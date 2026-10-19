// 从优惠名称解析力度。名称是运营手写的，解析结果只是推断，界面上标「推」。
export function offerDepth(name: string): string | null {
  const gram = /克[减減](\d+)/.exec(name);
  if (gram) return `克减${gram[1]}元`;
  const discount = /(\d{2})折/.exec(name);
  if (discount) return `${discount[1]}折`;
  if (/金色星期/.test(name)) return "以旧换新";
  return null;
}
