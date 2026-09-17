/**
 * 빌드 실행(run) API 진입점.
 *
 * 실연동 모드(`VITE_USE_REAL_BUILDER=true`)면 Builder `/build`를 호출하고, 아니면
 * 결정적 mock 실행 결과를 반환한다. Builder의 /build는 현재 동기식이므로 비동기 job
 * 폴링은 Builder 측 job 엔드포인트가 생기면 확장한다(#39).
 */
import { i18n } from "@/shared/i18n";
import { saveBuildSpec } from "@/features/build-spec/specStore";
import { serializeSpec } from "@/features/build-spec/specMapping";
import { builderApi, isRealBuilderEnabled, type BuildSummary } from "@/shared/lib/builderApi";
import { DEMO_DATASETS, type DemoDataset } from "@/shared/lib/demoDatasets";
import type { BuildListItem, BuildRun, BuildRunStatus, BuildSpec } from "@/shared/lib/types";

const MOCK_TIME = "1970-01-01T00:00:00.000Z";

/**
 * BuildSpec으로부터 경로 안전한 run_id를 생성한다.
 *
 * Builder는 run_id를 산출물 디렉터리 이름으로 사용하므로 안전한 세그먼트
 * (영숫자/하이픈)만 남긴다. dataset id와 타임스탬프를 결합해 사람이 식별 가능하면서도
 * 충돌하지 않는 값을 만든다.
 */
export function generateRunId(datasetId: string): string {
  const slug = datasetId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = slug.length > 0 ? slug : "build";
  return `${base}-${Date.now()}`;
}

/**
 * 새 빌드 실행을 시작하고 실행 결과를 반환한다.
 *
 * @param spec - 실행할 빌드 스펙.
 * @param signal - 취소용 AbortSignal(선택).
 * @returns 생성된 빌드 실행 정보.
 */
/** Builder 잡 상태를 Studio 실행 상태로 매핑한다 (builder 1.16.0 #480). */
export type BuilderJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * 실행이 어떤 Builder 표면을 타는지(그리고 그 run_id)를 호출부(useBuildJob)에 알린다.
 *
 * - `async`: POST /builds + polling. 사용자 취소는 POST /builds/{run_id}/cancel로 전달해야 한다.
 * - `sync`: POST /build (file source, ADR 0014). server-side 협조적 취소 경로가 없다.
 */
export interface BuildExecutionHandle {
  runId: string;
  mode: "sync" | "async";
}

/**
 * BuildSpec에 file source가 하나라도 포함되면 true.
 *
 * ADR 0014: file source의 async build(POST /builds)는 현재 지원 범위 밖이다 — file이
 * 섞인 spec은 전체를 sync POST /build로 실행해야 한다. "첫 source만" 보지 않고 전체를 본다.
 */
export function specHasFileSource(spec: BuildSpec): boolean {
  return spec.sources.some((source) => source.kind === "file");
}

export async function executeBuild(
  spec: BuildSpec,
  signal?: AbortSignal,
  onJobStatus?: (status: BuilderJobStatus) => void,
  onHandle?: (handle: BuildExecutionHandle) => void,
): Promise<BuildRun> {
  if (!isRealBuilderEnabled()) {
    const mockRun: BuildRun = {
      id: "mock-run",
      spec,
      status: "succeeded",
      startedAt: MOCK_TIME,
      finishedAt: MOCK_TIME,
    };
    // mock 모드에서도 편집 흐름을 실제와 같은 경로로 검증할 수 있도록 스펙을 보관한다.
    saveBuildSpec(mockRun.id, spec);
    return mockRun;
  }

  // 실연동 모드에서는 실제 실행 시각을 기록한다(이력/상세 화면에서 잘못된 1970 값 방지).
  const runId = generateRunId(spec.datasetId);
  const startedAt = new Date().toISOString();

  // file source가 포함된 spec은 async(POST /builds)가 아니라 sync(POST /build)로
  // 실행한다(ADR 0014). public_api/url만 있으면 기존 async job 표면을 그대로 쓴다.
  let result: BuildRun;
  if (specHasFileSource(spec)) {
    onHandle?.({ runId, mode: "sync" });
    result = await runSyncBuild(spec, runId, startedAt, signal);
  } else {
    // async 표면에서는 POST /builds가 성공해 authoritative run_id를 확보한 **다음에만**
    // handle을 노출한다(F03). 그래야 submit-in-flight 구간의 Cancel이 아직 서버에
    // 존재하지 않는 run_id로 협조적 취소를 쏘는 race를 막을 수 있다.
    result = await runAsyncBuild(spec, runId, startedAt, signal, onJobStatus, onHandle);
  }

  // Builder는 spec을 영속화하지 않으므로(#120), 이후 편집 화면이 기존 스펙을 복원할 수
  // 있도록 Studio가 실행 시점의 스펙을 run_id에 묶어 보관한다. 저장 실패는 무시되며
  // 빌드 결과에는 영향을 주지 않는다.
  saveBuildSpec(result.id, spec);

  return result;
}

