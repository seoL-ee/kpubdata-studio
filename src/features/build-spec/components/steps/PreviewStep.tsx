/** 마법사 4단계 — 미리보기 (#379). */
import { useTranslation } from "react-i18next";

import { Button, EmptyState } from "@/shared/ui";
import type { PreviewState } from "@/features/build-spec/newBuildModel";

export interface PreviewStepProps {
  preview: PreviewState;
  onRefresh: () => void;
}

export function PreviewStep({ preview, onRefresh }: PreviewStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.preview.title")}</h3>
        <Button variant="secondary" size="sm" loading={preview.status === "loading"} onClick={onRefresh}>
          {t("newBuild.preview.refresh")}
        </Button>
      </div>
      {preview.status === "idle" ? (
        <EmptyState title={t("newBuild.preview.guideTitle")} description={t("newBuild.preview.guideDesc")} />
      ) : null}
      {preview.status === "error" ? (
        <EmptyState
          title={t("newBuild.preview.failTitle")}
          description={preview.error ?? t("newBuild.preview.failDesc")}
        />
      ) : null}
      {preview.status === "loaded" && preview.rows.length === 0 ? (
        <EmptyState title={t("newBuild.preview.emptyTitle")} description={t("newBuild.preview.emptyDesc")} />
      ) : null}
      {preview.status === "loaded" && preview.warnings.length > 0 ? (
        <ul className="space-y-2">
          {preview.warnings.map((warning) => (
            <li
              key={warning}
              role="alert"
              className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.status === "loaded" && preview.rows.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("newBuild.preview.rowsCols", {
            rows: preview.rows.length,
            cols: Object.keys(preview.schema).length,
          })}
        </p>
      ) : null}
    </div>
  );
}
