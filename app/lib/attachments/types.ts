import type { AnalysisAnswer } from "../analytics/analysis-v2-types.ts";
import type { AttachmentCalculation, Visualizations } from "../analytics/visualization-types.ts";
import type { ToolTrace } from "../tool-trace.ts";

export const ATTACHMENT_LIMITS = { fileBytes: 25 * 1024 * 1024, messageFiles: 10, messageBytes: 100 * 1024 * 1024, conversationBytes: 500 * 1024 * 1024, expandedBytes: 250 * 1024 * 1024, expandedFiles: 100, archiveDepth: 2, childBytes: 100 * 1024 * 1024, tableRows: 200_000, imagePixels: 40_000_000, retentionDays: 30, visionImages: 8 } as const;
export const CONVERSATION_ANSWER_SCHEMA = "conversation-answer/v1" as const;
export const ATTACHMENT_TOOLS = ["list_attachments", "read_attachment", "search_attachments", "calculate_attachment", "inspect_attachment_image", "analyze_attachment_history", "submit_attachment_answer", "review_attachment_answer", "present_analysis_chart"] as const;
export const ATTACHMENT_TOOL_LABELS: Record<typeof ATTACHMENT_TOOLS[number], string> = {
  list_attachments: "查看文件目录", read_attachment: "读取文件内容", search_attachments: "查找文件内容", calculate_attachment: "计算表格数据", inspect_attachment_image: "查看图片内容", analyze_attachment_history: "核对经营数据", submit_attachment_answer: "核验文件回答", review_attachment_answer: "复核文件依据", present_analysis_chart: "生成有来源的图表",
};
export type AttachmentStatus = "queued" | "processing" | "ready" | "partial" | "failed" | "unsupported" | "encrypted";
export type AttachmentEntry = { path: string; status: "ready" | "partial" | "failed" | "unsupported" | "encrypted"; detail?: string };
export type AttachmentSummary = { id: string; conversationId: string; name: string; size: number; mime: string; version: string; contentHash: string; parserVersion: string; status: AttachmentStatus; createdAt: string; expiresAt: string; blockCount: number; tableCount: number; imageCount: number; warnings: string[]; entries: AttachmentEntry[]; error?: string };
export type DocumentBlock = { id: string; kind: "text" | "heading" | "table" | "image"; text: string; location: string; archivePath?: string; imageId?: string };
export type AttachmentTable = { id: string; name: string; columns: string[]; rows: Array<Array<string | null>>; rowNumbers: number[]; rowEndNumbers?: number[]; location: string; archivePath?: string; warnings: string[]; mergedCells?: Array<{ range: string; anchor: string; value: string | null }>; calculationBlocked?: string };
export type AttachmentImage = { id: string; mime: "image/png" | "image/jpeg"; width: number; height: number; location: string; archivePath?: string };
export type ParsedAttachment = { status: AttachmentEntry["status"]; mime: string; blocks: DocumentBlock[]; tables: AttachmentTable[]; images: AttachmentImage[]; entries: AttachmentEntry[]; warnings: string[] };
export type AttachmentReference = Pick<AttachmentSummary, "id" | "conversationId" | "name" | "size" | "status" | "version" | "imageCount"> & { deleted?: boolean; unavailable?: boolean };
export type ConversationRequest = { conversationId: string; question: string; attachmentIds: string[]; history: Array<{ role: "user" | "assistant"; text: string }>; context?: string[] };
export type AttachmentSource = { id: string; attachmentId: string; version: string; name: string; location: string; kind: "document" | "table" | "image" | "database"; excerpt: string; imageId?: string; databaseRunId?: string; databaseFactId?: string; calculationId?: string };
export type ConversationDraft = { status: "answered" | "partial"; blocks: Array<{ text: string; sourceIds: string[] }>; limitations: string[] };
export type ConversationAnswer = ConversationDraft & { schema: typeof CONVERSATION_ANSWER_SCHEMA; sources: AttachmentSource[]; databaseAnswers?: AnalysisAnswer[]; trace?: ToolTrace; visualizations?: Visualizations; calculations?: AttachmentCalculation[] };
export const validAttachmentId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
