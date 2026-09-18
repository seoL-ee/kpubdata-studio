/**
 * Workspace 화면 (`/workspace`, #260).
 *
 * Recent Work(Dataset/Build는 Builder 조회, Report/Saved BuildSpec은 Studio local)와
 * Saved BuildSpecs(로컬 저장 spec 작업대) 두 섹션으로 구성된다. 기존 `features/workspace`의
 * 개인/팀 워크스페이스 전환(static `WORKSPACES`) 개념과는 다르다 — 그 데모용 더미 데이터는
 * 이 이슈에서 제거했다(SettingsPage 참고).
 */
import { i18n } from "@/shared/i18n";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listDatasets } from "@/features/datasets/api";
import { listBuilds } from "@/features/runs/api";
import { listReportSummaries } from "@/features/reports/repository";
import type { ReportSummary } from "@/features/reports/types";
import {
  clearAllSavedSpecs,
  deleteSavedSpec,
  duplicateSavedSpec,
  listSavedSpecSummaries,
  renameSavedSpec,
} from "@/features/workspace/savedSpecs";
import { RECENT_WORK_DISPLAY_LIMIT, toRecentWorkItems, type RecentWorkItem, type RecentWorkKind } from "@/features/workspace/recentWork";
import type { SavedBuildSpecSummary, SavedSpecValidationStatus } from "@/features/workspace/types";
import type { DatasetSummary } from "@/shared/lib/builderApi";
import type { BuildListItem } from "@/shared/lib/types";
import { Button, Card, EmptyState, ErrorState, PageHeader } from "@/shared/ui";

interface AsyncState<T> {
  status: "loading" | "loaded" | "error";
  data?: T;
  error?: string;
}

const KIND_LABEL: Record<RecentWorkKind, string> = {
  dataset: "Dataset",
  build: "Build",
  report: "Report",
  savedSpec: "Saved BuildSpec",
};

