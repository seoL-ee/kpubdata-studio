/**
 * Recent Runs 탭 (#264, #303) — 최근 빌드 실행 이력과 Builds 상세 링크.
 */
import { useTranslation } from "react-i18next";
import { Card, EmptyState, Skeleton, LinkButton } from "@/shared/ui";
import type { MonitoringRecentRun } from "@/shared/lib/builderApi.schema";
import {
  runDurationSeconds,
  runStatusLabel,
  type MonitoringLoadingState,
} from "@/features/monitoring/model";

export function RecentRunsTab({
  loading,
  runs,
}: {
  loading: MonitoringLoadingState;
  runs: MonitoringRecentRun[] | undefined;
}) {
  const { t } = useTranslation();
  if (loading === "error") {
    return (
      <Card variant="error">
        <p className="font-semibold">{t("monitoring.recent.errorTitle")}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("monitoring.recent.errorRetry")}
        </p>
      </Card>
    );
  }

  if (loading === "loading" || runs === undefined) {
    return <RecentRunsSkeleton />;
  }

  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          title={t("monitoring.recent.emptyTitle")}
          description={t("monitoring.recent.emptyDesc")}
          actionLabel={t("monitoring.recent.emptyCta")}
          actionHref="/builds/new"
        />
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <div className="p-6 border-b border-border">
        <h3 className="text-lg font-semibold">{t("monitoring.recent.title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("monitoring.recent.desc")}
        </p>
      </div>
      <ul>
        {runs.map((run) => {
          const status = runStatusLabel(run.status);
          const duration = runDurationSeconds(run);
          return (
            <li
              key={run.run_id}
              className="grid grid-cols-[1fr_0.8fr_0.8fr_0.6fr_0.6fr] items-center gap-4 border-b border-border px-6 py-4 text-sm last:border-0 hover:bg-muted/50 transition-colors"
            >
              <div>
                <span className="font-medium">{run.run_id}</span>
              </div>
              <div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                >
                  {status.label}
                </span>
              </div>
              <div className="text-muted-foreground">
                {run.started_at ? new Date(run.started_at).toLocaleString("ko-KR") : "—"}
              </div>
              <div className="text-muted-foreground">
                {duration !== null ? t("monitoring.recent.seconds", { seconds: duration }) : "—"}
              </div>
              <div className="text-right">
                <LinkButton variant="secondary" size="sm" to={`/builds/${run.run_id}`}>
                  {t("monitoring.recent.view")}
                </LinkButton>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RecentRunsSkeleton() {
  return (
    <Card className="p-0">
      <div className="p-6 border-b border-border">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-1 h-4 w-64" />
      </div>
      <div className="p-4 space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_0.8fr_0.8fr_0.6fr_0.6fr] items-center gap-4 py-3"
          >
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-8 w-12 ml-auto" />
          </div>
        ))}
      </div>
    </Card>
  );
}
