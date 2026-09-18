/**
 * Add Data 4단계 — Review & Build (#250).
 *
 * 표시되는 "실제 제출될 canonical BuildSpec"은 `toBuilderSpec(spec)`을 그대로
 * pretty-print한 것이다 — Build 제출에 쓰는 `serializeSpec`(compact JSON)과 같은
 * `toBuilderSpec` 호출 결과이므로 표시값과 제출값이 절대 갈라지지 않는다
 * (#250 amendment 1). stale preview(직전 Preview 이후 spec/옵션이 바뀜)면 Build를 막는다.
 *
 * 예외 두 가지(#283 리뷰 대응, Epic #246, 후속 리뷰 §1): url source의 endpoint,
 * public_api source의 sourceParams는 secret query/param(`api_key`/`serviceKey`/
 * `token`/`secret`, 고엔트로피 값)을 담을 수 있어 `redactBuildSpecForDisplay`/
 * `redactSourceParamsText`로 화면 표시 사본만 별도로 만든다 — 실제 Build 제출은
 * (`AddDataPage`의 onBuild → `job.start(specResult.spec)`) 이 컴포넌트를 거치지 않고
 * 원문 spec을 그대로 쓰므로, 표시용 redaction이 제출값에 영향을 주지 않는다.
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { toBuilderSpec } from "@/features/build-spec/specMapping";
import { previewSourceStateLabel, summarizeChecksPassed, summarizePreviewSources } from "@/features/quality/model";
import { QualityBadge } from "@/features/quality/QualityBadge";
import { redactBuildSpecForDisplay } from "@/features/add-data/model";
import { redactUrlEndpoint } from "@/features/add-data/urlRedaction";
import { redactSourceParamsText } from "@/features/add-data/paramsRedaction";
import type { PreviewSource } from "@/shared/lib/builderApi";
import type { BuildJobStatus } from "@/features/runs/useBuildJob";
import type { AddDataDraft, PreviewLimit, PreviewSampleMode } from "@/features/add-data/model";
import type { BuildSpec } from "@/shared/lib/types";
import { Button, Card } from "@/shared/ui";

export interface ReviewBuildStepProps {
  draft: AddDataDraft;
  spec?: BuildSpec;
  specError?: string;
  validation: { status: "idle" | "validating" | "validated"; valid: boolean; errors: string[] };
  /** Builder /preview가 반환한 모든 source(#250 §3) — 첫 항목만 쓰지 않는다. */
  previewSources: PreviewSource[];
  previewLimit: PreviewLimit;
  previewSampleMode: PreviewSampleMode;
  isStale: boolean;
  jobStatus: BuildJobStatus;
  jobError?: string;
  /** 사용자가 진행 중인 요청을 클라이언트에서 중단함(서버 실행 결과 미확인, sync build). */
  jobInterrupted?: boolean;
  runId?: string;
  onBuild: () => void;
  onCancel: () => void;
}

// 표시 전용 — sourceSummary/querySummary는 실제 Builder 제출값이 아니라 사람이 읽는
// Review 요약이므로 secret query parameter를 redact한 endpoint를 쓴다(#283 리뷰
// 대응, Epic #246). 실제 제출은 이 함수들을 거치지 않는다.
function sourceSummary(draft: AddDataDraft): string {
  if (draft.sourceKind === "public_api") return `Public API · ${draft.publicApi.provider}/${draft.publicApi.dataset}`;
  if (draft.sourceKind === "file") return `File Upload · ${draft.file.filename ?? draft.file.format ?? ""}`;
  if (draft.sourceKind === "url") return `URL / REST API · ${redactUrlEndpoint(draft.url.endpoint).endpoint}`;
  return i18n.t("addData.review.notSelected");
}

function querySummary(draft: AddDataDraft): string {
  if (draft.sourceKind === "public_api") return redactSourceParamsText(draft.publicApi.sourceParams).text;
  if (draft.sourceKind === "file") return `${draft.file.format ?? "—"} · ${draft.file.encoding}`;
  if (draft.sourceKind === "url") return redactUrlEndpoint(draft.url.endpoint).endpoint || "—";
  return "—";
}

