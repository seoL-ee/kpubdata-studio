/**
 * Builds 상단 KPI 타일 (#379로 BuildsPage에서 분리).
 *
 * KPI 는 `/builds` 가 돌려준 목록 안에서만 계산한다 — Builder 에 전체 count 가 없으므로
 * 이 범위를 넘어선 수치를 지어내지 않는다.
 */
import { useTranslation } from "react-i18next";

import { computeBuildKpi } from "@/features/runs/model";
import { Card } from "@/shared/ui";


function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

/**
 * Running KPI는 running+queued(+cancelling) 합계를 값으로 유지하되(기존 정책), hint에는
 * 실제 조회 scope에서 센 status별 breakdown만 보여준다 — 값을 추측하지 않는다(#286 후속 보완 §3).
 */
function runningBreakdownHint(
  kpi: ReturnType<typeof computeBuildKpi>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (kpi.running === 0) return t("builds.kpi.scope");
  const parts: string[] = [];
  if (kpi.runningOnly > 0) parts.push(t("builds.kpi.running", { count: kpi.runningOnly }));
  if (kpi.cancellingOnly > 0) parts.push(t("builds.kpi.cancelling", { count: kpi.cancellingOnly }));
  if (kpi.queuedOnly > 0) parts.push(t("builds.kpi.queued", { count: kpi.queuedOnly }));
  return parts.join(" · ");
}

export function KpiRow({ kpi }: { kpi: ReturnType<typeof computeBuildKpi> }) {
  const { t } = useTranslation();
  const scopeHint = t("builds.kpi.scopeHint", {
    count: kpi.scopeCount,
    limit: kpi.scopeLimit,
    more: kpi.scopeCount >= kpi.scopeLimit ? t("builds.kpi.maybeMore") : "",
  });
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <KpiTile label={t("builds.kpi.buildsScope")} value={String(kpi.scopeCount)} hint={scopeHint} />
      <KpiTile label="Success" value={String(kpi.succeeded)} hint={t("builds.kpi.scope")} />
      <KpiTile label="Failed" value={String(kpi.failed)} hint={t("builds.kpi.scope")} />
      <KpiTile
        label="Running"
        value={kpi.runningAvailable ? String(kpi.running) : "N/A"}
        hint={
          kpi.runningAvailable
            ? runningBreakdownHint(kpi, t)
            : t("builds.kpi.completedOnlyHint")
        }
      />
    </div>
  );
}