export const POLL_INTERVAL_MS = 800;

/** terminal(#245): 이 상태에 도달하면 더 이상 polling하지 않는다. */
export function isTerminalBuilderStatus(status: BuilderJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * 이미 조회한 `initialJob`에서 시작해 terminal 상태(succeeded/failed/cancelled)까지
 * `GET /builds/{run_id}`를 polling한다 (#245 polling state machine 재사용).
 *
 * 새로 제출한 build(runAsyncBuild)와, 이미 존재하는 run을 선택해 지켜보는 경우
 * (Builds/Runs master-detail, #255) 양쪽에서 이 하나의 loop을 공유한다 — 두 번째
 * polling state machine을 새로 만들지 않는다.
 */
export async function pollBuildJobUntilTerminal(
  runId: string,
  initialJob: Awaited<ReturnType<typeof builderApi.getBuildJob>>,
  signal: AbortSignal | undefined,
  onJobStatus?: (job: Awaited<ReturnType<typeof builderApi.getBuildJob>>) => void,
): Promise<Awaited<ReturnType<typeof builderApi.getBuildJob>>> {
  let job = initialJob;
  while (!isTerminalBuilderStatus(job.status)) {
    await sleep(POLL_INTERVAL_MS, signal);
    job = await builderApi.getBuildJob(runId, signal);
    onJobStatus?.(job);
  }
  return job;
}

async function runAsyncBuild(
  spec: BuildSpec,
  runId: string,
  startedAt: string,
  signal: AbortSignal | undefined,
  onJobStatus: ((status: BuilderJobStatus) => void) | undefined,
  onHandle: ((handle: BuildExecutionHandle) => void) | undefined,
): Promise<BuildRun> {
  const submitted = await builderApi.submitBuild(serializeSpec(spec), runId, signal);
  // 서버가 반환한 run_id가 정본이다. 이 시점부터만 협조적 취소(POST
  // /builds/{run_id}/cancel)를 걸 수 있다 — submit 이전 Cancel은 호출부가 pending
  // intent로 보관했다가 여기서 노출되는 handle을 통해 정확히 1회 반영한다(F03).
  onHandle?.({ runId: submitted.run_id, mode: "async" });
  onJobStatus?.(submitted.status);

  // 제출 직후 이미 terminal인 경우(동일 run_id 재제출 등) 폴링 없이 바로 판정한다.
  const job = await pollBuildJobUntilTerminal(submitted.run_id, submitted, signal, (polled) =>
    onJobStatus?.(polled.status),
  );

  const finishedAt = job.updated_at;
  // run_id는 서버 응답이 정본이다(제출값과 동일이지만 응답 기준으로 통일).
  const finalRunId = job.run_id;
  if (job.status === "cancelled") {
    return { id: finalRunId, spec, status: "cancelled", startedAt, finishedAt };
  }
  if (job.status === "failed") {
    return {
      id: finalRunId,
      spec,
      status: "failed",
      startedAt,
      finishedAt,
      error: job.error ?? i18n.t("runs.build.jobFailed"),
    };
  }
  const response = job.response;
  // 성공 잡의 최종 build 응답이 부분 실패(status: "failed", 502와 동일한 wire)일 수
  // 있다 — terminal failure와 partial-result를 구분하고, 사유 우선순위는 동기 /build
  // 502와 동일하게 최상위 error → outcomes[].error → 기본 문구(#75)를 따른다.
  if (response && response.status !== "ok") {
    const outcomeReason = response.outcomes.find((outcome) => outcome.error)?.error;
    const reason =
      response.error || outcomeReason || i18n.t("runs.build.someSourcesFailed");
    return {
      id: finalRunId,
      spec,
      status: "failed",
      startedAt,
      finishedAt,
      error: reason,
    };
  }
  return { id: finalRunId, spec, status: "succeeded", startedAt, finishedAt };
}

/**
 * file source가 포함된 spec을 동기 `POST /build`로 실행한다(ADR 0014).
 *
 * async job 표면(POST /builds + polling)을 타지 않으므로 job status 콜백/취소
 * endpoint는 관여하지 않는다. 성공/부분 실패 판정은 async 최종 build 응답과 동일한
 * 규칙(최상위 error → outcomes[].error → 기본 문구, #75)을 따라 UI가 async 결과와
 * 똑같이 소비할 수 있는 BuildRun을 돌려준다.
 */
async function runSyncBuild(
  spec: BuildSpec,
  runId: string,
  startedAt: string,
  signal: AbortSignal | undefined,
): Promise<BuildRun> {
  const response = await builderApi.build(serializeSpec(spec), runId, signal);
  const finishedAt = new Date().toISOString();
  const finalRunId = response.run_id || runId;

  if (response.status !== "ok") {
    const outcomeReason = response.outcomes.find((outcome) => outcome.error)?.error;
    const reason =
      ("error" in response && response.error) || outcomeReason || i18n.t("runs.build.someSourcesFailed");
    return { id: finalRunId, spec, status: "failed", startedAt, finishedAt, error: reason };
  }
  return { id: finalRunId, spec, status: "succeeded", startedAt, finishedAt };
}

/**
 * Builder `GET /builds`의 BuildSummary.status(canonical 어휘: ok/failed/cancelled)를
 * Studio BuildRunStatus로 매핑한다.
 *
 * 취소된 run은 `cancelled`로 오며 절대 failed로 붕괴시키지 않는다(#S04). Builder 어휘
 * 밖의 값은 조용히 성공으로 넘기지 않고 fail-closed(failed)로 둔다.
 */
function mapBuildSummaryStatus(status: BuildSummary["status"]): BuildRunStatus {
  switch (status) {
    case "ok":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

/** 데모 카탈로그 항목을 목록/이력 UI용 BuildSpec으로 변환한다. */
function mockSpec(dataset: DemoDataset): BuildSpec {
  return {
    datasetId: dataset.slug,
    title: dataset.title,
    description: dataset.description,
    sources: [
      {
        provider: "datago",
        dataset: dataset.providerDataset,
        params: dataset.params,
      },
    ],
    exports: dataset.exports,
    metadata: {
      source_url: dataset.sourceUrl,
      hf_repo: dataset.hfRepo,
    },
  };
}

/** mock 모드에서 보여줄 결정적 빌드 이력(실제 builder 데이터셋 스펙 기반). */
export function mockBuilds(): BuildRun[] {
  return DEMO_DATASETS.map((dataset) => ({
    id: dataset.buildId,
    spec: mockSpec(dataset),
    status: dataset.status,
    startedAt: dataset.startedAt,
    finishedAt: dataset.finishedAt,
  }));
}

/**
 * 빌드 실행 이력 목록을 조회한다 (#12, #95, #153).
 *
 * mock 모드(`VITE_USE_REAL_BUILDER` 미설정)에서는 이력 표/검색/정렬 UI를 개발·검증할 수
 * 있도록 결정적 mock 목록을 반환한다.
 *
 * 실연동 모드에서는 Builder `GET /builds`를 호출하고 응답을 BuildListItem[]으로 매핑한다(#153, builder #250).
 * Builder 응답에 spec/title이 없으므로 title은 null이 되고, UI는 run ID를 대신 표시한다.
 *
 * @param limit - 선택적 limit 파라미터. Builder의 기본값(50)을 사용하려면 생략한다.
 * @returns 빌드 실행 목록(mock 모드: 결정적 mock, 실연동 모드: Builder 응답 매핑).
 */
export async function listBuilds(limit?: number): Promise<BuildListItem[]> {
  if (!isRealBuilderEnabled()) {
    return mockBuilds().map((run) => ({
      id: run.id,
      title: run.spec.title,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    }));
  }

  const response = await builderApi.listBuilds(limit);
  return response.builds.map((summary) => ({
    id: summary.run_id,
    title: null, // Builder GET /builds는 title을 제공하지 않음
    status: mapBuildSummaryStatus(summary.status),
    startedAt: summary.started_at ?? null, // 누락 또는 null을 명시적 null로 정규화
    finishedAt: summary.finished_at ?? null, // 누락 또는 null을 명시적 null로 정규화
  }));
}