const PIPELINE_STAGES = ["Bronze", "Validate", "Silver", "Gold"] as const;

/**
 * Pipeline stage-flow 표시용 상태(Prototype `reviewBuild()`의 stage-flow와 동일 발상).
 * Studio는 useBuildJob에서 stage 단위 진행률을 받지 않으므로, 실제로 아는 것(build job 전체
 * 상태)만 정직하게 반영한다 — 가짜 세부 진행률을 지어내지 않는다.
 */
function pipelineStageStatus(jobStatus: BuildJobStatus): string {
  if (jobStatus === "succeeded") return "Done";
  if (jobStatus === "failed") return i18n.t("addData.review.stageAborted");
  if (jobStatus === "running") return i18n.t("addData.review.stageRunning");
  return "Pending";
}

export function ReviewBuildStep({
  draft,
  spec,
  specError,
  validation,
  previewSources,
  previewLimit,
  previewSampleMode,
  isStale,
  jobStatus,
  jobError,
  jobInterrupted,
  runId,
  onBuild,
  onCancel,
}: ReviewBuildStepProps) {
  // 실제 제출은 항상 원문 `spec`으로 이뤄진다(AddDataPage의 onBuild가 이 컴포넌트가
  // 아니라 자신의 specResult.spec을 그대로 job.start에 넘긴다) — 여기서 만드는
  // displaySpec은 화면 표시 전용 사본이며, redact 여부가 실제 제출값에 전혀 영향을
  // 주지 않는다(#283 리뷰 대응, Epic #246).
  const { t } = useTranslation();
  const displaySpec = spec ? redactBuildSpecForDisplay(spec) : null;
  const displaySubmissionSpec = displaySpec ? toBuilderSpec(displaySpec) : null;
  // 여러 source의 quality_results를 합쳐 하나의 PASS로 지어내지 않는다 — Builder가
  // 실제로 반환한 결과를 그대로 합산(pass/warn/fail 카운트)하고, source별 상태가 갈리면
  // mixed로 표시한다(#250 §3).
  const totalRows = previewSources.length > 0 ? previewSources[0].total_rows : undefined;
  const previewsSummary = summarizePreviewSources(previewSources);
  const quality = previewSources.length > 0
    ? summarizeChecksPassed(previewSources.flatMap((s) => s.quality_results))
    : null;
  const canBuild =
    Boolean(spec) &&
    validation.status === "validated" &&
    validation.valid &&
    !isStale &&
    jobStatus !== "running";

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("addData.review.title")}</h3>

      <div className="grid gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("addData.review.datasetLabel")}</p>
          <p className="mt-1 text-base font-semibold">{draft.title || draft.datasetId || "—"}</p>
          <p className="text-xs text-muted-foreground">{sourceSummary(draft)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("addData.review.previewLabel")}</p>
          <p className="mt-1 text-base font-semibold">{previewLimit} rows · {previewSampleMode}</p>
          <p className="text-xs text-muted-foreground">
            {previewSources.length > 0
              ? previewSources.length > 1
                ? t("addData.review.previewMulti", {
                    count: previewSources.length,
                    mixed: previewsSummary.mixed ? " · mixed" : "",
                  })
                : t("addData.review.previewSingle", { total: totalRows })
              : t("addData.review.notRun")}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("addData.review.validationLabel")}</p>
          <p className="mt-1 text-base font-semibold">
            {validation.status !== "validated"
              ? t("addData.review.notRun")
              : validation.valid
                ? t("addData.review.passed")
                : t("addData.review.failedLabel")}
          </p>
          {quality ? <QualityBadge status={quality.status} /> : <p className="text-xs text-muted-foreground">{t("addData.review.noQuality")}</p>}
          {previewsSummary.mixed ? (
            <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {t("addData.review.mixedShort")}
            </p>
          ) : null}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("addData.review.outputLabel")}</p>
          <p className="mt-1 text-base font-semibold">{draft.exportFormats.join(", ").toUpperCase() || "—"}</p>
          <p className="text-xs text-muted-foreground">Bronze → Silver → Gold</p>
        </Card>
      </div>

      {isStale ? (
        <Card variant="error" className="p-4">
          <p role="alert" className="text-sm text-red-800 dark:text-red-200">
            {t("addData.review.staleWarning")}
          </p>
        </Card>
      ) : null}

      {!validation.valid && validation.status === "validated" ? (
        <Card variant="error" className="p-4">
          <ul className="space-y-1 text-sm text-red-800 dark:text-red-200">
            {validation.errors.map((err, i) => (
              <li key={i} role="alert">{err}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {specError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">{specError}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <p className="text-sm font-semibold">Build plan</p>
          <dl className="divide-y divide-border text-sm">
            {[
              ["Source / Provider", sourceSummary(draft)],
              ["Dataset", draft.title || draft.datasetId || "—"],
              ["Query / Config", querySummary(draft)],
              [
                "Preview",
                previewSources.length > 0
                  ? previewSources.length > 1
                    ? t("addData.review.planPreviewMulti", {
                        limit: previewLimit,
                        mode: previewSampleMode,
                        count: previewSources.length,
                        mixed: previewsSummary.mixed ? " (mixed)" : "",
                      })
                    : t("addData.review.planPreviewSingle", {
                        limit: previewLimit,
                        mode: previewSampleMode,
                        total: totalRows,
                      })
                  : t("addData.review.notRun"),
              ],
              ["Validation", quality ? `${quality.pass}/${quality.evaluated} · ${quality.status}` : t("addData.review.notRun")],
              ["Output", draft.exportFormats.join(", ").toUpperCase() || "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 py-2">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </dl>
          {previewSources.length > 1 ? (
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-sm font-semibold">{t("addData.review.perSourceTitle")}</p>
              {previewsSummary.perSource.map(({ source: s, state, quality: q }) => (
                <div key={s.source_key} className="flex items-center justify-between text-sm">
                  <span>{s.source_key}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {previewSourceStateLabel(state)}
                    {q.evaluated > 0 ? <QualityBadge status={q.status} /> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="border-t border-border pt-3">
            <p className="text-sm font-semibold">Pipeline</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <div className="rounded-lg border border-border bg-card px-3 py-2">
                <p className="text-muted-foreground">Source</p>
                <p className="font-semibold">{jobStatus === "succeeded" ? "Done" : "Ready"}</p>
              </div>
              {PIPELINE_STAGES.map((stage) => (
                <span key={stage} className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-muted-foreground">→</span>
                  <span className="rounded-lg border border-border bg-card px-3 py-2">
                    <span className="block text-muted-foreground">{stage}</span>
                    <span className="block font-semibold">{pipelineStageStatus(jobStatus)}</span>
                  </span>
                </span>
              ))}
            </div>
          </div>
        </Card>

        <Card className="space-y-2">
          <p className="text-sm font-semibold">{t("addData.review.specTitle")}</p>
          <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
            <code>
              {displaySubmissionSpec
                ? JSON.stringify(displaySubmissionSpec, null, 2)
                : t("addData.review.specUnavailable")}
            </code>
          </pre>
          <p className="text-xs text-muted-foreground">
            {t("addData.review.specNote")}
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!canBuild} loading={jobStatus === "running"} onClick={onBuild}>
          {t("addData.review.startBuild")}
        </Button>
        {jobStatus === "running" ? (
          <Button variant="secondary" onClick={onCancel}>{t("addData.review.cancel")}</Button>
        ) : null}
        {jobStatus === "succeeded" && runId ? (
          <span className="text-sm text-accent-subtle-foreground">{t("addData.review.buildSucceeded", { runId })}</span>
        ) : null}
        {jobStatus === "failed" ? (
          <span role="alert" className="text-sm text-red-700 dark:text-red-300">{jobError}</span>
        ) : null}
        {jobStatus === "cancelled" ? (
          <span className="text-sm text-muted-foreground">{t("addData.review.buildCancelled")}</span>
        ) : null}
        {jobInterrupted && jobStatus !== "cancelled" ? (
          <span className="text-sm text-muted-foreground">{t("addData.review.interrupted")}</span>
        ) : null}
      </div>
    </div>
  );
}
