/**
 * Builder 조회 표면 하나의 상태와 그 로더 (#379).
 *
 * Builds 화면은 Quality/Artifact/BuildSpec snapshot 등 표면마다 독립된 상태를 들고
 * 하나가 실패해도 나머지를 계속 보여준다(#255 §8/§13) — 그 단위가 이 타입이다.
 */
import { useEffect, useState } from "react";

import { classifyRunApiError } from "@/features/runs/model";

export type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "error"; error: string; notFound?: boolean; permissionDenied?: boolean };

export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  errorMessage: string,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "loaded", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const kind = classifyRunApiError(cause);
        setState({
          status: "error",
          error: cause instanceof Error ? cause.message : errorMessage,
          notFound: kind === "not_found",
          permissionDenied: kind === "permission_denied",
        });
      });
    return () => controller.abort();
  }, deps);

  return state;
}
