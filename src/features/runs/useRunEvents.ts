/**
 * 선택된 Run의 structured event timeline(#496 evidence)을 조회·polling하는 훅 (#255 P1).
 *
 * `useSelectedRunPolling`과 동일한 visibility-aware polling primitive를 공유한다(#255 §3) —
 * 새 scheduler를 만들지 않는다. Event 조회 실패는 Run/Stage/Quality/BuildSpec snapshot
 * 화면을 죽이지 않도록 완전히 독립된 상태로 관리한다(#255 §1).
 *
 * mock 모드에서는 `getBuildEvents`가 `MockUnsupportedError`를 던진다 — 이것은 "네트워크
 * 오류"가 아니라 "이 표면은 mock에서 지원하지 않음"이라는 별도 신호이므로 `mockUnsupported`
 * 플래그로 구분해서 노출한다(있는 척 데이터를 지어내지 않는다).
 */
import { i18n } from "@/shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBuildEvents, MockUnsupportedError } from "@/features/runs/api/runDetail";
import { classifyRunApiError } from "@/features/runs/model";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";
import type { BuildEventsResponse } from "@/shared/lib/builderApi";

/** Run status polling(#245, 800ms)보다 느슨한 간격 — event timeline은 status보다 자주 바뀌지 않는다. */
export const RUN_EVENTS_POLL_INTERVAL_MS = 3000;

/** 한 번에 가져올 최근 event 수. tail=true라 항상 최신 N개를 chronological ascending으로 받는다(#496 계약). */
export const RUN_EVENTS_LIMIT = 200;

export type RunEventsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: BuildEventsResponse }
  | {
      status: "error";
      error: string;
      notFound?: boolean;
      permissionDenied?: boolean;
      /** mock 모드라 이 표면 자체를 지원하지 않는 경우(네트워크/서버 오류와 구분). */
      mockUnsupported?: boolean;
    };

/**
 * @param runId - 지켜볼 run id. null이면 조회하지 않는다.
 * @param pollingEnabled - non-terminal Run일 때만 true로 넘긴다 — terminal이면 polling을 멈춘다.
 */
export function useRunEvents(runId: string | null, pollingEnabled: boolean): RunEventsState {
  const [state, setState] = useState<RunEventsState>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    if (!runId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await getBuildEvents(runId, { limit: RUN_EVENTS_LIMIT, tail: true }, controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: "loaded", data });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const mockUnsupported = cause instanceof MockUnsupportedError;
      const kind = classifyRunApiError(cause);
      setState({
        status: "error",
        error: cause instanceof Error ? cause.message : i18n.t("runs.errors.eventsFailed"),
        notFound: kind === "not_found",
        permissionDenied: kind === "permission_denied",
        mockUnsupported,
      });
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      controllerRef.current?.abort();
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    void fetchNow();
    return () => {
      controllerRef.current?.abort();
    };
    // fetchNow는 runId에서만 파생되므로(useCallback deps: [runId]) runId만으로 충분하다.
  }, [runId]);

  useVisibilityAwarePolling(
    () => void fetchNow(),
    RUN_EVENTS_POLL_INTERVAL_MS,
    Boolean(runId) && pollingEnabled,
  );

  return state;
}
