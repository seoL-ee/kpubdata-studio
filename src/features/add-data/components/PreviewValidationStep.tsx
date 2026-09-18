/**
 * Add Data 3단계 — Preview & Validate (#250, #497).
 *
 * Builder `/preview`가 반환한 소스별 원본 응답(`PreviewResponse.previews[]`)을 그대로
 * 보여준다 — PASS/WARN/FAIL이나 diff는 Studio가 재계산하지 않고 Builder 값을 그대로
 * 쓴다(`features/quality/model.ts` 재사용). previews가 여러 개면(#250 §3 — YAML로
 * sources를 여러 개 붙여넣은 경우 등) 첫 항목만 보여주고 나머지를 버리지 않는다 — source별
 * 탭으로 전부 보여주고, 상태가 서로 다르면(mixed) 그 사실을 명시한다.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  formatQualityValue,
  isDuplicateCategory,
  isMissingCategory,
  isRangeCategory,
  isSchemaCategory,
  isTypeRule,
  previewSourceStateLabel,
  summarizeChecksPassed,
  summarizePreviewSources,
  warnOrFailResults,
} from "@/features/quality/model";
import { QualityBadge } from "@/features/quality/QualityBadge";
import type { PreviewResponse, PreviewSource } from "@/shared/lib/builderApi";
import type { PreviewColumnView, PreviewLimit, PreviewSampleMode } from "@/features/add-data/model";
import { Button, Card, EmptyState, Select } from "@/shared/ui";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; response: PreviewResponse }
  | { status: "error"; error: string };

export interface PreviewValidationStepProps {
  preview: PreviewState;
  limit: PreviewLimit;
  sampleMode: PreviewSampleMode;
  columns: PreviewColumnView;
  onChangeLimit: (limit: PreviewLimit) => void;
  onChangeSampleMode: (mode: PreviewSampleMode) => void;
  onChangeColumns: (columns: PreviewColumnView) => void;
  onRefresh: () => void;
  /**
   * 직전 Preview 실행 이후 Dataset/params 등 설정이 바뀌었는지 여부(AddDataPage의 stale
   * signature와 동일 값). true면 화면에 남아 있는 sample/검증 결과가 현재 설정과 다르다는
   * 사실을 알린다 — Build는 ReviewBuildStep의 기존 stale guard가 계속 차단한다.
   */
  isStale?: boolean;
  view: "sample" | "diff";
  onChangeView: (view: "sample" | "diff") => void;
}

const KEY_COLUMN_COUNT = 7;

function qualityBucket(source: PreviewSource, matcher: (category: string) => boolean) {
  return summarizeChecksPassed(source.quality_results.filter((r) => matcher(r.category)));
}

function typeBucket(source: PreviewSource) {
  return summarizeChecksPassed(source.quality_results.filter((r) => isTypeRule(r.rule)));
}

