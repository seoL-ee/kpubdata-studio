/**
 * Report 편집 화면 (`/reports/:reportId`, #258).
 *
 * 저장된 Report Draft 하나를 열어 문서(1~6 Builder evidence 요약, 7 Kubi 분석, 8 사용자 메모)를
 * 읽고 편집하고, 기준 evidence를 새로고침하거나 Kubi 참고 노트를 승인해 반영하고,
 * Markdown/HTML/Print로 내보낸다.
 *
 * IA(#258 IA 개편, Prototype SSOT `report-layout` 반영): desktop에서는 왼쪽에 실제 보고서
 * 문서, 오른쪽에 이 Report에 실제로 존재하는 값만 보여주는 Report Context sidebar를 둔
 * 2단 구조다. 좁은 viewport에서는 sidebar가 문서 아래로 collapse한다(`grid-cols-1` →
 * `lg:grid-cols-[minmax(0,1fr)_320px]`).
 *
 * 모든 편집 동작은 즉시 저장한다(autosave) — 그래야 "Evidence 새로고침" 같은 동작이
 * 저장되지 않은 사용자 편집을 잃어버릴 걱정 없이 deterministic 블록만 안전하게 교체할 수
 * 있다(#258 §9의 최소 안전 모델).
 */
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { buildDeterministicSections } from "@/features/reports/deterministicSections";
import { buildEvidenceRefs, fetchReportEvidence } from "@/features/reports/evidence";
import { downloadHtml, downloadMarkdown } from "@/features/reports/export";
import { buildSectionSummaries } from "@/features/reports/narrativeSummary";
import { createReport, getReport, saveReport } from "@/features/reports/repository";
import { checkReportEvidenceStatus, type EvidenceStalenessResult } from "@/features/reports/staleness";
import type {
  BuilderEvidenceBlock,
  BuilderEvidenceSection,
  KubiInterpretationBlock,
  ReportDraft,
  UserContentBlock,
} from "@/features/reports/types";
import { BlockView } from "@/features/reports/components/BlockView";
import { KubiInboxPanel } from "@/features/reports/components/KubiInboxPanel";
import { KubiReportPanel } from "@/features/reports/components/KubiReportPanel";
import { ReportContextSidebar } from "@/features/reports/components/ReportContextSidebar";
import { UserContentEditor } from "@/features/reports/components/UserContentEditor";
import { listKubiReportNotes } from "@/features/kubi/reportInbox";
import { Button, Card, EmptyState, ErrorState, PageHeader, TextInput } from "@/shared/ui";

