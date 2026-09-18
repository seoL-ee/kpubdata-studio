import { useTranslation } from "react-i18next";
import { glossaryDescription } from "@/shared/content/glossary";
import { QualityBadge } from "@/features/quality/QualityBadge";

export function StageLegend() {
  const { t } = useTranslation();
  return (
    <div aria-label={t("legend.stageLabel")} className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {(["bronze", "silver", "gold"] as const).map((stage) => (
        <span key={stage}><strong className="capitalize text-foreground">{stage}</strong> · {glossaryDescription(stage)}</span>
      ))}
    </div>
  );
}

export function QualityLegend() {
  const { t } = useTranslation();
  const items = [
    ["PASS", t("legend.quality.pass")],
    ["WARN", t("legend.quality.warn")],
    ["FAIL", t("legend.quality.fail")],
    ["N/A", t("legend.quality.na")],
  ] as const;
  return (
    <div aria-label={t("legend.qualityLabel")} className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {items.map(([status, copy]) => <span key={status} className="inline-flex items-center gap-1.5"><QualityBadge status={status} />{copy}</span>)}
      <span><strong className="text-foreground">UNAVAILABLE</strong> · {t("legend.quality.unavailable")}</span>
    </div>
  );
}
