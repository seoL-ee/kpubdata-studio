/**
 * Report 내보내기 (#258 §12, §13).
 *
 * 실제로 구현하는 형식만 제공한다: Markdown 다운로드, 안전한 HTML 다운로드, Browser Print.
 * PDF/DOCX는 만들지 않으며 그렇게 보이게 표시하지 않는다 — Browser Print는 "PDF 생성"이
 * 아니라 브라우저 인쇄 대화상자를 여는 것뿐이다.
 *
 * 내보내는 파일에는 항상 title/dataset/base run/createdAt/evidenceFetchedAt/provenance
 * 구분/stale-orphan 경고를 포함한다. Kubi/사용자 콘텐츠는 `markdown.ts`의 안전 렌더러만
 * 거쳐 HTML로 들어간다 — 원문을 그대로 삽입하지 않는다.
 */
import { i18n } from "@/shared/i18n";
import { escapeHtml, renderMarkdownToHtml } from "./markdown";
import type { EvidenceRunStatus } from "./types";
import type { ReportDraft } from "./types";

/** 이 파일의 문장 키는 모두 이 네임스페이스 아래에 있다(#350). */
const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(`reports.export.${key}`, params ?? {});

/** 상태 라벨은 모듈 상수가 아니라 호출 시점에 만든다 — 상수로 두면 언어 전환이 반영되지 않는다. */
function statusLabel(status: EvidenceRunStatus): string {
  return t(`status.${status}`);
}

