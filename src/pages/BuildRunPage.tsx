/**
 * 빌드 실행 추적 페이지 (/builds/:buildId/run) — legacy deep-link 호환용.
 *
 * 이전에는 buildId와 무관하게 항상 "대기(queued)"·0번째 stepper를 보여주는 정적
 * placeholder였다(UI audit #3). 지금은 Builds 목록/상세(BuildsPage)와 동일한 canonical
 * 상태(historical summary + live job polling)만 보여준다.
 *
 * 단계별 진행(Bronze/Silver/Gold), 실행 이벤트 타임라인, 협조적 실행 취소는 canonical
 * Build 상세(`/builds?run=...`)가 이미 제공한다 — 이 legacy 화면은 두 번째 상태 머신을
 * 만들지 않고 canonical 상세로 안내한다. "API 미지원" 같은 사실과 다른 문구는 두지 않는다.
 */
import { useParams } from "react-router-dom";
import { useSelectedRunPolling } from "@/features/runs/useSelectedRunPolling";
import { useBuild } from "@/features/runs/useBuild";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { BuildRunStatus } from "@/shared/lib/types";
import { Card, EmptyState, LinkButton, PageHeader, Skeleton, StatusBadge } from "@/shared/ui";
import { useTranslation } from "react-i18next";

/**
 * 빌드 실행의 canonical 상태를 추적하는 페이지.
 *
 * @returns 실행 상태 화면.
 */
export function BuildRunPage() {
  const { t } = useTranslation();
  const { buildId = "" } = useParams();

  // historical: Builds 목록/편집과 같은 getBuild() 조회(mock 모드는 결정적 mock, 실연동은
  // Builder 이력 + Studio가 보관한 스펙).
  const { build, isLoading: historicalLoading, error: historicalError } = useBuild(buildId);

  // live: registry에 살아있는 job이 있으면(#245/#255) 그 상태가 가장 최신이다 — Builds
  // 상세(BuildsPage)와 동일한 hook을 재사용해 두 화면이 같은 canonical run state를 쓰게 한다.
  // mock 모드는 getBuildJob이 항상 실패하는 stub이라(#255 §3 주석 참고) live polling 자체를
  // 켜지 않고, 위 historical(deterministic mock) 상태를 그대로 신뢰한다.
  const live = useSelectedRunPolling(isRealBuilderEnabled() ? buildId || null : null);

  const runStatus: BuildRunStatus | undefined =
    live.kind === "job" ? live.job.status : build?.status;

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("buildRun.eyebrow")}
        title={t("buildRun.title", { id: buildId || t("buildRun.fallbackId") })}
        description={t("buildRun.desc")}
        actions={
          <LinkButton variant="secondary" to={`/builds?run=${encodeURIComponent(buildId)}`}>
            {t("buildRun.manageInDetail")}
          </LinkButton>
        }
      />

      <Card className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">{t("buildRun.status")}</span>
        {historicalLoading && live.kind !== "job" ? (
          <Skeleton className="h-6 w-20" />
        ) : runStatus ? (
          <StatusBadge status={runStatus} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {historicalError ?? t("buildRun.unknownStatus")}
          </span>
        )}
        {live.kind === "job" && (live.job.status === "queued" || live.job.status === "running" || live.job.status === "cancelling") ? (
          <span className="text-xs text-muted-foreground">{t("buildRun.liveUpdating")}</span>
        ) : null}
        {live.kind === "error" ? (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t("buildRun.liveFailed")}
          </span>
        ) : null}
        {live.kind === "permission_denied" ? (
          <span className="text-xs text-red-700 dark:text-red-400">
            {t("buildRun.liveForbidden")}
          </span>
        ) : null}
      </Card>

      <Card variant="dashed" className="p-0">
        <EmptyState
          title={t("buildRun.detailHint.title")}
          description={t("buildRun.detailHint.desc")}
        />
      </Card>

      <div className="flex flex-wrap gap-3">
        <LinkButton variant="secondary" to={`/builds?run=${encodeURIComponent(buildId)}`}>
          {t("buildRun.openDetail")}
        </LinkButton>
        <LinkButton variant="secondary" to={`/builds/${buildId}/artifacts`}>
          {t("buildRun.openArtifacts")}
        </LinkButton>
        <LinkButton variant="ghost" to={`/builds/${buildId}/edit`}>
          {t("buildRun.editSpec")}
        </LinkButton>
      </div>
    </main>
  );
}
