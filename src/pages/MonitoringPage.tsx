/**
 * Monitoring 화면 (`/monitoring`) — 시스템 리소스·Build 통계 모니터링 (#264, #302, #303).
 *
 * 본 파일은 상태·polling·탭 조립만 담고 표시 컴포넌트는
 * `features/monitoring/components/*`로 분리했다(#303).
 *
 * Builder #516 실제 계약에 정합한다(#302):
 * - GET /monitoring/summary + GET /monitoring/builds?window=24h&bucket=hour 병렬 호출
 * - 실연동 모드에서 오류가 나면 mock으로 대체하지 않는다(정상 오인 방지).
 * - 401/403은 "권한 없음" 상태로 구분한다(ApiError.status 기반).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, PageHeader, Button, ErrorState } from "@/shared/ui";
import { ApiError, builderApi, isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type {
  MonitoringData,
  MonitoringLoadingState,
  MonitoringTab,
} from "@/features/monitoring/model";
import { getMockMonitoringData } from "@/features/monitoring/api/mockData";
import { SystemResourcesTab } from "@/features/monitoring/components/SystemResourcesTab";
import { BuildStatisticsTab } from "@/features/monitoring/components/BuildStatisticsTab";
import { RecentRunsTab } from "@/features/monitoring/components/RecentRunsTab";
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";

export function MonitoringPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<MonitoringTab>("system");
  const [loading, setLoading] = useState<MonitoringLoadingState>("idle");
  const [unauthorized, setUnauthorized] = useState(false);
  const [data, setData] = useState<MonitoringData | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [isPageVisible, setIsPageVisible] = useState(true);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousStatusRef = useRef<string | null>(null);

  const fetchMonitoringData = useCallback(async () => {
    if (!isPageVisible) return;

    setLoading("loading");

    if (!isRealBuilderEnabled()) {
      setData(getMockMonitoringData());
      setLoading("success");
      setLastRefreshTime(new Date());
      return;
    }

    try {
      const [summary, builds] = await Promise.all([
        builderApi.getMonitoringSummary(),
        builderApi.getMonitoringBuilds(),
      ]);
      setData({ summary, builds });
      setLoading("success");
      setLastRefreshTime(new Date());

      if (
        previousStatusRef.current &&
        previousStatusRef.current !== summary.status
      ) {
        if (summary.status === "degraded") {
          console.warn("Builder system health degraded");
        }
      }
      previousStatusRef.current = summary.status;
    } catch (err) {
      // 401/403은 인증/인가 문제로 구분해 안내한다 — 실API 응답 기준(#302).
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setUnauthorized(true);
        setLoading("error");
        return;
      }
      setLoading("error");
    }
  }, [isPageVisible]);

  useEffect(() => {
    fetchMonitoringData();

    if (autoRefresh && isPageVisible) {
      intervalRef.current = setInterval(fetchMonitoringData, 30000);
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchMonitoringData, autoRefresh, isPageVisible]);

  useEffect(() => {
    const onVisibilityChange = () => setIsPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const toggleAutoRefresh = () => setAutoRefresh((prev) => !prev);

  if (unauthorized) {
    return (
      <main className="flex flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <PageHeader
          eyebrow="Monitoring"
          title={t("monitoringPage.title")}
          description={t("monitoringPage.desc")}
        />
        <ErrorState
          title={t("monitoringPage.forbiddenTitle")}
          message={t("monitoringPage.forbiddenDesc")}
        />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Monitoring"
        title={t("monitoringPage.title")}
        description={t("monitoringPage.desc")}
        actions={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {lastRefreshTime
                ? t("monitoringPage.lastUpdate", {
                    at: lastRefreshTime.toLocaleTimeString(
                      i18n.language?.startsWith("en") ? "en-US" : "ko-KR",
                    ),
                  })
                : t("monitoringPage.loading")}
            </span>
            <Button
              variant={autoRefresh ? "primary" : "secondary"}
              size="sm"
              onClick={toggleAutoRefresh}
              type="button"
            >
              {autoRefresh ? t("monitoringPage.autoRefreshOn") : t("monitoringPage.autoRefreshOff")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fetchMonitoringData()}
              type="button"
            >
              {t("monitoringPage.refresh")}
            </Button>
          </div>
        }
      />

      {data?.summary.status === "degraded" && (
        <Card variant="error">
          <p className="font-semibold">{t("monitoringPage.degradedTitle")}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("monitoringPage.degradedDesc")}
          </p>
        </Card>
      )}

      <div className="flex gap-1 border-b border-border">
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "system"
              ? "border-b-2 border-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("system")}
          type="button"
        >
          System Resources
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "builds"
              ? "border-b-2 border-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("builds")}
          type="button"
        >
          Build Statistics
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "recent-runs"
              ? "border-b-2 border-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("recent-runs")}
          type="button"
        >
          Recent Runs
        </button>
      </div>

      {activeTab === "system" ? (
        <SystemResourcesTab loading={loading} summary={data?.summary} />
      ) : activeTab === "builds" ? (
        <BuildStatisticsTab loading={loading} builds={data?.builds} />
      ) : (
        <RecentRunsTab loading={loading} runs={data?.builds?.recent_runs} />
      )}
    </main>
  );
}
