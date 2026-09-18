/**
 * 단일 Report 블록을 provenance에 맞게 읽기 전용으로 렌더링한다 (#258 §10, IA 개편).
 *
 * BUILDER_EVIDENCE 블록은 항상 read-only다(사용자가 실제 값을 몰래 바꿔치기할 수 없게 —
 * #258 §3, §10). 수정하고 싶으면 evidence를 새로고침해 재생성하거나, 별도 USER_CONTENT
 * 블록으로 자기 설명을 덧붙인다.
 *
 * IA 개편(표만 나열하는 조회 화면 금지): `summary`(deterministic 문장 요약)를 먼저 보여주고,
 * 기존 `markdown`(표/상세 근거)는 `<details>`로 접어 필요할 때만 펼친다. 표 자체는 지우지
 * 않는다 — 위치만 옮긴다.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { Card } from "@/shared/ui";
import { renderMarkdownToReact } from "../markdown";
import type { BuilderEvidenceBlock, BuilderEvidenceSection, ReportBlock, ReportEvidenceRef } from "../types";
import { ProvenanceBadge } from "./ProvenanceBadge";

/** 상수로 두면 모듈 로드 시점에 언어가 고정돼 전환이 반영되지 않는다 — 호출 시 해석한다. */
function evidenceStatusLabel(status: string): string {
  return status === "ok" ? "" : i18n.t(`reports.block.status.${status}`);
}

function sectionLabel(section: BuilderEvidenceSection): string {
  return i18n.t(`reports.block.section.${section}`);
}

/**
 * NewBuildPage(#97)의 `<details className="group">` disclosure 패턴을 재사용하되, 열림 상태를
 * React state로 직접 제어한다 — 브라우저 기본 toggle 동작에만 기대면 테스트 환경/스크린리더
 * 조합에 따라 동작이 갈릴 수 있어, `summary` 클릭에서 기본 동작을 막고 state로만 연다/닫는다.
 */
function BuilderEvidenceBlockCard({ block }: { block: BuilderEvidenceBlock }) {
  const { t } = useTranslation();
  const [detailOpen, setDetailOpen] = useState(false);

  // Output이 확인 불가할 때는 summary가 이미 사유를 전부 담고 있어, 표를 펼쳐도 같은 문장을
  // 반복할 뿐이다 — 이때만 상세 근거 disclosure를 만들지 않는다(#258 IA 개편 §4).
  const hasDetail = !(block.section === "output" && block.evidenceStatus === "unavailable");
  // summary가 이미 evidenceStatus 사유를 문장으로 담고 있는 섹션이 많아, output에서는 배지성
  // 경고 문구를 중복 표시하지 않는다.
  const showStatusBanner = block.evidenceStatus !== "ok" && block.section !== "output";

  return (
    <Card className="space-y-3" data-testid={`block-${block.section}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{sectionLabel(block.section)}</h3>
        <ProvenanceBadge provenance="BUILDER_EVIDENCE" />
      </div>
      {showStatusBanner ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {evidenceStatusLabel(block.evidenceStatus)}
          {block.unavailableReason ? `: ${block.unavailableReason}` : ""}
        </p>
      ) : null}
      <div className="space-y-2 text-sm leading-relaxed text-foreground">
        {block.summary ? renderMarkdownToReact(block.summary) : renderMarkdownToReact(block.markdown)}
      </div>
      {block.summary && hasDetail ? (
        <details className="group border-t border-border pt-2" open={detailOpen}>
          <summary
            className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              setDetailOpen((prev) => !prev);
            }}
          >
            {t("reports.block.showDetail")}
            <span className="text-sm transition group-open:rotate-180" aria-hidden="true">
              ⌄
            </span>
          </summary>
          {detailOpen ? (
            <div className="mt-3 space-y-2 text-sm text-foreground">{renderMarkdownToReact(block.markdown)}</div>
          ) : null}
        </details>
      ) : null}
    </Card>
  );
}

export function BlockView({
  block,
  reportEvidenceRefs,
  onEditUserContent,
  onDeleteUserContent,
  onRemoveKubiBlock,
}: {
  block: ReportBlock;
  /** KUBI_INTERPRETATION 블록이 현재 Report와 같은 dataset/run 기준일 때만 넘긴다(#258 §7). */
  reportEvidenceRefs?: ReportEvidenceRef[];
  onEditUserContent?: (id: string) => void;
  onDeleteUserContent?: (id: string) => void;
  onRemoveKubiBlock?: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (block.provenance === "BUILDER_EVIDENCE") {
    return <BuilderEvidenceBlockCard block={block} />;
  }

  if (block.provenance === "KUBI_INTERPRETATION") {
    return (
      <Card className="space-y-2 border-indigo-200 dark:border-indigo-900/60" data-testid="block-kubi">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("reports.block.kubiTitle")}</h3>
          <div className="flex items-center gap-2">
            <ProvenanceBadge provenance="KUBI_INTERPRETATION" />
            {onRemoveKubiBlock ? (
              <button
                type="button"
                onClick={() => onRemoveKubiBlock(block.id)}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                {t("reports.block.remove")}
              </button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("reports.block.context", {
            dataset: block.sourceContext.datasetId ?? "N/A",
            run: block.sourceContext.runId ?? "N/A",
          })}
          {block.sourceContext.stage ? ` · Stage: ${block.sourceContext.stage}` : ""}
        </p>
        {!block.isSameContext ? (
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300">
            {t("reports.block.otherContext")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("reports.block.generatedAt", {
            at: new Date(block.generatedAt).toLocaleString(
              i18n.language?.startsWith("en") ? "en-US" : "ko-KR",
            ),
          })}
          {block.provider ? ` · provider ${block.provider}` : ""}
          {block.model ? ` · model ${block.model}` : ""}
        </p>
        <div className="space-y-2 text-sm text-foreground">{renderMarkdownToReact(block.note)}</div>
        <p className="text-xs italic text-muted-foreground">
          {t("reports.block.reason", { reason: block.reason })}
        </p>
        {block.isSameContext && reportEvidenceRefs && reportEvidenceRefs.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("reports.block.linkedEvidence", {
              refs: reportEvidenceRefs.map((ref) => ref.label).join(", "),
            })}
          </p>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className="space-y-2 border-amber-200 dark:border-amber-900/60" data-testid="block-user">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{block.heading}</h3>
        <div className="flex items-center gap-2">
          <ProvenanceBadge provenance="USER_CONTENT" />
          {onEditUserContent ? (
            <button
              type="button"
              onClick={() => onEditUserContent(block.id)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              {t("reports.block.edit")}
            </button>
          ) : null}
          {onDeleteUserContent ? (
            <button
              type="button"
              onClick={() => onDeleteUserContent(block.id)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              {t("reports.block.delete")}
            </button>
          ) : null}
        </div>
      </div>
      <div className="space-y-2 text-sm text-foreground">{renderMarkdownToReact(block.markdown)}</div>
    </Card>
  );
}
