/**
 * 마법사 6단계 — 검증·실행 (#379).
 *
 * 실행 버튼은 `canRun` 하나로 막는다. 페이지가 "검증 통과 + 실행 중 아님 + 스펙 있음"을
 * 이미 판정해서 넘겨주므로, 이 컴포넌트가 조건을 다시 조립하다가 어긋날 여지를 없앤다.
 */
import { useTranslation } from "react-i18next";

import { Button, Card } from "@/shared/ui";
import type { BuildJob } from "@/features/runs/useBuildJob";
import type { ValidationState } from "@/features/build-spec/newBuildModel";

export interface ReviewStepProps {
  validation: ValidationState;
  job: BuildJob;
  canRun: boolean;
  canSave: boolean;
  saveSpecMessage: { type: "success" | "error"; text: string } | null;
  onRevalidate: () => void;
  onRun: () => void;
  onSaveSpec: () => void;
}

export function ReviewStep({
  validation,
  job,
  canRun,
  canSave,
  saveSpecMessage,
  onRevalidate,
  onRun,
  onSaveSpec,
}: ReviewStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.review.title")}</h3>
        <Button
          variant="secondary"
          size="sm"
          loading={validation.status === "validating"}
          onClick={onRevalidate}
        >
          {t("newBuild.review.revalidate")}
        </Button>
      </div>
      {validation.status === "idle" ? (
        <p className="text-sm text-muted-foreground">{t("newBuild.review.guide")}</p>
      ) : null}
      {validation.status === "validated" && validation.isValid ? (
        <Card variant="success" className="p-4">
          <p className="text-sm font-medium text-accent-subtle-foreground">{t("newBuild.review.passed")}</p>
        </Card>
      ) : null}
      {validation.errors.length > 0 ? (
        <ul className="space-y-2">
          {validation.errors.map((error) => (
            <li
              key={error}
              role="alert"
              className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200"
            >
              {error}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!canRun} loading={job.status === "running"} onClick={onRun}>
          {t("newBuild.review.run")}
        </Button>
        {job.status === "running" ? (
          <Button variant="secondary" onClick={job.cancel}>
            {t("newBuild.review.cancel")}
          </Button>
        ) : null}
        {job.status === "succeeded" ? (
          <span className="text-sm text-accent-subtle-foreground">
            {t("newBuild.review.success", { id: job.run?.id })}
          </span>
        ) : null}
        {job.status === "failed" ? (
          <span role="alert" className="text-sm text-red-700 dark:text-red-300">
            {job.error}
          </span>
        ) : null}
        {job.status === "cancelled" ? (
          <span className="text-sm text-muted-foreground">{t("newBuild.review.cancelled")}</span>
        ) : null}
        {job.interrupted && job.status !== "cancelled" ? (
          <span className="text-sm text-muted-foreground">{t("newBuild.review.aborted")}</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button variant="secondary" disabled={!canSave} onClick={onSaveSpec}>
          {t("newBuild.review.saveSpec")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("newBuild.review.saveSpecDesc")}</span>
      </div>
      {saveSpecMessage ? (
        <p
          role={saveSpecMessage.type === "error" ? "alert" : undefined}
          className={`text-sm ${saveSpecMessage.type === "error" ? "text-red-700 dark:text-red-300" : "text-accent-subtle-foreground"}`}
        >
          {saveSpecMessage.text}
        </p>
      ) : null}
    </div>
  );
}
