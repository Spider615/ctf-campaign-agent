"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorkspacePanelContext, type WorkspacePanelItem } from "./workspace-panel-context.ts";

const desktopQuery = "(min-width: 1280px)";
const subscribeViewport = (listener: () => void) => {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const desktopSnapshot = () => window.matchMedia(desktopQuery).matches;
const serverDesktopSnapshot = () => true;

function PanelContents({ item, panelId, onClose }: { item: WorkspacePanelItem; panelId: string; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    content.current?.scrollTo({ top: 0 });
  }, [item.id]);
  return <aside id={panelId} data-workspace-panel aria-labelledby={`${panelId}-title`} className="flex h-full min-w-0 flex-col bg-[#f8fbff] select-text">
    <header className="flex min-h-[76px] shrink-0 items-center justify-between gap-3 border-b border-[#dbe8f7] bg-white/80 px-5 py-3">
      <div className="min-w-0"><p className="text-[11px] text-muted-foreground">{item.label}</p><h2 ref={heading} id={`${panelId}-title`} tabIndex={-1} className="mt-1 break-words text-sm font-semibold leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.title}</h2></div>
      <div className="flex shrink-0 items-center gap-1">{item.actions}<button type="button" aria-label="关闭查看面板" title="关闭查看面板" onClick={onClose} className="grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X aria-hidden="true" className="size-4" /></button></div>
    </header>
    <div ref={content} className="relative min-h-0 flex-1 overflow-auto overscroll-contain p-5">{item.content}</div>
  </aside>;
}

export function WorkspacePanel({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<WorkspacePanelItem | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const desktop = useSyncExternalStore(subscribeViewport, desktopSnapshot, serverDesktopSnapshot);
  const closePanel = useCallback(() => { setItem(null); trigger.current?.focus({ preventScroll: true }); }, []);
  const togglePanel = useCallback((next: WorkspacePanelItem, button: HTMLButtonElement) => {
    trigger.current = button;
    setItem((current) => current?.id === next.id ? null : next);
  }, []);
  const dismissPanel = useCallback((ownerId: string) => { setItem((current) => current?.id.startsWith(`${ownerId}:`) ? null : current); }, []);
  const context = useMemo(() => ({ panelId, activeId: item?.id ?? null, togglePanel, closePanel, dismissPanel }), [panelId, item?.id, togglePanel, closePanel, dismissPanel]);
  useEffect(() => {
    if (!item || !desktop) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closePanel(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [item, desktop, closePanel]);

  const panel = item ? <PanelContents item={item} panelId={panelId} onClose={closePanel} /> : null;
  return <WorkspacePanelContext.Provider value={context}>
    <div className="h-[var(--workspace-h,calc(100dvh-4rem))] min-w-0 md:h-[var(--workspace-h,100vh)]">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="workspace-conversation" minSize="35%" className="min-w-0 overflow-y-auto">{children}</ResizablePanel>
        {item && desktop ? <><ResizableHandle withHandle className="bg-[#d4e4f4]" /><ResizablePanel key={item.width ?? "normal"} id="workspace-preview" defaultSize={item.width === "wide" ? "60%" : "42%"} minSize="30%" maxSize="65%" className="min-w-0">{panel}</ResizablePanel></> : null}
      </ResizablePanelGroup>
      <Sheet open={Boolean(item) && !desktop} onOpenChange={(open) => { if (!open) closePanel(); }}>
        <SheetContent side="right" showCloseButton={false} onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }} className={`w-full gap-0 border-l-[#d9e7f6] bg-[#f8fbff] p-0 ${item?.width === "wide" ? "sm:max-w-[900px]" : "sm:max-w-[600px]"} motion-reduce:transition-none motion-reduce:animate-none`}>
          <SheetHeader className="sr-only"><SheetTitle>{item?.title ?? "查看内容"}</SheetTitle><SheetDescription>查看数据依据或文件内容，关闭后返回原对话。</SheetDescription></SheetHeader>
          {!desktop ? panel : null}
        </SheetContent>
      </Sheet>
    </div>
  </WorkspacePanelContext.Provider>;
}
