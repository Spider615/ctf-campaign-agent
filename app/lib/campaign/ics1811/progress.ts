export function draftCompletion(totalRequired: number, missingCount: number): number {
  if (totalRequired <= 0) return 100;
  const completed = (totalRequired - missingCount) / totalRequired;
  return Math.round(Math.max(0, Math.min(1, completed)) * 100);
}
