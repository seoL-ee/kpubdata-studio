import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useNavigate, useSearchParams } from "react-router-dom";
import { loadDatasetCatalog, type CatalogDataset } from "@/features/datasets/api";
import {
  STAGE_STATUSES,
  datasetHasStageStatus,
  formatDateTime,
  summarizeDatasetStages,
  uniqueProviders,
} from "@/features/datasets/model";
import { QualityBadge } from "@/features/quality/QualityBadge";
import type { ValidationStatus } from "@/features/quality/model";
import type { StageStatus } from "@/shared/lib/builderApi";
import { Button, Card, EmptyState, ErrorState, PageHeader, SkeletonTable, TextInput } from "@/shared/ui";

interface CatalogState {
  status: "loading" | "loaded" | "error";
  datasets?: CatalogDataset[];
  error?: string;
}

const selectClassName =
  "h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const stageSummaryClass = {
  bronze: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  silver: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  gold: "bg-yellow-100 text-yellow-900 dark:bg-yellow-950/50 dark:text-yellow-200",
  warning: "bg-orange-100 text-orange-900 dark:bg-orange-950/50 dark:text-orange-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  muted: "bg-muted text-muted-foreground",
} as const;

export function DatasetCatalogPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<CatalogState>({ status: "loading" });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadDatasetCatalog(controller.signal)
      .then((datasets) => setState({ status: "loaded", datasets }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("catalog.errors.list"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  const query = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const stage = searchParams.get("stage") ?? "";
  const validation = searchParams.get("validation") ?? "";

  function updateParam(name: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next);
  }

  const providerOptions = useMemo(
    () => uniqueProviders((state.datasets ?? []).flatMap((dataset) => dataset.sources)),
    [state.datasets],
  );

  const visibleDatasets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (state.datasets ?? []).filter((dataset) => {
      const matchesQuery =
        !normalizedQuery ||
        dataset.dataset_id.toLocaleLowerCase().includes(normalizedQuery) ||
        dataset.title.toLocaleLowerCase().includes(normalizedQuery) ||
        dataset.sources.some((source) =>
          `${source.provider} ${source.dataset} ${source.alias}`.toLocaleLowerCase().includes(normalizedQuery),
        );
      const matchesProvider = !provider || dataset.sources.some((source) => source.provider === provider);
      const matchesStage = !stage || datasetHasStageStatus(dataset, stage as StageStatus);
      const matchesValidation = !validation || dataset.validation === validation;
      return matchesQuery && matchesProvider && matchesStage && matchesValidation;
    });
  }, [state.datasets, query, provider, stage, validation]);

  function openDataset(datasetId: string) {
    navigate(`/datasets/${encodeURIComponent(datasetId)}`);
  }

  return (
    <main className="flex flex-1 flex-col gap-5 px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
      <PageHeader
        eyebrow="Data"
        title="Dataset Catalog"
        description={t("catalog.page.desc")}
      />

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <div className="min-w-56 flex-1 lg:max-w-[390px]">
            <label htmlFor="dataset-search" className="sr-only">
              {t("catalog.searchLabel")}
            </label>
            <TextInput id="dataset-search" placeholder={t("catalog.searchPlaceholder")} value={query} onChange={(event) => updateParam("q", event.target.value)} />
          </div>
          <label className="min-w-36 flex-1 sm:flex-none">
            <span className="sr-only">Provider</span>
            <select aria-label="Provider" className={`w-full ${selectClassName}`} value={provider} onChange={(event) => updateParam("provider", event.target.value)}>
              <option value="">{t("catalog.allProviders")}</option>
              {providerOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="min-w-32 flex-1 sm:flex-none">
            <span className="sr-only">{t("catalog.stageLabel")}</span>
            <select aria-label={t("catalog.stageLabel")} className={`w-full ${selectClassName}`} value={stage} onChange={(event) => updateParam("stage", event.target.value)}>
              <option value="">{t("catalog.allStages")}</option>
              {STAGE_STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="min-w-36 flex-1 sm:flex-none">
            <span className="sr-only">Validation</span>
            <select aria-label="Validation" className={`w-full ${selectClassName}`} value={validation} onChange={(event) => updateParam("validation", event.target.value)}>
              <option value="">{t("catalog.allValidations")}</option>
              {(["PASS", "WARN", "FAIL", "N/A"] satisfies ValidationStatus[]).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>

        {state.status === "loading" ? (
          <SkeletonTable rows={5} className="w-full" />
        ) : state.status === "error" ? (
          <ErrorState title={t("catalog.errors.listTitle")} message={state.error} onRetry={load} />
        ) : visibleDatasets.length === 0 ? (
          <EmptyState title={t("catalog.noMatch.title")} description={t("catalog.noMatch.desc")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-5 py-3">Dataset</th><th className="px-5 py-3">Provider</th><th className="px-5 py-3">Stage</th><th className="px-5 py-3">Validation</th><th className="px-5 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {visibleDatasets.map((dataset) => (
                  <tr
                    key={dataset.dataset_id}
                    role="link"
                    tabIndex={0}
                    aria-label={t("catalog.openDetail", { title: dataset.title })}
                    className="cursor-pointer border-b border-border align-top transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring last:border-0"
                    onClick={() => openDataset(dataset.dataset_id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openDataset(dataset.dataset_id);
                      }
                    }}
                  >
                    <td className="px-5 py-4"><p className="font-semibold text-foreground">{dataset.title}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{dataset.dataset_id}</p></td>
                    <td className="px-5 py-4">{uniqueProviders(dataset.sources).join(", ")}</td>
                    <td className="px-5 py-4">{(() => {
                      const summary = summarizeDatasetStages(dataset.stages);
                      return <span title={summary.description} className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${stageSummaryClass[summary.tone]}`}>{summary.label}</span>;
                    })()}</td>
                    <td className="px-5 py-4"><QualityBadge status={dataset.validation} />{dataset.qualityError ? <p className="mt-1 max-w-44 text-xs text-muted-foreground">{t("catalog.qualityError")}</p> : null}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-muted-foreground">{formatDateTime(dataset.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.status === "loaded" ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <span>{t("catalog.shownCount", { count: visibleDatasets.length })}</span>
            {(query || provider || stage || validation) ? <Button variant="ghost" size="sm" onClick={() => setSearchParams({})}>{t("catalog.resetFilters")}</Button> : null}
          </div>
        ) : null}
      </Card>
    </main>
  );
}
