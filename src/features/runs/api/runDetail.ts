/**
 * Builds/Runs master-detail(#255) 상세 패널 전용 API: BuildSpec snapshot(#487)과
 * structured run events(#496).
 *
 * Builder main OpenAPI에 두 엔드포인트 모두 실제로 존재함을 확인했다
 * (`GET /builds/{run_id}/spec`, `GET /builds/{run_id}/events`). mock 모드는 이 두
 * 표면에 대응하는 결정적 fixture가 없으므로, 있는 척 지어내는 대신 명시적으로
 * "mock 모드에서는 지원되지 않음"을 던져 실연동 모드로 전환해야 함을 드러낸다.
 */
import { i18n } from "@/shared/i18n";
import {
  ApiError,
  builderApi,
  isRealBuilderEnabled,
  type BuildEventsResponse,
  type BuildSpecSnapshotResponse,
} from "@/shared/lib/builderApi";

export class MockUnsupportedError extends Error {
  readonly mockUnsupported = true as const;
  constructor(message: string) {
    super(message);
    this.name = "MockUnsupportedError";
  }
}

/** GET /builds/{run_id}/spec — 실행에 사용한 canonical BuildSpec snapshot(#487). */
export async function getBuildSpecSnapshot(
  runId: string,
  signal?: AbortSignal,
): Promise<BuildSpecSnapshotResponse> {
  if (!isRealBuilderEnabled()) {
    throw new MockUnsupportedError(
      i18n.t("runs.mock.noSpecSnapshot"),
    );
  }
  return builderApi.getBuildSpecSnapshot(runId, signal);
}

/** GET /builds/{run_id}/events — structured run event timeline(#496). */
export async function getBuildEvents(
  runId: string,
  options?: { limit?: number; tail?: boolean },
  signal?: AbortSignal,
): Promise<BuildEventsResponse> {
  if (!isRealBuilderEnabled()) {
    throw new MockUnsupportedError(
      i18n.t("runs.mock.noRunEvents"),
    );
  }
  return builderApi.getBuildEvents(runId, options, signal);
}

/** BuildSpec snapshot이 legacy run이라 없는 경우(404)를 구분하기 위한 헬퍼. */
export function isSnapshotUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}