/** 라벨은 키만 들고 렌더 시점에 번역한다 — 모듈 상수에 문장을 넣으면 언어가 굳는다(#350). */
const VALIDATION_META: Record<SavedSpecValidationStatus, { labelKey: string; className: string }> = {
  validated_pass: {
    labelKey: "workspace.validatedPass",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  validated_fail: {
    labelKey: "workspace.validatedFail",
    className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  },
  not_validated: {
    labelKey: "workspace.notValidated",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  },
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

export function WorkspacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [datasetsState, setDatasetsState] = useState<AsyncState<DatasetSummary[]>>({ status: "loading" });
  const [buildsState, setBuildsState] = useState<AsyncState<BuildListItem[]>>({ status: "loading" });
  const [reportSummaries, setReportSummaries] = useState<ReportSummary[]>([]);
  const [savedSpecSummaries, setSavedSpecSummaries] = useState<SavedBuildSpecSummary[]>([]);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshLocal = useCallback(() => {
    setReportSummaries(listReportSummaries());
    setSavedSpecSummaries(listSavedSpecSummaries());
  }, []);

  const loadDatasets = useCallback(() => {
    const controller = new AbortController();
    setDatasetsState({ status: "loading" });
    listDatasets(50, controller.signal)
      .then((data) => setDatasetsState({ status: "loaded", data }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDatasetsState({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("workspace.datasetsError"),
        });
      });
    return () => controller.abort();
  }, []);

  const loadBuilds = useCallback(() => {
    const controller = new AbortController();
    setBuildsState({ status: "loading" });
    listBuilds()
      .then((data) => setBuildsState({ status: "loaded", data }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setBuildsState({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("workspace.buildsError"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => loadDatasets(), [loadDatasets]);
  useEffect(() => loadBuilds(), [loadBuilds]);
  useEffect(() => refreshLocal(), [refreshLocal]);

  const recentWorkItems = useMemo(
    () =>
      toRecentWorkItems({
        datasets: datasetsState.data ?? [],
        builds: buildsState.data ?? [],
        reports: reportSummaries,
        savedSpecs: savedSpecSummaries,
      }).slice(0, RECENT_WORK_DISPLAY_LIMIT),
    [datasetsState.data, buildsState.data, reportSummaries, savedSpecSummaries],
  );

  const isNewUser =
    datasetsState.status !== "loading" &&
    buildsState.status !== "loading" &&
    recentWorkItems.length === 0 &&
    datasetsState.status !== "error" &&
    buildsState.status !== "error";

  function openItem(item: RecentWorkItem) {
    navigate(item.href);
  }

  function handleRenameSubmit() {
    if (!renameTarget) return;
    const result = renameSavedSpec(renameTarget.id, renameTarget.name.trim() || i18n.t("workspace.untitled"));
    if (!result.ok) {
      setActionError(result.reason);
      return;
    }
    setRenameTarget(null);
    refreshLocal();
  }

  function handleDuplicate(id: string) {
    const outcome = duplicateSavedSpec(id);
    if (!outcome) return;
    if (!outcome.result.ok) {
      setActionError(outcome.result.reason);
      return;
    }
    refreshLocal();
  }

  function handleDelete(id: string) {
    if (!window.confirm(i18n.t("workspace.deleteConfirm"))) return;
    deleteSavedSpec(id);
    refreshLocal();
  }

  function handleClearAllSpecs() {
    if (
      !window.confirm(
        i18n.t("workspace.deleteAllConfirm"),
      )
    )
      return;
    clearAllSavedSpecs();
    refreshLocal();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Workspace"
        title={t("workspace.title")}
        description={t("workspace.desc")}
      />

      <Card variant="dashed">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("workspace.localOnlyBadge")}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("workspace.localOnlyDesc")}
        </p>
      </Card>

      <section className="flex flex-col gap-3">
        <PageHeader eyebrow="Recent Work" title={t("workspace.recentTitle")} className="mb-0" />

        {datasetsState.status === "error" ? (
          <ErrorState
            className="py-6"
            title={t("workspace.datasetsErrorTitle")}
            message={datasetsState.error}
            onRetry={loadDatasets}
          />
        ) : null}
        {buildsState.status === "error" ? (
          <ErrorState
            className="py-6"
            title={t("workspace.buildsErrorTitle")}
            message={buildsState.error}
            onRetry={loadBuilds}
          />
        ) : null}

        {/* recentWorkItems를 loading 상태보다 먼저 확인한다 — Builder 조회가 아직 안 끝났거나
            실패해도, 이미 로드된 로컬(Report/Saved BuildSpec) 항목은 바로 보여준다(item 17). */}
        {recentWorkItems.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <ul>
              {recentWorkItems.map((item) => (
                <li key={`${item.kind}:${item.id}`} className="border-b border-border last:border-0">
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left text-sm transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="mr-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {KIND_LABEL[item.kind]}
                      </span>
                      <span className="font-medium text-foreground">{item.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                      <span>{item.source === "builder" ? "Builder" : t("workspace.thisBrowser")}</span>
                      <span>{formatDateTime(item.timestamp)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ) : datasetsState.status === "loading" || buildsState.status === "loading" ? (
          <Card className="animate-pulse text-sm text-muted-foreground">{t("workspace.loading")}</Card>
        ) : isNewUser ? (
          <Card>
            <EmptyState
              title={t("workspace.noWorkTitle")}
              description={t("workspace.noWorkDesc")}
              actionLabel={t("workspace.exploreCta")}
              actionHref="/discover"
            />
          </Card>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <PageHeader
          eyebrow="Saved BuildSpecs"
          title={t("workspace.savedSpecs")}
          className="mb-0"
          actions={
            savedSpecSummaries.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={handleClearAllSpecs}
              >
                {t("workspace.deleteAll")}
              </Button>
            ) : undefined
          }
        />

        {actionError ? <ErrorState className="py-4" message={actionError} /> : null}

        <Card>
          {savedSpecSummaries.length === 0 ? (
            <EmptyState
              className="py-8"
              title={t("workspace.noSpecs")}
              description={t("workspace.noSpecsDesc")}
              actionLabel={t("workspace.newBuild")}
              actionHref="/builds/new"
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {savedSpecSummaries.map((summary) => {
                const validation = VALIDATION_META[summary.validationStatus];
                return (
                  <li key={summary.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    {renameTarget?.id === summary.id ? (
                      <div className="flex flex-1 items-center gap-2">
                        <input
                          autoFocus
                          className="w-full max-w-sm rounded-lg border border-input bg-card px-3 py-1.5 text-sm"
                          value={renameTarget.name}
                          onChange={(event) => setRenameTarget({ id: summary.id, name: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") handleRenameSubmit();
                            if (event.key === "Escape") setRenameTarget(null);
                          }}
                        />
                        <Button size="sm" onClick={handleRenameSubmit}>
                          {t("workspace.save")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRenameTarget(null)}>
                          {t("workspace.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline"
                          onClick={() => navigate(`/builds/new?savedSpecId=${encodeURIComponent(summary.id)}`)}
                        >
                          {summary.name}
                        </button>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{summary.provider || t("workspace.noProvider")}</span>
                          <span>·</span>
                          <span className="break-all">{summary.outputPath || t("workspace.noOutput")}</span>
                          <span>·</span>
                          <span className={`rounded-full px-2 py-0.5 font-medium ${validation.className}`}>
                            {t(validation.labelKey)}
                          </span>
                          <span>{t("workspace.lastSaved", { time: formatDateTime(summary.updatedAt) })}</span>
                        </p>
                      </div>
                    )}
                    {renameTarget?.id !== summary.id ? (
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="text-muted-foreground underline hover:text-foreground"
                          onClick={() => setRenameTarget({ id: summary.id, name: summary.name })}
                        >
                          {t("workspace.rename")}
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground underline hover:text-foreground"
                          onClick={() => handleDuplicate(summary.id)}
                        >
                          {t("workspace.duplicate")}
                        </button>
                        <button
                          type="button"
                          className="text-red-700 underline hover:text-red-900 dark:text-red-400"
                          onClick={() => handleDelete(summary.id)}
                        >
                          {t("workspace.delete")}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </main>
  );
}
