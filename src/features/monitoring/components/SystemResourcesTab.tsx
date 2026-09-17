/**
 * System Resources 탭 (#264, #303) — Builder API/Queue/Workers/Artifact Store 카드.
 * 측정값 null은 0이 아니라 "—"로 표시한다(#516/#302 원칙).
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { Card, Skeleton } from "@/shared/ui";
import type {
  MonitoringApiStatus,
  MonitoringArtifactStoreStats,
  MonitoringQueueStats,
  MonitoringSummaryResponse,
  MonitoringWorkerStats,
} from "@/shared/lib/builderApi.schema";
import type { MonitoringLoadingState } from "@/features/monitoring/model";

function measured(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function SystemResourcesTab({
  loading,
  summary,
}: {
  loading: MonitoringLoadingState;
  summary: MonitoringSummaryResponse | undefined;
}) {
  const { t } = useTranslation();
  if (loading === "error") {
    return (
      <Card variant="error">
        <p className="font-semibold">{t("monitoring.error.title")}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t("monitoring.error.retry")}</p>
      </Card>
    );
  }

  if (loading === "loading" || !summary) {
    return <SystemResourcesSkeleton />;
  }

  return (
    <div className="space-y-6">
      <SystemHealthCard status={summary.status} api={summary.api} />

      <div className="grid gap-6 lg:grid-cols-2">
        <QueueStatsCard stats={summary.queue} />
        <WorkerStatsCard stats={summary.workers} />
      </div>

      <ArtifactStoreCard stats={summary.artifact_store} />
    </div>
  );
}

function SystemHealthCard({
  status,
  api,
}: {
  status: MonitoringSummaryResponse["status"];
  api: MonitoringApiStatus;
}) {
  const { t } = useTranslation();
  // aggregate는 healthy/degraded 2값이고, api 자체 측정 불가는 availability가 알려준다.
  const statusLabel =
    api.availability === "unavailable"
      ? t("monitoring.api.unavailable")
      : status === "degraded"
      ? t("monitoring.api.degraded")
      : t("monitoring.api.healthy");

  const statusColor =
    api.availability === "unavailable" || status === "degraded"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
      : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300";

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Builder API</h3>
          <div className="mt-2 flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor}`}>
              {statusLabel}
            </span>
            <span className="text-sm text-muted-foreground">
              {api.p95_latency_ms !== null
                ? `P95 Latency: ${api.p95_latency_ms}ms`
                : t("monitoring.api.latencyUnavailable")}
            </span>
            {api.sample_count === null && (
              <span className="text-sm text-muted-foreground">{t("monitoring.api.noSamples")}</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function QueueStatsCard({ stats }: { stats: MonitoringQueueStats }) {
  const { t } = useTranslation();
  return (
    <Card>
      <h3 className="text-lg font-semibold">Queue</h3>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {stats.availability === "unavailable"
            ? t("monitoring.measure.unavailable")
            : t("monitoring.measure.measuring")}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("monitoring.queue.waiting")}</span>
          <span className="text-lg font-semibold">{measured(stats.waiting)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("monitoring.queue.running")}</span>
          <span className="text-lg font-semibold">{measured(stats.running)}</span>
        </div>
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("monitoring.queue.total")}</span>
            <span className="text-xl font-bold">{measured(stats.total)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function WorkerStatsCard({ stats }: { stats: MonitoringWorkerStats }) {
  const { t } = useTranslation();
  const utilizationPercent = Math.round(stats.utilization * 100);

  return (
    <Card>
      <h3 className="text-lg font-semibold">Workers</h3>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {stats.availability === "unavailable"
            ? t("monitoring.measure.unavailable")
            : t("monitoring.measure.measuring")}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("monitoring.workers.active")}</span>
          <span className="text-lg font-semibold">{stats.active}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("monitoring.workers.capacity")}</span>
          <span className="text-lg font-semibold">{stats.capacity}</span>
        </div>
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("monitoring.workers.utilization")}</span>
            <span className="text-xl font-bold">{utilizationPercent}%</span>
          </div>
          <div className="mt-2 h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-accent transition-all"
              style={{ width: `${utilizationPercent}%` }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function ArtifactStoreCard({ stats }: { stats: MonitoringArtifactStoreStats }) {
  const { t } = useTranslation();
  const statusLabel =
    stats.availability === "available"
      ? t("monitoring.store.available")
      : stats.availability === "partial"
      ? t("monitoring.store.partial")
      : t("monitoring.store.unavailable");

  const statusColor =
    stats.availability === "available"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
      : stats.availability === "partial"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
      : "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300";

  return (
    <Card>
      <h3 className="text-lg font-semibold">Artifact Store</h3>
      <div className="mt-2 flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor}`}>
          {statusLabel}
        </span>
        <span className="text-sm text-muted-foreground">
          {stats.last_write_at
            ? t("monitoring.store.lastWrite", {
                at: new Date(stats.last_write_at).toLocaleString(
                  i18n.language?.startsWith("en") ? "en-US" : "ko-KR",
                ),
              })
            : t("monitoring.store.lastWriteNone")}
        </span>
      </div>
    </Card>
  );
}

function SystemResourcesSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <Skeleton className="h-6 w-32" />
        <div className="mt-4 flex items-center gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Skeleton className="h-6 w-16" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </Card>
        <Card>
          <Skeleton className="h-6 w-16" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </Card>
      </div>
      <Card>
        <Skeleton className="h-6 w-32" />
        <div className="mt-2">
          <Skeleton className="h-5 w-48" />
        </div>
      </Card>
    </div>
  );
}
