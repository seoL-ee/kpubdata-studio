import { i18n } from "@/shared/i18n";
import type {
  DatasetSourceRef,
  DatasetSummary,
  RunStageEntry,
  SourceStageStatus,
  StageStatus,
} from "@/shared/lib/builderApi";

export type DatasetStage = "bronze" | "silver" | "gold";

export const DATASET_STAGES: DatasetStage[] = ["bronze", "silver", "gold"];
export const STAGE_STATUSES: StageStatus[] = ["completed", "failed", "not_run", "unavailable"];

export interface DatasetStageSummary {
  label: "Bronze" | "Silver" | "Gold" | "Mixed / Partial" | "Mixed / Failed" | "Failed" | "Unavailable";
  tone: "bronze" | "silver" | "gold" | "warning" | "failed" | "muted";
  description: string;
}

export function uniqueProviders(sources: DatasetSourceRef[]): string[] {
  return [...new Set(sources.map((source) => source.provider))].sort((a, b) => a.localeCompare(b));
}

export function sourceLabel(source: DatasetSourceRef): string {
  return source.alias || `${source.provider}.${source.dataset}`;
}

export function isMixedStageMap(stages: Record<string, SourceStageStatus>): boolean {
  const signatures = Object.values(stages).map(
    (stage) => `${stage.bronze}/${stage.silver}/${stage.gold}`,
  );
  return new Set(signatures).size > 1;
}

export function datasetHasStageStatus(dataset: DatasetSummary, status: StageStatus): boolean {
  return Object.values(dataset.stages).some((sourceStages) =>
    DATASET_STAGES.some((stage) => sourceStages[stage] === status),
  );
}

/** Catalog에서는 source별 stage를 펼치지 않고 실제 상태를 한 개의 정직한 요약으로 표시한다. */
export function summarizeDatasetStages(stages: Record<string, SourceStageStatus>): DatasetStageSummary {
  const sources = Object.values(stages);
  if (sources.length === 0) {
    return { label: "Unavailable", tone: "muted", description: i18n.t("datasets.stage.noStageInfo") };
  }

  const hasFailed = sources.some((source) => DATASET_STAGES.some((stage) => source[stage] === "failed"));
  const mixed = isMixedStageMap(stages);
  if (hasFailed) {
    return {
      label: mixed ? "Mixed / Failed" : "Failed",
      tone: "failed",
      description: mixed ? i18n.t("datasets.stage.mixedWithFailure") : i18n.t("datasets.stage.stageFailed"),
    };
  }
  if (mixed) {
    return { label: "Mixed / Partial", tone: "warning", description: i18n.t("datasets.stage.mixed") };
  }

  const common = sources[0];
  if (common.gold === "completed") return { label: "Gold", tone: "gold", description: i18n.t("datasets.stage.goldDone") };
  if (common.silver === "completed") return { label: "Silver", tone: "silver", description: i18n.t("datasets.stage.silverDone") };
  if (common.bronze === "completed") return { label: "Bronze", tone: "bronze", description: i18n.t("datasets.stage.bronzeDone") };
  if (DATASET_STAGES.some((stage) => common[stage] === "not_run")) {
    return { label: "Mixed / Partial", tone: "warning", description: i18n.t("datasets.stage.someNotRun") };
  }
  return { label: "Unavailable", tone: "muted", description: i18n.t("datasets.stage.noStage") };
}

export function highestCompletedStage(source: RunStageEntry): DatasetStage {
  if (source.gold.status === "completed") return "gold";
  if (source.silver.status === "completed") return "silver";
  if (source.bronze.status === "completed") return "bronze";
  return "bronze";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}
