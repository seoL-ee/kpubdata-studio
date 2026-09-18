import { i18n } from "@/shared/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { getBuild } from "@/features/runs/api/getBuild";
import {
  describePublishFailure,
  getPublishReadiness,
  isSafePublishReference,
  validatePublishDestination,
  type PublishReadinessResponse,
  type PublishRequest,
} from "@/features/publish/api";
import { usePublishJob } from "@/features/publish/usePublishJob";
import { formatDateTime } from "@/features/datasets/model";
import type { BuildRunStatus } from "@/shared/lib/types";
import { Button, Card, PageHeader, Skeleton, StatusBadge } from "@/shared/ui";

type ReadinessState =
  | { status: "loading" }
  | { status: "loaded"; data: PublishReadinessResponse }
  | { status: "error"; message: string };

/**
 * 게시 화면의 Run 문맥(Dataset identity + Build 완료 상태)은 URL의 `?dataset=` 존재
 * 여부가 아니라 **exact run_id**로만 해석한다 — Builds/Runs·Artifacts·Dataset Detail·
 * 딥링크 어느 경로로 들어와도 동일하게 표시되도록 한다. canonical 경로는
 * `getBuild(runId)`(= `/builds/{run_id}/spec` snapshot + authoritative status)이며,
 * latest run으로 대체하지 않는다.
 */
interface RunContext {
  datasetTitle: string;
  datasetId: string;
  status: BuildRunStatus;
  finishedAt: string | null;
}

type RunContextState =
  | { status: "loading" }
  | { status: "loaded"; data: RunContext }
  | { status: "error"; message: string };

/** 라벨이 아니라 키만 담는다 — 모듈 상수에 문장을 넣으면 언어가 굳는다(#350). */
const BUILD_STATUS_KEY: Record<BuildRunStatus, string> = {
  queued: "buildPublish.statusQueued",
  running: "buildPublish.statusRunning",
  cancelling: "buildPublish.statusCancelling",
  succeeded: "buildPublish.statusSucceeded",
  failed: "buildPublish.statusFailed",
  cancelled: "buildPublish.statusCancelled",
};

