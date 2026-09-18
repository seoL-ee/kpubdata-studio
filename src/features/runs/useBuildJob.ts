/**
 * 빌드 실행을 비동기 job으로 관리하는 훅 (#39).
 *
 * idle → running → succeeded/failed/cancelled 상태 머신과 취소(AbortController)를
 * 제공한다. 실연동 모드에서는 Builder 비동기 job 표면(POST /builds + GET
 * /builds/{run_id} 폴링, builder #480/#482)을 사용하고, 폴링 중인 잡의 wire
 * 상태(queued/running/...)를 builderStatus로 노출한다(#245).
 */
import { i18n } from "@/shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { executeBuild, type BuildExecutionHandle, type BuilderJobStatus } from "@/features/runs/api";
import { ApiError, builderApi, extractErrorMessage } from "@/shared/lib/builderApi";
import type { BuildRun, BuildRunStatus, BuildSpec } from "@/shared/lib/types";

/**
 * executeBuild가 돌려준 terminal BuildRun.status(succeeded/failed/cancelled)를 hook
 * 상태로 옮긴다. cancelled를 failed로 붕괴시키지 않는다(#S04).
 */
function toJobStatus(runStatus: BuildRunStatus): BuildJobStatus {
  if (runStatus === "succeeded") return "succeeded";
  if (runStatus === "cancelled") return "cancelled";
  return "failed";
}

export type BuildJobStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface BuildJob {
  /** 현재 job 상태 */
  status: BuildJobStatus;
  /** Builder 잡의 최신 wire 상태(queued/running/cancelling — 실연동 폴링 중) */
  builderStatus?: BuilderJobStatus;
  /** 완료된 실행 결과(성공/실패 시) */
  run?: BuildRun;
  /** 실패 시 오류 메시지 */
  error?: string;
  /**
   * 사용자가 진행 중인 요청을 클라이언트에서 중단했음을 나타내는 local-only 표식.
   *
   * sync `POST /build`(file source, ADR 0014)는 server-side 협조적 취소 경로가 없어,
   * fetch abort는 Builder 실행을 멈추지 않는다 — 서버에서는 빌드가 계속 성공/실패할 수
   * 있다. 그래서 이 경우 status를 canonical `cancelled`로 확정하지 않고, "요청 중단"이라는
   * 클라이언트 관점 사실만 이 플래그로 노출한다. wire/canonical BuildRun status는 아니다.
   */
  interrupted: boolean;
  /** 빌드 실행을 시작한다. */
  start: (spec: BuildSpec) => Promise<void>;
  /** 진행 중인 실행을 취소한다. */
  cancel: () => void;
}

/**
 * 빌드 실행 job 상태와 제어(start/cancel)를 제공하는 훅.
 *
 * @returns BuildJob 상태와 제어 함수.
 */