const FILENAME_INVALID_CHARS = /["*/:<>?\\|]/g;

/** 경로 구분자 등 파일명에 쓸 수 없는 문자를 제거하고 길이를 제한한다. */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(FILENAME_INVALID_CHARS, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "report";
}

function metadataLines(report: ReportDraft, staleness: EvidenceRunStatus | null): string[] {
  const lines = [
    `Report: ${report.title}`,
    `Dataset: ${report.datasetId}`,
    `Base Run: ${report.baseRunId}`,
    `BuildSpec digest: ${report.buildSpecDigest ?? "N/A"}`,
    `${t("meta.createdAt")}: ${report.createdAt}`,
    `${t("meta.evidenceFetchedAt")}: ${report.evidenceFetchedAt}`,
    `${t("meta.exportedAt")}: ${new Date().toISOString()}`,
  ];
  if (staleness) lines.push(`${t("meta.evidenceStatus")}: ${statusLabel(staleness)}`);
  return lines;
}

function provenanceLabel(kind: "BUILDER_EVIDENCE" | "KUBI_INTERPRETATION" | "USER_CONTENT"): string {
  if (kind === "BUILDER_EVIDENCE") return "[Builder Evidence]";
  return kind === "KUBI_INTERPRETATION" ? t("provenance.kubi") : t("provenance.user");
}

/** Markdown 파일 내용을 만든다. */
export function generateMarkdownExport(report: ReportDraft, staleness: EvidenceRunStatus | null): string {
  const parts = [`# ${report.title}`, "", metadataLines(report, staleness).map((line) => `- ${line}`).join("\n"), ""];

  for (const block of report.blocks) {
    if (block.provenance === "BUILDER_EVIDENCE") {
      parts.push(`## ${block.title} ${provenanceLabel("BUILDER_EVIDENCE")}`);
      if (block.evidenceStatus !== "ok") {
        parts.push(
          `> ${t("meta.evidenceStatusShort")}: ${block.evidenceStatus}${block.unavailableReason ? ` (${block.unavailableReason})` : ""}`,
        );
      }
      if (block.summary) {
        parts.push(block.summary);
        parts.push(`### ${t("detailHeading")}`);
      }
      parts.push(block.markdown);
    } else if (block.provenance === "KUBI_INTERPRETATION") {
      parts.push(`## ${t("kubiHeading")} ${provenanceLabel("KUBI_INTERPRETATION")}`);
      if (!block.isSameContext) {
        parts.push(
          `> ${t("kubiOtherRun", { dataset: block.sourceContext.datasetId ?? "N/A", run: block.sourceContext.runId ?? "N/A" })}`,
        );
      }
      parts.push(
        `${t("meta.createdAt")}: ${block.generatedAt}${block.provider ? ` / provider: ${block.provider}` : ""}${block.model ? ` / model: ${block.model}` : ""}`,
      );
      parts.push(block.note);
      parts.push(`_${t("reasonLabel")}: ${block.reason}_`);
    } else {
      parts.push(`## ${block.heading} ${provenanceLabel("USER_CONTENT")}`);
      parts.push(block.markdown);
    }
    parts.push("");
  }

  return parts.join("\n");
}

const HTML_DOC_STYLE = `
  body { font-family: -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; max-width: 860px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.65; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; font-size: .9rem; }
  th, td { border: 1px solid #ddd; padding: .4rem .6rem; text-align: left; }
  .meta { background: #f6f7f9; border: 1px solid #e2e4e8; border-radius: 8px; padding: 1rem; font-size: .85rem; }
  .tag { display: inline-block; font-size: .7rem; font-weight: 600; padding: .1rem .5rem; border-radius: 999px; margin-left: .4rem; }
  .tag-evidence { background: #e6f4ea; color: #1e6b3b; }
  .tag-kubi { background: #eef0ff; color: #3730a3; }
  .tag-user { background: #fff4e5; color: #92400e; }
  .warn { color: #92400e; background: #fff4e5; border: 1px solid #f3d9a8; border-radius: 6px; padding: .5rem .75rem; font-size: .85rem; }
`;

/** 안전한 self-contained HTML 문서를 만든다. `<script>`는 절대 포함하지 않는다. */
export function generateHtmlExport(report: ReportDraft, staleness: EvidenceRunStatus | null): string {
  const meta = metadataLines(report, staleness).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const staleWarning =
    staleness && staleness !== "current" ? `<p class="warn">${escapeHtml(statusLabel(staleness))}</p>` : "";

  const blocksHtml = report.blocks
    .map((block) => {
      if (block.provenance === "BUILDER_EVIDENCE") {
        const statusNote =
          block.evidenceStatus !== "ok"
            ? `<p class="warn">${escapeHtml(t("meta.evidenceStatusShort"))}: ${escapeHtml(block.evidenceStatus)}${block.unavailableReason ? ` (${escapeHtml(block.unavailableReason)})` : ""}</p>`
            : "";
        const summaryHtml = block.summary
          ? `${renderMarkdownToHtml(block.summary)}<h3>${escapeHtml(t("detailHeading"))}</h3>`
          : "";
        return `<h2>${escapeHtml(block.title)}<span class="tag tag-evidence">Builder Evidence</span></h2>${statusNote}${summaryHtml}${renderMarkdownToHtml(block.markdown)}`;
      }
      if (block.provenance === "KUBI_INTERPRETATION") {
        const contextNote = !block.isSameContext
          ? `<p class="warn">${escapeHtml(t("kubiOtherRunHtml", { dataset: block.sourceContext.datasetId ?? "N/A", run: block.sourceContext.runId ?? "N/A" }))}</p>`
          : "";
        return `<h2>${escapeHtml(t("kubiHeading"))}<span class="tag tag-kubi">${escapeHtml(t("tag.ai"))}</span></h2>${contextNote}<p><small>${escapeHtml(t("meta.createdAt"))}: ${escapeHtml(block.generatedAt)}${block.provider ? ` / provider: ${escapeHtml(block.provider)}` : ""}${block.model ? ` / model: ${escapeHtml(block.model)}` : ""}</small></p>${renderMarkdownToHtml(block.note)}<p><em>${escapeHtml(t("reasonLabel"))}: ${escapeHtml(block.reason)}</em></p>`;
      }
      return `<h2>${escapeHtml(block.heading)}<span class="tag tag-user">${escapeHtml(t("tag.user"))}</span></h2>${renderMarkdownToHtml(block.markdown)}`;
    })
    .join("\n");

  return [
    "<!doctype html>",
    '<html lang="ko"><head><meta charset="utf-8" />',
    `<title>${escapeHtml(report.title)}</title>`,
    `<style>${HTML_DOC_STYLE}</style>`,
    "</head><body>",
    `<h1>${escapeHtml(report.title)}</h1>`,
    `<ul class="meta">${meta}</ul>`,
    staleWarning,
    blocksHtml,
    "</body></html>",
  ].join("\n");
}

/** Blob을 만들어 브라우저 다운로드를 시작한다(실제 배포 웹앱 - Claude Artifact 샌드박스와 무관). */
export function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function downloadMarkdown(report: ReportDraft, staleness: EvidenceRunStatus | null): void {
  triggerDownload(`${sanitizeFilename(report.title)}.md`, generateMarkdownExport(report, staleness), "text/markdown;charset=utf-8");
}

export function downloadHtml(report: ReportDraft, staleness: EvidenceRunStatus | null): void {
  triggerDownload(`${sanitizeFilename(report.title)}.html`, generateHtmlExport(report, staleness), "text/html;charset=utf-8");
}
