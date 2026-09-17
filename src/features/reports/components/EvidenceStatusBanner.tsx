/**
 * 저장된 Report의 기준 evidence 상태(CURRENT/STALE/ORPHAN/UNAVAILABLE)를 알린다 (#258 §8).
 *
 * 어떤 상태여도 저장된 Report 내용을 지우거나 자동으로 최신 run으로 바꾸지 않는다 —
 * 이 배너는 상태를 알리고, STALE일 때만 "새 Report 만들기" 진입점을 보여준다.
 */
import { useTranslation } from "react-i18next";
import { Card } from "@/shared/ui";
import type { EvidenceStalenessResult } from "../staleness";

const COPY: Record<EvidenceStalenessResult["status"], { titleKey: string; tone: "default" | "warn" | "error" }> = {
  current: { titleKey: "current", tone: "default" },
  stale: { titleKey: "stale", tone: "warn" },
  orphan: { titleKey: "orphan", tone: "error" },
  unavailable: { titleKey: "unavailable", tone: "warn" },
};

const TONE_CLASS: Record<"default" | "warn" | "error", string> = {
  default: "border-border bg-card",
  warn: "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
  error: "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30",
};

export function EvidenceStatusBanner({
  result,
  loading,
  onRecheck,
  onCreateFromLatest,
}: {
  result: EvidenceStalenessResult | null;
  loading: boolean;
  onRecheck: () => void;
  onCreateFromLatest?: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <Card className="flex items-center justify-between gap-3 py-3 text-sm text-muted-foreground">
        <span>{t("reports.evidenceBanner.rechecking")}</span>
      </Card>
    );
  }
  if (!result) return null;

  const copy = COPY[result.status];
  return (
    <Card className={`flex flex-wrap items-center justify-between gap-3 border py-3 text-sm ${TONE_CLASS[copy.tone]}`}>
      <div>
        <p className="font-medium">{t(`reports.evidenceBanner.status.${copy.titleKey}`)}</p>
        {result.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{result.reason}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRecheck}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          {t("reports.evidenceBanner.recheck")}
        </button>
        {result.status === "stale" && onCreateFromLatest ? (
          <button
            type="button"
            onClick={onCreateFromLatest}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {t("reports.evidenceBanner.newFromLatest")}
          </button>
        ) : null}
      </div>
    </Card>
  );
}
