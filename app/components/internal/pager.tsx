"use client";

import { useState, type ReactNode } from "react";

import { PAGE_SIZES, pageCount, pageSlice, pageWindow } from "../../lib/internal/format";

// 管理端统一的分页条：共几条、页码、每页条数。只有一页且条数不多时也显示总数，方便核对。
export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (next: { page: number; pageSize: number }) => void }) {
  const pages = pageCount(total, pageSize);
  const current = Math.min(Math.max(1, page), pages);
  const button = "h-8 min-w-8 rounded-md px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <nav aria-label="分页" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[#4f6681]">
      <span>共 {total} 条</span>
      {pages > 1 ? (
        <div className="flex items-center gap-1">
          <button type="button" className={`${button} hover:bg-[#f1f7ff]`} disabled={current <= 1} onClick={() => onChange({ page: current - 1, pageSize })}>上一页</button>
          {pageWindow(current, pages).map((value, index) => value === "…"
            ? <span key={`gap-${index}`} className="px-1 text-[#8aa0b9]">…</span>
            : <button key={value} type="button" aria-current={value === current ? "page" : undefined} className={`${button} ${value === current ? "bg-[#2470cc] font-medium text-white" : "hover:bg-[#f1f7ff]"}`} onClick={() => onChange({ page: value, pageSize })}>{value}</button>)}
          <button type="button" className={`${button} hover:bg-[#f1f7ff]`} disabled={current >= pages} onClick={() => onChange({ page: current + 1, pageSize })}>下一页</button>
        </div>
      ) : null}
      <label className="ml-auto flex items-center gap-1.5">
        每页
        <select className="h-8 rounded-md border border-[#d6e6f7] bg-white px-1.5 text-sm text-[#293b54]" value={pageSize} onChange={(event) => onChange({ page: 1, pageSize: Number(event.target.value) })}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}
        </select>
      </label>
    </nav>
  );
}

// 前端分页：数据已全部在手的小列表（按天、按模型、切换记录、模型请求）。render 只拿到当前页的行。
export function PagedRows<T>({ rows, initialSize = 10, render }: { rows: readonly T[]; initialSize?: number; render: (pageRows: T[]) => ReactNode }) {
  const [state, setState] = useState({ page: 1, pageSize: initialSize });
  return (
    <>
      {render(pageSlice(rows, state.page, state.pageSize))}
      <Pager page={state.page} pageSize={state.pageSize} total={rows.length} onChange={setState} />
    </>
  );
}