function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `user-${crypto.randomUUID()}`;
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ReportEditorPage() {
  const { t } = useTranslation();
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();

  const [report, setReport] = useState<ReportDraft | null | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const [staleness, setStaleness] = useState<EvidenceStalenessResult | null>(null);
  const [stalenessLoading, setStalenessLoading] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [addingUserBlock, setAddingUserBlock] = useState(false);
  const [editingUserBlockId, setEditingUserBlockId] = useState<string | null>(null);

  const [titleDraft, setTitleDraft] = useState("");
  const [pendingKubiNoteCount, setPendingKubiNoteCount] = useState(0);

  // legacy summary(#258 legacy summary 수정): `summary`가 추가되기 전에 저장된 BUILDER_EVIDENCE
  // 블록은 이 값이 없다. 저장된 draft 자체를 임의로 migration하지 않고, 화면 표현만 현재
  // evidence 기준으로 보강한다 — evidence 재조회에 실패하면 null로 남아 기존처럼 표만 보인다.
  const [legacySummaries, setLegacySummaries] = useState<Record<BuilderEvidenceSection, string> | null>(null);

  useEffect(() => {
    if (!reportId) {
      setReport(null);
      return;
    }
    const loaded = getReport(reportId);
    setReport(loaded);
    setTitleDraft(loaded?.title ?? "");
  }, [reportId]);

  const refreshPendingKubiNoteCount = useCallback(() => {
    setPendingKubiNoteCount(listKubiReportNotes().length);
  }, []);

  useEffect(() => {
    refreshPendingKubiNoteCount();
  }, [refreshPendingKubiNoteCount]);

  const runStalenessCheck = useCallback((current: ReportDraft, signal?: AbortSignal) => {
    setStalenessLoading(true);
    checkReportEvidenceStatus(current.datasetId, current.baseRunId, signal)
      .then((result) => {
        if (signal?.aborted) return;
        setStaleness(result);
      })
      .finally(() => {
        if (!signal?.aborted) setStalenessLoading(false);
      });
  }, []);

  const loadedReportId = report?.id;
  useEffect(() => {
    if (!report) return;
    const controller = new AbortController();
    runStalenessCheck(report, controller.signal);
    return () => controller.abort();
    // report.id가 바뀔 때만 재확인하면 충분하다(같은 report 객체 참조 변경마다 재확인할 필요는 없음).
    // report/runStalenessCheck 자체는 매 렌더 새 참조가 될 수 있어 의도적으로 의존성에서 제외한다.
    // 이 재확인은 판정만 할 뿐 baseRunId를 절대 바꾸지 않는다(#258 §8 불변식) — STALE이어도
    // "최신 Run으로 새 Report 만들기"를 사용자가 명시적으로 눌러야만 별도 Report가 새로 생긴다.
  }, [loadedReportId]);

  useEffect(() => {
    if (!report) return;
    const hasLegacyBlock = report.blocks.some(
      (block) => block.provenance === "BUILDER_EVIDENCE" && !block.summary,
    );
    if (!hasLegacyBlock) {
      setLegacySummaries(null);
      return;
    }
    const controller = new AbortController();
    fetchReportEvidence(report.datasetId, report.baseRunId, controller.signal)
      .then((evidence) => {
        if (controller.signal.aborted) return;
        setLegacySummaries(buildSectionSummaries(evidence));
      })
      .catch(() => {
        // evidence 재조회 실패 — 저장된 draft(표만 있는 legacy 표시)를 그대로 유지한다.
        // summary 생성 실패 때문에 Report 전체를 깨지 않는다(#258 legacy summary §1).
      });
    return () => controller.abort();
    // report.id가 바뀔 때만 다시 계산한다 — 위 staleness 재확인과 동일한 이유로 report 객체
    // 참조 자체는 의존성에서 제외한다(예: 제목만 바꿔도 재조회가 다시 일어나지 않게).
  }, [loadedReportId]);

  function persist(next: ReportDraft) {
    const result = saveReport(next);
    if (!result.ok) {
      setSaveError(result.reason);
      return false;
    }
    const saved = { ...next, revision: result.revision };
    setReport(saved);
    setSaveError(null);
    setLastSavedAt(new Date().toISOString());
    return true;
  }

  function handleTitleBlur() {
    if (!report) return;
    const trimmed = titleDraft.trim() || t("reportEditor.untitled");
    if (trimmed === report.title) return;
    persist({ ...report, title: trimmed });
  }

  function handleAddUserBlock(heading: string, markdown: string) {
    if (!report) return;
    const now = new Date().toISOString();
    const block: UserContentBlock = {
      id: newBlockId(),
      provenance: "USER_CONTENT",
      heading,
      markdown,
      createdAt: now,
      updatedAt: now,
    };
    persist({ ...report, blocks: [...report.blocks, block] });
    setAddingUserBlock(false);
  }

  function handleEditUserBlock(id: string, heading: string, markdown: string) {
    if (!report) return;
    const now = new Date().toISOString();
    persist({
      ...report,
      blocks: report.blocks.map((block) =>
        block.id === id && block.provenance === "USER_CONTENT" ? { ...block, heading, markdown, updatedAt: now } : block,
      ),
    });
    setEditingUserBlockId(null);
  }

  function handleDeleteUserBlock(id: string) {
    if (!report) return;
    if (!window.confirm(t("reportEditor.deleteBlockConfirm"))) return;
    persist({ ...report, blocks: report.blocks.filter((block) => block.id !== id) });
  }

  function handleRemoveKubiBlock(id: string) {
    if (!report) return;
    persist({ ...report, blocks: report.blocks.filter((block) => block.id !== id) });
  }

  function handleApproveKubiBlock(block: KubiInterpretationBlock) {
    if (!report) return;
    persist({ ...report, blocks: [...report.blocks, block] });
  }

  async function handleRefreshEvidence() {
    if (!report) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const evidence = await fetchReportEvidence(report.datasetId, report.baseRunId);
      const nextEvidenceBlocks = buildDeterministicSections(evidence);
      const evidenceRefs = buildEvidenceRefs(evidence);
      // deterministic(BUILDER_EVIDENCE) 블록만 새로 만든 것으로 교체하고, Kubi/사용자 블록은 그대로 둔다
      // (#258 §9 — 자동 생성 영역과 사용자 작성 영역을 분리해 사용자 편집을 보존).
      const keptBlocks = report.blocks.filter((block) => block.provenance !== "BUILDER_EVIDENCE");
      const nextReport: ReportDraft = {
        ...report,
        evidenceFetchedAt: evidence.fetchedAt,
        buildSpecDigest: evidence.run.ok ? evidence.run.value.spec_digest : report.buildSpecDigest,
        blocks: [...nextEvidenceBlocks, ...keptBlocks],
        evidenceRefs,
      };
      persist(nextReport);
      runStalenessCheck(nextReport);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : t("reportEditor.refreshError"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreateFromLatest() {
    if (!report || !staleness?.latestRunId) return;
    try {
      const evidence = await fetchReportEvidence(report.datasetId, staleness.latestRunId);
      const blocks = buildDeterministicSections(evidence);
      const evidenceRefs = buildEvidenceRefs(evidence);
      const datasetTitle = evidence.dataset.ok ? evidence.dataset.value.title : report.datasetId;
      const { report: created, result } = createReport({
        title: t("reportEditor.newReportTitle", { dataset: datasetTitle, run: staleness.latestRunId }),
        datasetId: report.datasetId,
        baseRunId: staleness.latestRunId,
        buildSpecDigest: evidence.run.ok ? evidence.run.value.spec_digest : null,
        evidenceFetchedAt: evidence.fetchedAt,
        blocks,
        evidenceRefs,
      });
      if (!result.ok) {
        setRefreshError(result.reason);
        return;
      }
      navigate(`/reports/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : t("reportEditor.createError"));
    }
  }

  if (report === undefined) {
    return (
      <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <p className="text-sm text-muted-foreground">{t("reportEditor.loading")}</p>
      </main>
    );
  }

  if (report === null) {
    return (
      <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <PageHeader eyebrow="Reports" title={t("reportEditor.notFoundTitle")} description="" />
        <EmptyState
          title={t("reportEditor.notFoundHeading")}
          description={t("reportEditor.notFoundDesc")}
          actionLabel={t("reportEditor.backToList")}
          actionHref="/reports"
        />
      </main>
    );
  }

  const staleStatus = staleness?.status ?? null;

  const evidenceBlocks = report.blocks.filter(
    (block): block is BuilderEvidenceBlock => block.provenance === "BUILDER_EVIDENCE",
  );
  const kubiBlocks = report.blocks.filter(
    (block): block is KubiInterpretationBlock => block.provenance === "KUBI_INTERPRETATION",
  );
  const userBlocks = report.blocks.filter((block): block is UserContentBlock => block.provenance === "USER_CONTENT");

  // legacy summary 보강: 저장된 블록의 summary는 그대로 두고, 화면에 보여줄 값만 현재
  // evidence 기준 summary로 채운다(저장을 강제하지 않는다 — #258 legacy summary §1).
  const displayEvidenceBlocks = evidenceBlocks.map((block) => {
    if (block.summary) return block;
    const fallback = legacySummaries?.[block.section];
    return fallback ? { ...block, summary: fallback } : block;
  });

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10" id="report-print-area">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #report-print-area, #report-print-area * { visibility: visible; }
          #report-print-area { position: absolute; inset: 0; padding: 1.5rem; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>

      <div className="print:hidden">
        <PageHeader eyebrow="Reports" title={t("reportEditor.editTitle")} description={`${report.datasetId} · ${report.baseRunId}`} />
      </div>

      {/* Prototype SSOT(`docs/prototype/kpubdata_ui_prototype_v1.html`)의 `.report-layout`과
          동일한 원칙: desktop은 문서(가변폭) + Report Context(고정폭) 2단, 좁은 viewport에서는
          `grid-cols-1`로 collapse해 sidebar가 문서 아래로 내려온다. */}
      <div
        className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start"
        data-testid="report-layout-grid"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="print:hidden">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="report-title">
              {t("reportEditor.titleLabel")}
            </label>
            <TextInput
              id="report-title"
              className="mt-1 text-base font-semibold"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleBlur}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {t("reportEditor.savedRevision", { revision: report.revision })}
                {lastSavedAt
                  ? t("reportEditor.lastSaved", { time: new Date(lastSavedAt).toLocaleTimeString("ko-KR") })
                  : ""}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={handleRefreshEvidence} loading={refreshing}>
                  {t("reportEditor.refreshEvidence")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => downloadMarkdown(report, staleStatus)}>
                  {t("reportEditor.downloadMarkdown")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => downloadHtml(report, staleStatus)}>
                  {t("reportEditor.downloadHtml")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => window.print()}>
                  {t("reportEditor.print")}
                </Button>
              </div>
            </div>
            {saveError ? <ErrorState className="mt-2 py-4" message={saveError} /> : null}
            {refreshError ? <ErrorState className="mt-2 py-4" message={refreshError} /> : null}
          </Card>

          {/* 1~6. Builder evidence 기반 보고서 본문 — 문장 요약이 먼저 보이고, 표는 상세 근거로 접힌다. */}
          {displayEvidenceBlocks.map((block) => (
            <BlockView key={block.id} block={block} />
          ))}

          {/* 7. Kubi 분석 */}
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">{t("reportEditor.kubiSection")}</h2>
            {kubiBlocks.length === 0 ? (
              <EmptyState
                className="py-8"
                title={t("reportEditor.noKubiTitle")}
                description={t("reportEditor.noKubiDesc")}
              />
            ) : (
              kubiBlocks.map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  reportEvidenceRefs={block.isSameContext ? report.evidenceRefs : undefined}
                  onRemoveKubiBlock={handleRemoveKubiBlock}
                />
              ))
            )}
            <div className="print:hidden">
              <KubiReportPanel report={report} onApprove={handleApproveKubiBlock} />
            </div>
            <div className="print:hidden">
              <KubiInboxPanel
                report={report}
                onApprove={handleApproveKubiBlock}
                onNotesChanged={refreshPendingKubiNoteCount}
              />
            </div>
          </div>

          {/* 8. 사용자 메모 */}
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">{t("reportEditor.notesSection")}</h2>
            {userBlocks.map((block) =>
              editingUserBlockId === block.id ? (
                <UserContentEditor
                  key={block.id}
                  initialHeading={block.heading}
                  initialMarkdown={block.markdown}
                  onSave={(heading, markdown) => handleEditUserBlock(block.id, heading, markdown)}
                  onCancel={() => setEditingUserBlockId(null)}
                />
              ) : (
                <BlockView
                  key={block.id}
                  block={block}
                  onEditUserContent={() => setEditingUserBlockId(block.id)}
                  onDeleteUserContent={handleDeleteUserBlock}
                />
              ),
            )}
            <div className="print:hidden">
              {addingUserBlock ? (
                <UserContentEditor onSave={handleAddUserBlock} onCancel={() => setAddingUserBlock(false)} />
              ) : (
                <Button variant="secondary" onClick={() => setAddingUserBlock(true)}>
                  {t("reportEditor.addBlock")}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* desktop에서는 App Shell header(`Layout.tsx`의 `sticky top-0` 헤더, 대략 4~4.5rem 높이)
            아래에 이 sidebar도 같이 sticky로 고정한다(#258 sticky sidebar 수정) — 문서를
            스크롤해도 Report Context가 계속 보이게 한다. sidebar가 viewport보다 길어질 수
            있으므로 자체 높이를 viewport로 제한하고 내부 스크롤을 허용해, sticky 때문에 아래쪽
            내용(Kubi 카드 등)이 영영 보이지 않는 상태가 되지 않게 한다. 좁은 viewport(`lg` 미만)
            에서는 문서 아래로 collapse하는 기존 1단 레이아웃 그대로이므로 sticky를 걸지 않는다. */}
        <div
          className="print:hidden lg:sticky lg:top-20 lg:max-h-[calc(100vh-5.5rem)] lg:self-start lg:overflow-y-auto"
          data-testid="report-context-sidebar-wrapper"
        >
          <ReportContextSidebar
            report={report}
            staleness={staleness}
            stalenessLoading={stalenessLoading}
            onRecheck={() => runStalenessCheck(report)}
            onCreateFromLatest={staleness?.status === "stale" ? handleCreateFromLatest : undefined}
            kubiBlockCount={kubiBlocks.length}
            pendingKubiNoteCount={pendingKubiNoteCount}
          />
        </div>
      </div>
    </main>
  );
}