const inputClassName =
  "h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function BuildPublishPage() {
  const { t } = useTranslation();
  const { buildId: runId = "" } = useParams();
  const [searchParams] = useSearchParams();
  // `?dataset=`은 있으면 보조 표시 힌트로만 쓴다 — 없다고 실제 존재하는 Run을
  // "확인되지 않음"으로 만들지 않는다(canonical 해석은 runId 기반).
  const datasetHint = searchParams.get("dataset") ?? "";
  const [runContext, setRunContext] = useState<RunContextState>({ status: "loading" });
  const [readiness, setReadiness] = useState<ReadinessState>({ status: "loading" });
  const [readinessVersion, setReadinessVersion] = useState(0);
  const [destination, setDestination] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [confirmation, setConfirmation] = useState<PublishRequest>();
  const publish = usePublishJob();

  useEffect(() => {
    if (!runId) {
      setRunContext({ status: "error", message: i18n.t("buildPublish.noRunId") });
      return;
    }
    let active = true;
    setRunContext({ status: "loading" });
    // canonical: getBuild(runId) = BuildSpec snapshot(dataset identity) + authoritative status.
    // dataset URL 파라미터도, listDatasetRuns 윈도우도 필요로 하지 않는다.
    getBuild(runId)
      .then((run) => {
        if (!active) return;
        setRunContext({
          status: "loaded",
          data: {
            datasetTitle: run.spec.title || run.spec.datasetId || runId,
            datasetId: run.spec.datasetId,
            status: run.status,
            finishedAt: run.finishedAt ?? null,
          },
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setRunContext({
          status: "error",
          message: cause instanceof Error ? cause.message : i18n.t("buildPublish.runInfoError"),
        });
      });
    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setReadiness({ status: "error", message: i18n.t("buildPublish.noRunId") });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setReadiness({ status: "loading" });
    setConfirmation(undefined);
    publish.reset();
    getPublishReadiness(runId, "huggingface", controller.signal)
      .then((data) => {
        if (!active) return;
        if (data.run_id !== runId || data.target !== "huggingface") {
          setReadiness({ status: "error", message: i18n.t("buildPublish.readinessMismatch") });
          return;
        }
        setReadiness({ status: "loaded", data });
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setReadiness({ status: "error", message: describePublishFailure(cause).message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [runId, readinessVersion, publish.reset]);

  const runCtx = runContext.status === "loaded" ? runContext.data : null;
  const datasetLabel = runCtx?.datasetTitle ?? (datasetHint || null);
  const buildCompletionText =
    runContext.status === "loading"
      ? t("buildPublish.checking")
      : runCtx
        ? runCtx.status === "succeeded"
          ? runCtx.finishedAt
            ? t("buildPublish.completedAt", { time: formatDateTime(runCtx.finishedAt) })
            : t("buildPublish.completed")
          : `${t(BUILD_STATUS_KEY[runCtx.status])}${runCtx.finishedAt ? ` · ${formatDateTime(runCtx.finishedAt)}` : ""}`
        : t("buildPublish.unconfirmed");

  const destinationError = validatePublishDestination(destination);
  const builderReady = readiness.status === "loaded" && readiness.data.ready && readiness.data.blockers.length === 0;
  const canReview = Boolean(runId && builderReady && !destinationError && publish.status !== "publishing");

  const request = useMemo<PublishRequest>(() => ({
    target: "huggingface",
    destination,
    options: { private: isPrivate },
  }), [destination, isPrivate]);

  function updateDestination(value: string) {
    setDestination(value);
    setConfirmation(undefined);
    publish.reset();
  }

  function updatePrivate(value: boolean) {
    setIsPrivate(value);
    setConfirmation(undefined);
    publish.reset();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("buildPublish.eyebrow")}
        title={t("buildPublish.title", { name: datasetLabel || runId || "Run" })}
        description={t("buildPublish.desc")}
      />

      <Card>
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t("buildPublish.selectedRun")}</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Dataset</dt><dd>{datasetLabel || (runContext.status === "loading" ? t("buildPublish.checking") : t("buildPublish.unconfirmed"))}</dd></div>
          <div><dt className="text-muted-foreground">Run ID</dt><dd className="break-all font-mono">{runId || "—"}</dd></div>
          <div><dt className="text-muted-foreground">{t("buildPublish.buildCompleted")}</dt><dd>{buildCompletionText}</dd></div>
          <div><dt className="text-muted-foreground">Target</dt><dd>Hugging Face</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{t("buildPublish.exactRunNote")}</p>
        {runContext.status === "error" ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("buildPublish.datasetLoadWarn")}</p>
        ) : null}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold">Builder readiness</h2><p className="mt-1 text-xs text-muted-foreground">{t("buildPublish.readinessNote")}</p></div>
          <Button variant="secondary" size="sm" disabled={readiness.status === "loading" || publish.status === "publishing"} onClick={() => setReadinessVersion((value) => value + 1)}>{t("buildPublish.recheck")}</Button>
        </div>
        {readiness.status === "loading" ? <Skeleton className="mt-4 h-20 w-full" /> : null}
        {readiness.status === "error" ? <div className="mt-4" role="alert"><p className="text-sm text-red-700 dark:text-red-300">{readiness.message}</p></div> : null}
        {readiness.status === "loaded" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm font-medium">
              {builderReady
                ? t("buildPublish.readyLabel")
                : readiness.data.blockers.length > 0
                  ? t("buildPublish.blockedLabel")
                  // ready: false인데 blockers가 비어 있으면("빈 카드") "blocker가 있다"고
                  // 잘못 단정하지 않는다 — Builder가 사유를 제공하지 않은 것과 실제 blocker가
                  // 있는 것은 다른 상태다(UI audit #4).
                  : t("buildPublish.notReadyNoReason")}
            </p>
            {readiness.data.blockers.length > 0 ? <IssueList title="Blockers" issues={readiness.data.blockers} tone="error" /> : null}
            {readiness.data.warnings.length > 0 ? <IssueList title="Warnings" issues={readiness.data.warnings} tone="warning" /> : null}
            {readiness.data.blockers.some((issue) => issue.code === "credential_unavailable") ? <p className="text-xs text-muted-foreground">{t("buildPublish.credentialNote")}</p> : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">{t("buildPublish.settingsTitle")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("buildPublish.settingsNote")}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <label className="text-sm font-medium">Hugging Face destination
            <input aria-label="Hugging Face destination" className={`mt-2 ${inputClassName}`} placeholder="owner/dataset" value={destination} disabled={publish.status === "publishing"} onChange={(event) => updateDestination(event.target.value)} />
            <span className={`mt-1 block text-xs ${destinationError ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>{destinationError ?? t("buildPublish.destinationHint")}</span>
          </label>
          <label className="flex items-center gap-3 self-center rounded-lg border border-border p-4 text-sm">
            <input aria-label={t("buildPublish.privateLabel")} type="checkbox" checked={isPrivate} disabled={publish.status === "publishing"} onChange={(event) => updatePrivate(event.target.checked)} className="h-4 w-4 accent-emerald-600" />
            <span><strong className="block">{t("buildPublish.privateLabel")}</strong><span className="text-xs text-muted-foreground">{t("buildPublish.privateDefault")}</span></span>
          </label>
        </div>
      </Card>

      {!confirmation ? (
        <Button className="self-start" disabled={!canReview} onClick={() => setConfirmation(request)}>{t("buildPublish.review")}</Button>
      ) : (
        <Card className="border-emerald-300 dark:border-emerald-900" aria-label={t("buildPublish.confirmTitle")}>
          <h2 className="text-sm font-semibold">{t("buildPublish.confirmTitle")}</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Run ID</dt><dd className="font-mono">{runId}</dd></div>
            <div><dt className="text-muted-foreground">Target</dt><dd>huggingface</dd></div>
            <div><dt className="text-muted-foreground">Destination</dt><dd>{confirmation.destination}</dd></div>
            <div><dt className="text-muted-foreground">{t("buildPublish.visibility")}</dt><dd>{confirmation.options?.private === false ? "Public" : "Private"}</dd></div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">{t("buildPublish.confirmNote")}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button loading={publish.status === "publishing"} disabled={!builderReady || Boolean(validatePublishDestination(confirmation.destination))} onClick={() => void publish.start(runId, confirmation)}>{t("buildPublish.publishNow")}</Button>
            {publish.status !== "publishing" ? <Button variant="secondary" onClick={() => setConfirmation(undefined)}>{t("buildPublish.editSettings")}</Button> : <Button variant="secondary" onClick={publish.stopWaiting}>{t("buildPublish.stopWaiting")}</Button>}
          </div>
        </Card>
      )}

      {publish.status === "published" && publish.result ? (
        <Card variant="success" role="status">
          <div className="flex items-center gap-2"><StatusBadge status="published" /><strong>{t("buildPublish.publishedTitle")}</strong></div>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Run ID</dt><dd className="font-mono">{publish.result.run_id}</dd></div>
            <div><dt className="text-muted-foreground">Destination</dt><dd>{publish.result.destination}</dd></div>
            <div><dt className="text-muted-foreground">Publisher</dt><dd>{publish.result.publisher}</dd></div>
            <div><dt className="text-muted-foreground">Artifacts</dt><dd>{publish.result.artifact_count}</dd></div>
          </dl>
          <div className="mt-4 break-all text-sm">Reference: {isSafePublishReference(publish.result.reference) ? <a href={publish.result.reference} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300">{publish.result.reference}</a> : <span>{publish.result.reference}</span>}</div>
        </Card>
      ) : null}
      {publish.status === "failed" ? <Card variant="error" role="alert"><strong>{t("buildPublish.publishFailed")}</strong><p className="mt-2 text-sm">{publish.failure?.message}</p>{publish.failure?.kind === "publish_state_unknown" ? <p className="mt-2 text-xs">{t("buildPublish.noAutoRetry")}</p> : null}</Card> : null}
      {publish.status === "aborted" ? <Card role="status"><strong>{t("buildPublish.abortedTitle")}</strong><p className="mt-2 text-sm text-muted-foreground">{t("buildPublish.abortedBody")}</p></Card> : null}
    </main>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: PublishReadinessResponse["blockers"]; tone: "error" | "warning" }) {
  return <div><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3><ul className="mt-2 space-y-2">{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={`rounded-lg px-3 py-2 text-sm ${tone === "error" ? "bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200" : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"}`}><span className="font-mono text-xs">{issue.code}</span><span className="ml-2">{issue.message}</span></li>)}</ul></div>;
}
