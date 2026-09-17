type TextSelection = {
  isCollapsed: boolean;
  toString(): string;
};

export function hasMeaningfulTextSelection(selection: TextSelection | null): boolean {
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}