export function PreviewValidationStep({
  preview,
  limit,
  sampleMode,
  columns,
  onChangeLimit,
  onChangeSampleMode,
  onChangeColumns,
  onRefresh,
  isStale = false,
  view,
  onChangeView,
}: PreviewValidationStepProps) {
  const { t } = useTranslation();
  const previews = preview.status === "loaded" ? preview.response.previews : [];
  const [activeIndex, setActiveIndex] = useState(0);

  // preview 응답이 새로 도착하면(다시 조회) 첫 번째 source부터 다시 보여준다.
  useEffect(() => {
    setActiveIndex(0);
  }, [preview]);

  const safeIndex = Math.min(activeIndex, Math.max(previews.length - 1, 0));
  const source: PreviewSource | undefined = previews[safeIndex];
  const { mixed, perSource } = summarizePreviewSources(previews);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">{t("addData.preview.title")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("addData.preview.desc")}</p>
        </div>
        <Button variant="secondary" size="sm" loading={preview.status === "loading"} onClick={onRefresh}>
          {t("addData.preview.refresh")}
        </Button>
      </div>

      {preview.status === "idle" ? (
        <EmptyState title={t("addData.preview.idleTitle")} description={t("addData.preview.idleDesc")} />
      ) : null}
      {preview.status === "error" ? (
        <EmptyState title={t("addData.preview.errorTitle")} description={preview.error} />
      ) : null}

      {isStale && preview.status === "loaded" ? (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {t("addData.preview.stale")}
        </p>
      ) : null}

      {previews.length > 1 ? (
        <div className="space-y-2">
          <div role="tablist" aria-label="Preview source" className="flex flex-wrap gap-2">
            {perSource.map(({ source: s, state }, i) => (
              <button
                key={s.source_key}
                type="button"
                role="tab"
                aria-selected={i === safeIndex}
                onClick={() => setActiveIndex(i)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  i === safeIndex
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-muted text-muted-foreground"
                }`}
              >
                {s.source_key} · {previewSourceStateLabel(state)}
              </button>
            ))}
          </div>
          {mixed ? (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
              {t("addData.preview.mixed")}
            </p>
          ) : null}
        </div>
      ) : null}

      {source ? (
        <div className="preview-layout grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{t("addData.preview.sampleTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("addData.preview.sampleDesc")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={t("addData.preview.rowCountLabel")}
                  className="w-auto"
                  value={String(limit)}
                  onChange={(e) => onChangeLimit(Number(e.target.value) as PreviewLimit)}
                >
                  <option value="5">5 rows</option>
                  <option value="10">10 rows</option>
                  <option value="20">20 rows</option>
                </Select>
                <Select
                  aria-label={t("addData.preview.sampleModeLabel")}
                  className="w-auto"
                  value={sampleMode}
                  onChange={(e) => onChangeSampleMode(e.target.value as PreviewSampleMode)}
                >
                  <option value="first">first</option>
                  <option value="random">random</option>
                </Select>
                <Select
                  aria-label={t("addData.preview.columnScopeLabel")}
                  className="w-auto"
                  value={columns}
                  onChange={(e) => onChangeColumns(e.target.value as PreviewColumnView)}
                >
                  <option value="key">{t("addData.preview.keyColumns")}</option>
                  <option value="all">{t("addData.preview.allColumns")}</option>
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!source.diff_available}
                  onClick={() => onChangeView(view === "diff" ? "sample" : "diff")}
                >
                  {view === "diff" ? t("addData.preview.backToPreview") : t("addData.preview.showDiff")}
                </Button>
              </div>
            </div>

            {source.status === "failed" ? (
              <EmptyState title={t("addData.preview.sourceFailedTitle")} description={source.error ?? t("addData.preview.unknownError")} />
            ) : source.total_rows === 0 ? (
              <EmptyState title={t("addData.preview.zeroRowsTitle")} description={t("addData.preview.zeroRowsDesc")} />
            ) : view === "diff" ? (
              source.diff_available ? (
                <div className="space-y-2">
                  {source.diff_truncated ? (
                    <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
                      {t("addData.preview.diffTruncated", {
                        cells: source.transform_summary?.changed_cells ?? 0,
                        rows: source.transform_summary?.changed_rows ?? 0,
                      })}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("addData.preview.diffSummary", {
                        cells: source.transform_summary?.changed_cells ?? 0,
                        rows: source.transform_summary?.changed_rows ?? 0,
                      })}
                    </p>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase text-muted-foreground">
                          <th className="py-1 pr-3">Row</th>
                          <th className="py-1 pr-3">Column</th>
                          <th className="py-1 pr-3">{t("addData.preview.diffBefore")}</th>
                          <th className="py-1 pr-3">{t("addData.preview.diffAfter")}</th>
                          <th className="py-1 pr-3">{t("addData.preview.diffTransform")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {source.diffs.map((d, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="py-1 pr-3">{d.row}</td>
                            <td className="py-1 pr-3 font-medium">{d.column}</td>
                            <td className="py-1 pr-3 text-red-700 dark:text-red-300">{String(d.before)}</td>
                            <td className="py-1 pr-3 text-emerald-700 dark:text-emerald-300">{String(d.after)}</td>
                            <td className="py-1 pr-3 text-muted-foreground">{d.transform ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title={t("addData.preview.diffUnavailable")}
                  description={t("addData.preview.diffUnavailableDesc")}
                />
              )
            ) : (
              <SampleTable source={source} columnView={columns} />
            )}
          </Card>

          <ValidationPanel source={source} />
        </div>
      ) : null}
    </div>
  );
}

function SampleTable({ source, columnView }: { source: PreviewSource; columnView: PreviewColumnView }) {
  const { t } = useTranslation();
  const allColumns = source.schema.map((c) => c.name);
  const cols = columnView === "all" ? allColumns : allColumns.slice(0, KEY_COLUMN_COUNT);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase text-muted-foreground">
            {cols.map((c) => (
              <th key={c} className="py-1 pr-3">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {source.sample.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {cols.map((c) => (
                <td key={c} className="py-1 pr-3">
                  {row[c] === null || row[c] === undefined ? <span className="text-muted-foreground">—</span> : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("addData.preview.sampleFooter", {
          total: source.total_rows,
          shown: source.sample.length,
          columns: allColumns.length,
        })}
      </p>
    </div>
  );
}

function ValidationPanel({ source }: { source: PreviewSource }) {
  const { t } = useTranslation();
  const overall = summarizeChecksPassed(source.quality_results);
  const buckets: Array<{ label: string; summary: ReturnType<typeof summarizeChecksPassed> }> = [
    { label: "Schema", summary: qualityBucket(source, isSchemaCategory) },
    { label: "Missing", summary: qualityBucket(source, isMissingCategory) },
    { label: "Duplicate", summary: qualityBucket(source, isDuplicateCategory) },
    { label: "Type", summary: typeBucket(source) },
    { label: "Range", summary: qualityBucket(source, isRangeCategory) },
  ];
  const issues = warnOrFailResults(source.quality_results);

  return (
    <Card className="space-y-3">
      <p className="text-sm font-semibold">{t("addData.preview.validationTitle")}</p>
      {source.quality_results.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("addData.preview.notEvaluated")}</p>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-2xl font-semibold">{overall.pass} / {overall.evaluated}</span>
          <span className="text-xs text-muted-foreground">checks passed</span>
        </div>
      )}
      <div className="space-y-1.5">
        {buckets.map((b) => (
          <div key={b.label} className="flex items-center justify-between text-sm">
            <span>{b.label}</span>
            <QualityBadge status={b.summary.status} />
          </div>
        ))}
      </div>
      {issues.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-2">
          {issues.slice(0, 5).map((issue, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {issue.category}/{issue.rule}: {formatQualityValue(issue.rule, issue.actual)}
            </p>
          ))}
        </div>
      ) : null}
      <Link to="/quality" className="block w-full">
        <Button variant="secondary" size="sm" className="w-full">{t("addData.preview.qualityLink")}</Button>
      </Link>
    </Card>
  );
}
