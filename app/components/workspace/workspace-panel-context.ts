"use client";

import { createContext, useContext, type ReactNode } from "react";

// 出处与文件共用查看区；内容由各自的展示组件提供，不改变原始回答或文件。
export type WorkspacePanelItem = { id: string; title: string; label: string; content: ReactNode; actions?: ReactNode; width?: "wide" };
export type WorkspacePanelController = {
  panelId: string;
  activeId: string | null;
  togglePanel: (item: WorkspacePanelItem, trigger: HTMLButtonElement) => void;
  closePanel: () => void;
  dismissPanel: (ownerId: string) => void;
};

export const WorkspacePanelContext = createContext<WorkspacePanelController | null>(null);

export function useWorkspacePanel(): WorkspacePanelController {
  const panel = useContext(WorkspacePanelContext);
  if (!panel) throw new Error("查看内容需要放在工作区内。");
  return panel;
}