export function useBuildJob(): BuildJob {
  const [status, setStatus] = useState<BuildJobStatus>("idle");
  const [builderStatus, setBuilderStatus] = useState<BuilderJobStatus>();
  const [run, setRun] = useState<BuildRun>();
  const [error, setError] = useState<string>();
  const [interrupted, setInterrupted] = useState(false);
  // 언마운트/재시작(lifecycle) 취소 전용 컨트롤러. 사용자 "취소"와는 의미가 다르다.
  const controllerRef = useRef<AbortController | null>(null);
  // 진행 중인 실행이 어떤 Builder 표면(sync/async)을 타는지와 그 run_id. 사용자 취소가
  // async job에 대해 POST /builds/{run_id}/cancel을 호출할 수 있게 한다.
  const handleRef = useRef<BuildExecutionHandle | null>(null);
  // async submit이 아직 진행 중일 때(= handle 미노출) 눌린 Cancel의 intent. abort하지
  // 않고 보관했다가, authoritative run_id가 담긴 handle이 오면 정확히 1회 반영한다(F03).
  const pendingCancelRef = useRef(false);
  // 이 실행에 대해 async 협조적 취소를 이미 1회 쐈는지(반복 early Cancel coalesce).
  const cancelIssuedRef = useRef(false);

  // async job에 대한 협조적 취소를 정확히 1회 요청한다. polling은 끊지 않는다 —
  // Builder terminal status가 최종 정답이고, cancel 요청 실패도 local cancelled로
  // 바꾸지 않는다(#S03).
  const issueAsyncCancel = useCallback((runId: string) => {
    if (cancelIssuedRef.current) return;
    cancelIssuedRef.current = true;
    void builderApi.cancelBuildJob(runId).catch(() => {});
  }, []);

  const start = useCallback(async (spec: BuildSpec) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    handleRef.current = null;
    pendingCancelRef.current = false;
    cancelIssuedRef.current = false;
    setStatus("running");
    setBuilderStatus(undefined);
    setError(undefined);
    setRun(undefined);
    setInterrupted(false);
    try {
      const result = await executeBuild(
        spec,
        controller.signal,
        (jobStatus) => {
          if (!controller.signal.aborted) setBuilderStatus(jobStatus);
        },
        (handle) => {
          handleRef.current = handle;
          // submit 이전에 Cancel이 눌려 있었다면, authoritative run_id가 확보된 지금
          // 정확히 1회 협조적 취소를 건다(F03).
          if (handle.mode === "async" && pendingCancelRef.current) {
            issueAsyncCancel(handle.runId);
          }
        },
      );
      if (controller.signal.aborted) return;
      setRun(result);
      // succeeded/failed/cancelled를 그대로 보존한다 — cancelled를 failed로 덮지 않는다(#S04).
      setStatus(toJobStatus(result.status));
      if (result.status === "failed") setError(result.error ?? i18n.t("runs.build.someSourcesFailed"));
    } catch (cause) {
      if (controller.signal.aborted) {
        // AbortController.abort()는 (a) sync build의 사용자 취소, (b) 언마운트
        // lifecycle cleanup에서만 온다(async 취소는 컨트롤러를 abort하지 않는다).
        // 어느 쪽이든 fetch abort는 Builder server-side 실행 결과를 알 수 없으므로
        // succeeded/failed/cancelled 어느 terminal도 확정하지 않는다 — running에서만
        // 벗어난다. "요청 중단" 사실은 cancel()이 setInterrupted(true)로 이미 남겼다.
        setStatus((current) => (current === "running" ? "idle" : current));
        return;
      }
      setStatus("failed");
      // /build 502는 최상위 error 없이 outcomes[].error로 실패 사유를 돌려준다.
      // 우선순위: 최상위 error(하위 호환) → outcomes[].error → ApiError 메시지 → 일반 메시지.
      const message =
        cause instanceof ApiError
          ? (extractErrorMessage(cause.details) ?? cause.message)
          : i18n.t("runs.build.runFailed");
      setError(message);
    } finally {
      // 실행이 끝나면(성공/실패/취소) 더 이상 유효하지 않은 컨트롤러 참조를 정리한다.
      if (controllerRef.current === controller) controllerRef.current = null;
      handleRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const handle = handleRef.current;
    if (handle?.mode === "async") {
      // 실제 Builder에 협조적 취소를 요청하고 polling은 그대로 둔다 — "취소된 척"
      // 하며 polling을 끊지 않고, Builder가 cancelling → cancelled terminal에 도달하는
      // 것을 관찰해 최종 상태(result.status)로 판정한다(#S03). 이미 terminal이거나
      // 네트워크 오류면 polling 결과가 authoritative하므로 issueAsyncCancel이 삼킨다 —
      // cancel 요청 실패를 local `cancelled`로 바꾸지 않는다. 반복 호출은 1회로 coalesce된다.
      issueAsyncCancel(handle.runId);
      return;
    }
    if (handle?.mode === "sync") {
      // sync `POST /build`(file source, ADR 0014): server-side 협조적 취소 경로가 없다.
      // fetch abort는 클라이언트 요청만 중단할 뿐 Builder 실행을 취소하지 않으므로,
      // 성공/실패/취소 중 무엇도 확정하지 않고 "요청을 클라이언트에서 중단했다"는
      // 사실만 남긴다(#S04, 기존 동작 유지).
      controllerRef.current?.abort();
      setInterrupted(true);
      return;
    }
    // 아직 handle이 없다 = async POST /builds 제출이 진행 중이다. 여기서 fetch를
    // abort하면 서버가 이미 submit을 받았는지 알 수 없어 orphan build가 생길 수 있다.
    // 그래서 abort하지 않고 "cancel 요청됨" intent만 기록한다 — submit이 성공해
    // authoritative run_id가 담긴 handle이 오면 그때 정확히 1회 협조적 취소를 건다(F03).
    // 반복해서 눌러도 boolean이라 1회로 coalesce된다.
    pendingCancelRef.current = true;
  }, [issueAsyncCancel]);

  // 언마운트 시 진행 중인 실행을 중단해 unmount 이후 setState를 방지한다(#73).
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { status, builderStatus, run, error, interrupted, start, cancel };
}
