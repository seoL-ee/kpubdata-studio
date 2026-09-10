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

const BUILD_STATUS_LABEL: Record<BuildRunStatus, string> = {
  queued: "대기 중",
  running: "실행 중",
  cancelling: "취소 중",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

const inputClassName =
  "h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function BuildPublishPage() {
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
      setRunContext({ status: "error", message: "게시할 Run ID가 없습니다." });
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
          message: cause instanceof Error ? cause.message : "이 Run의 정보를 확인할 수 없습니다.",
        });
      });
    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setReadiness({ status: "error", message: "게시할 Run ID가 없습니다." });
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
          setReadiness({ status: "error", message: "Builder readiness 응답이 선택한 Run과 일치하지 않습니다." });
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
      ? "확인 중…"
      : runCtx
        ? runCtx.status === "succeeded"
          ? runCtx.finishedAt
            ? `완료 · ${formatDateTime(runCtx.finishedAt)}`
            : "완료"
          : `${BUILD_STATUS_LABEL[runCtx.status]}${runCtx.finishedAt ? ` · ${formatDateTime(runCtx.finishedAt)}` : ""}`
        : "확인되지 않음";

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
        eyebrow="게시"
        title={`${datasetLabel || runId || "Run"} 게시`}
        description="Builder가 선택한 Run의 준비 상태를 확인한 뒤 Hugging Face에 게시합니다."
      />

      <Card>
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">선택한 Run</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Dataset</dt><dd>{datasetLabel || (runContext.status === "loading" ? "확인 중…" : "확인되지 않음")}</dd></div>
          <div><dt className="text-muted-foreground">Run ID</dt><dd className="break-all font-mono">{runId || "—"}</dd></div>
          <div><dt className="text-muted-foreground">Build 완료</dt><dd>{buildCompletionText}</dd></div>
          <div><dt className="text-muted-foreground">Target</dt><dd>Hugging Face</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">이 화면은 URL의 exact Run ID로 Dataset과 Build 완료 상태를 확인하며, latest Run으로 바꾸지 않습니다.</p>
        {runContext.status === "error" ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">이 Run의 Dataset 정보를 불러오지 못했습니다. Run ID로 게시 준비 상태는 아래에서 계속 확인할 수 있습니다.</p>
        ) : null}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold">Builder readiness</h2><p className="mt-1 text-xs text-muted-foreground">Run·Gold·license·PII policy·서버 credential을 Builder가 판정합니다.</p></div>
          <Button variant="secondary" size="sm" disabled={readiness.status === "loading" || publish.status === "publishing"} onClick={() => setReadinessVersion((value) => value + 1)}>다시 확인</Button>
        </div>
        {readiness.status === "loading" ? <Skeleton className="mt-4 h-20 w-full" /> : null}
        {readiness.status === "error" ? <div className="mt-4" role="alert"><p className="text-sm text-red-700 dark:text-red-300">{readiness.message}</p></div> : null}
        {readiness.status === "loaded" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm font-medium">
              {builderReady
                ? "Builder 게시 준비 완료"
                : readiness.data.blockers.length > 0
                  ? "Builder blocker가 있어 게시할 수 없습니다."
                  // ready: false인데 blockers가 비어 있으면("빈 카드") "blocker가 있다"고
                  // 잘못 단정하지 않는다 — Builder가 사유를 제공하지 않은 것과 실제 blocker가
                  // 있는 것은 다른 상태다(UI audit #4).
                  : "Builder가 이 Run을 게시 준비되지 않음으로 판정했지만 구체적인 사유(blocker)를 제공하지 않았습니다."}
            </p>
            {readiness.data.blockers.length > 0 ? <IssueList title="Blockers" issues={readiness.data.blockers} tone="error" /> : null}
            {readiness.data.warnings.length > 0 ? <IssueList title="Warnings" issues={readiness.data.warnings} tone="warning" /> : null}
            {readiness.data.blockers.some((issue) => issue.code === "credential_unavailable") ? <p className="text-xs text-muted-foreground">이 blocker는 source Provider credential이 아니라 Builder 서버의 Hugging Face publish credential을 뜻합니다. Studio는 token을 입력하거나 저장하지 않습니다.</p> : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">게시 설정</h2>
        <p className="mt-1 text-xs text-muted-foreground">Readiness와 별개인 로컬 입력 검증입니다. Builder readiness는 destination이나 공개 설정을 검증하지 않습니다.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <label className="text-sm font-medium">Hugging Face destination
            <input aria-label="Hugging Face destination" className={`mt-2 ${inputClassName}`} placeholder="owner/dataset" value={destination} disabled={publish.status === "publishing"} onChange={(event) => updateDestination(event.target.value)} />
            <span className={`mt-1 block text-xs ${destinationError ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>{destinationError ?? "Builder가 허용하는 owner/dataset 식별자"}</span>
          </label>
          <label className="flex items-center gap-3 self-center rounded-lg border border-border p-4 text-sm">
            <input aria-label="비공개 Dataset" type="checkbox" checked={isPrivate} disabled={publish.status === "publishing"} onChange={(event) => updatePrivate(event.target.checked)} className="h-4 w-4 accent-emerald-600" />
            <span><strong className="block">비공개 Dataset</strong><span className="text-xs text-muted-foreground">기본값: 비공개</span></span>
          </label>
        </div>
      </Card>

      {!confirmation ? (
        <Button className="self-start" disabled={!canReview} onClick={() => setConfirmation(request)}>최종 확인</Button>
      ) : (
        <Card className="border-emerald-300 dark:border-emerald-900" aria-label="게시 최종 확인">
          <h2 className="text-sm font-semibold">게시 최종 확인</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Run ID</dt><dd className="font-mono">{runId}</dd></div>
            <div><dt className="text-muted-foreground">Target</dt><dd>huggingface</dd></div>
            <div><dt className="text-muted-foreground">Destination</dt><dd>{confirmation.destination}</dd></div>
            <div><dt className="text-muted-foreground">공개 설정</dt><dd>{confirmation.options?.private === false ? "Public" : "Private"}</dd></div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">Builder의 POST 응답이 성공하기 전에는 게시 완료로 표시하지 않습니다.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button loading={publish.status === "publishing"} disabled={!builderReady || Boolean(validatePublishDestination(confirmation.destination))} onClick={() => void publish.start(runId, confirmation)}>게시 실행</Button>
            {publish.status !== "publishing" ? <Button variant="secondary" onClick={() => setConfirmation(undefined)}>설정 수정</Button> : <Button variant="secondary" onClick={publish.stopWaiting}>응답 기다리기 중단</Button>}
          </div>
        </Card>
      )}

      {publish.status === "published" && publish.result ? (
        <Card variant="success" role="status">
          <div className="flex items-center gap-2"><StatusBadge status="published" /><strong>Builder 게시 완료</strong></div>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Run ID</dt><dd className="font-mono">{publish.result.run_id}</dd></div>
            <div><dt className="text-muted-foreground">Destination</dt><dd>{publish.result.destination}</dd></div>
            <div><dt className="text-muted-foreground">Publisher</dt><dd>{publish.result.publisher}</dd></div>
            <div><dt className="text-muted-foreground">Artifacts</dt><dd>{publish.result.artifact_count}</dd></div>
          </dl>
          <div className="mt-4 break-all text-sm">Reference: {isSafePublishReference(publish.result.reference) ? <a href={publish.result.reference} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300">{publish.result.reference}</a> : <span>{publish.result.reference}</span>}</div>
        </Card>
      ) : null}
      {publish.status === "failed" ? <Card variant="error" role="alert"><strong>게시 실패</strong><p className="mt-2 text-sm">{publish.failure?.message}</p>{publish.failure?.kind === "publish_state_unknown" ? <p className="mt-2 text-xs">자동 재시도하지 마세요.</p> : null}</Card> : null}
      {publish.status === "aborted" ? <Card role="status"><strong>응답 대기를 중단했습니다.</strong><p className="mt-2 text-sm text-muted-foreground">브라우저 요청만 중단했으며 원격 게시 작업을 취소한 것은 아닙니다. 게시 결과는 확인되지 않았습니다.</p></Card> : null}
    </main>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: PublishReadinessResponse["blockers"]; tone: "error" | "warning" }) {
  return <div><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3><ul className="mt-2 space-y-2">{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={`rounded-lg px-3 py-2 text-sm ${tone === "error" ? "bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200" : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"}`}><span className="font-mono text-xs">{issue.code}</span><span className="ml-2">{issue.message}</span></li>)}</ul></div>;
}
