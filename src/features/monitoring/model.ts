/**
 * Monitoring 도메인 공용 모델 (#264, #303).
 *
 * 페이지와 탭 컴포넌트가 공유하는 상태 어휘와 순수 헬퍼. wire 스키마 타입은
 * `@/shared/lib/builderApi.schema`가 정본이다.
 */
import { i18n } from "@/shared/i18n";
import type {
  MonitoringRecentRun,
  MonitoringSummaryResponse,
  MonitoringBuildsResponse,
} from "@/shared/lib/builderApi.schema";

export type MonitoringTab = "system" | "builds" | "recent-runs";

export type MonitoringLoadingState = "idle" | "loading" | "success" | "error";

/** /monitoring/summary + /monitoring/builds 병렬 조회 결과를 묶은 화면 모델 (#302). */
export interface MonitoringData {
  summary: MonitoringSummaryResponse;
  builds: MonitoringBuildsResponse;
}

/** BuildIndex 내부 상태 값(ok/failed/cancelled 등)을 표시 라벨로 매핑한다. */
export function runStatusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case "ok":
    case "succeeded":
      return {
        label: i18n.t("monitoring.runStatus.succeeded"),
        className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
      };
    case "failed":
      return {
        label: i18n.t("monitoring.runStatus.failed"),
        className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
      };
    case "running":
      return {
        label: i18n.t("monitoring.runStatus.running"),
        className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
      };
    case "cancelled":
      return {
        label: i18n.t("monitoring.runStatus.cancelled"),
        className: "bg-muted text-muted-foreground",
      };
    case "queued":
      return {
        label: i18n.t("monitoring.runStatus.queued"),
        className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
      };
    default:
      return { label: status, className: "bg-muted text-muted-foreground" };
  }
}

/** started/finished 타임스탬프로 소요 시간(초)을 계산한다 — builder는 duration을 내려주지 않는다. */
export function runDurationSeconds(run: MonitoringRecentRun): number | null {
  if (run.started_at === null || run.finished_at === null) return null;
  const duration =
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null;
}
