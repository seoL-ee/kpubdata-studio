/**
 * Reports 목록/생성 화면 (`/reports`, #258).
 *
 * 저장된 Report Draft 목록을 관리(열기/이름변경/복제/삭제)하고, 기준 dataset/run을 골라
 * Builder evidence 기반 deterministic Report를 새로 만든다. 실제 편집/블록 구성은
 * `/reports/:reportId`(`ReportEditorPage`)에서 이어진다.
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listDatasetRuns, listDatasets } from "@/features/datasets/api";
import { listKubiReportNotes } from "@/features/kubi/reportInbox";
import { buildDeterministicSections } from "@/features/reports/deterministicSections";
import { buildEvidenceRefs, fetchReportEvidence } from "@/features/reports/evidence";
import {
  createReport,
  deleteReport,
  duplicateReport,
  listReportSummaries,
  renameReport,
} from "@/features/reports/repository";
import type { ReportSummary } from "@/features/reports/types";
import type { DatasetRunSummary, DatasetSummary } from "@/shared/lib/builderApi";
import { Button, Card, EmptyState, ErrorState, PageHeader, Select } from "@/shared/ui";

interface AsyncState<T> {
  status: "idle" | "loading" | "loaded" | "error";
  data?: T;
  error?: string;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

export function ReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [pendingNoteCount, setPendingNoteCount] = useState(0);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [datasetsState, setDatasetsState] = useState<AsyncState<DatasetSummary[]>>({ status: "loading" });
  const [runsState, setRunsState] = useState<AsyncState<DatasetRunSummary[]>>({ status: "idle" });
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function refresh() {
    setSummaries(listReportSummaries());
    setPendingNoteCount(listKubiReportNotes().length);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDatasetsState({ status: "loading" });
    listDatasets(100, controller.signal)
      .then((datasets) => {
        setDatasetsState({ status: "loaded", data: datasets });
        if (datasets.length > 0) setSelectedDatasetId((current) => current || datasets[0].dataset_id);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDatasetsState({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("reports.errors.datasets") });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedDatasetId) {
      setRunsState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setRunsState({ status: "loading" });
    listDatasetRuns(selectedDatasetId, 50, controller.signal)
      .then((data) => {
        setRunsState({ status: "loaded", data: data.runs });
        setSelectedRunId(data.runs[0]?.run_id ?? "");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRunsState({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("reports.errors.runs") });
      });
    return () => controller.abort();
  }, [selectedDatasetId]);

  async function handleCreate() {
    if (!selectedDatasetId || !selectedRunId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const evidence = await fetchReportEvidence(selectedDatasetId, selectedRunId);
      const blocks = buildDeterministicSections(evidence);
      const evidenceRefs = buildEvidenceRefs(evidence);
      const datasetTitle = evidence.dataset.ok ? evidence.dataset.value.title : selectedDatasetId;
      const { report, result } = createReport({
        title: t("reports.page.createdTitle", { dataset: datasetTitle, run: selectedRunId }),
        datasetId: selectedDatasetId,
        baseRunId: selectedRunId,
        buildSpecDigest: evidence.run.ok ? evidence.run.value.spec_digest : null,
        evidenceFetchedAt: evidence.fetchedAt,
        blocks,
        evidenceRefs,
      });
      if (!result.ok) {
        setCreateError(result.reason);
        return;
      }
      navigate(`/reports/${encodeURIComponent(report.id)}`);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : i18n.t("reports.errors.create"));
    } finally {
      setCreating(false);
    }
  }

  function handleRenameSubmit() {
    if (!renameTarget) return;
    const result = renameReport(renameTarget.id, renameTarget.title.trim() || i18n.t("reports.page.untitled"));
    if (!result.ok) {
      setListError(result.reason);
      return;
    }
    setRenameTarget(null);
    refresh();
  }

  function handleDuplicate(id: string) {
    const outcome = duplicateReport(id);
    if (!outcome) return;
    if (!outcome.result.ok) {
      setListError(outcome.result.reason);
      return;
    }
    refresh();
  }

  function handleDelete(id: string) {
    if (!window.confirm(i18n.t("reports.page.deleteConfirm"))) return;
    deleteReport(id);
    refresh();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Reports"
        title={t("reports.page.title")}
        description={t("reports.page.desc")}
      />

      <Card>
        <p className="text-sm font-semibold">{t("reports.page.newTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("reports.page.newDesc")}
        </p>
        {datasetsState.status === "error" ? (
          <ErrorState className="mt-3" message={datasetsState.error ?? i18n.t("reports.errors.datasets")} />
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px]">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-dataset">
                Dataset
              </label>
              <Select
                id="report-dataset"
                className="mt-1"
                value={selectedDatasetId}
                onChange={(e) => setSelectedDatasetId(e.target.value)}
                disabled={datasetsState.status !== "loaded"}
              >
                {(datasetsState.data ?? []).map((dataset) => (
                  <option key={dataset.dataset_id} value={dataset.dataset_id}>
                    {dataset.title} ({dataset.dataset_id})
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-[220px]">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-run">
                Run
              </label>
              <Select
                id="report-run"
                className="mt-1"
                value={selectedRunId}
                onChange={(e) => setSelectedRunId(e.target.value)}
                disabled={runsState.status !== "loaded" || (runsState.data ?? []).length === 0}
              >
                {(runsState.data ?? []).map((run) => (
                  <option key={run.run_id} value={run.run_id}>
                    {run.run_id} · {run.status}
                  </option>
                ))}
              </Select>
            </div>
            <Button onClick={handleCreate} loading={creating} disabled={!selectedDatasetId || !selectedRunId}>
              {t("reports.page.createCta")}
            </Button>
          </div>
        )}
        {runsState.status === "loaded" && (runsState.data ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("reports.page.noRuns")}</p>
        ) : null}
        {createError ? <ErrorState className="mt-3" message={createError} /> : null}
      </Card>

      {pendingNoteCount > 0 ? (
        <Card className="border-indigo-200 bg-indigo-50 text-sm dark:border-indigo-900/60 dark:bg-indigo-950/30">
          {t("reports.page.pendingNotes", { count: pendingNoteCount })}
        </Card>
      ) : null}

      {listError ? <ErrorState message={listError} /> : null}

      <Card>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("reports.page.savedTitle")}</p>
        {summaries.length === 0 ? (
          <EmptyState className="py-8" title={t("reports.page.savedEmpty")} description={t("reports.page.savedEmptyDesc")} />
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {summaries.map((summary) => (
              <li key={summary.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                {renameTarget?.id === summary.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      autoFocus
                      className="w-full max-w-sm rounded-lg border border-input bg-card px-3 py-1.5 text-sm"
                      value={renameTarget.title}
                      onChange={(e) => setRenameTarget({ id: summary.id, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit();
                        if (e.key === "Escape") setRenameTarget(null);
                      }}
                    />
                    <Button size="sm" onClick={handleRenameSubmit}>
                      {t("reports.actions.save")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRenameTarget(null)}>
                      {t("reports.actions.cancel")}
                    </Button>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline"
                      onClick={() => navigate(`/reports/${encodeURIComponent(summary.id)}`)}
                    >
                      {summary.title}
                    </button>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {summary.datasetId} · {summary.baseRunId} · {t("reports.page.lastModified", { time: formatDateTime(summary.updatedAt) })}
                    </p>
                  </div>
                )}
                {renameTarget?.id !== summary.id ? (
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <button
                      type="button"
                      className="text-muted-foreground underline hover:text-foreground"
                      onClick={() => setRenameTarget({ id: summary.id, title: summary.title })}
                    >
                      {t("reports.actions.rename")}
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground underline hover:text-foreground"
                      onClick={() => handleDuplicate(summary.id)}
                    >
                      {t("reports.actions.duplicate")}
                    </button>
                    <button
                      type="button"
                      className="text-red-700 underline hover:text-red-900 dark:text-red-400"
                      onClick={() => handleDelete(summary.id)}
                    >
                      {t("reports.page.delete")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
