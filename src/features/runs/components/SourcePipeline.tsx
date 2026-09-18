/**
 * source 별 Bronze → Silver → Gold → Output 파이프라인 표시 (#379로 BuildsPage에서 분리).
 *
 * Builder 가 준 stage 상태를 그대로 보여준다 — 도달하지 않은 stage 를 실패로 칠하거나
 * 여러 source 를 하나로 뭉개지 않는다.
 */
import { useTranslation } from "react-i18next";

import { StageBadge } from "@/features/datasets/components/StageBadge";
import { formatDateTime } from "@/features/datasets/model";
import { summarizeMultiSourceOutcome } from "@/features/runs/model";
import {
  formatRecordCount,
  isUnreachedStage,
  pickStageDetail,
  stageDetailKey,
  type StageDetailEntry,
  type StageName,
} from "@/features/runs/stageDetails";
import type { RunStageEntry } from "@/shared/lib/builderApi";



export function MultiSourceOutcomeBadge({
  outcome,
}: { outcome: ReturnType<typeof summarizeMultiSourceOutcome> }) {
  const { t } = useTranslation();
  if (outcome === "unavailable") return null;
  const meta = {
    all_succeeded: { label: t("builds.outcome.allSucceeded"), className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
    partial: { label: t("builds.outcome.partial"), className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
    all_failed: { label: t("builds.outcome.allFailed"), className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  }[outcome];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

function PipelineArrow() {
  return (
    <span aria-hidden="true" className="self-center px-1 text-muted-foreground">
      →
    </span>
  );
}

function BronzeStageBox({ state, detail }: { state: RunStageEntry["bronze"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "bronze");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Bronze</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.record_count, t)}
          {data.fetched_at ? ` · ${formatDateTime(data.fetched_at)}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function SilverStageBox({
  state,
  detail,
}: { state: RunStageEntry["silver"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "silver");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Silver</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.row_count, t)} · {t("builds.data.cols", { count: data.schema.length })}
          {data.validation ? ` · ${data.validation.ok ? t("builds.data.validationOk") : t("builds.data.problems", { count: data.validation.problems.length })}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function GoldStageBox({
  state,
  detail,
}: { state: RunStageEntry["gold"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "gold");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Gold</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.row_count, t)} · {t("builds.data.cols", { count: data.columns.length })}
          {data.splits ? t("builds.data.splits", { count: Object.keys(data.splits).length }) : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Output은 Stage가 아니다 — Gold export가 실제로 확인될 때만 compact하게 보여주고,
 * completed/failed 같은 Stage 상태로 표현하지 않는다.
 */
function OutputBox({ detail }: { detail: StageDetailEntry | undefined }) {
  const data = pickStageDetail(detail, "gold");
  const exports = data?.exports ?? [];
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-dashed border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Output</span>
      <span className="text-xs text-muted-foreground">
        {exports.length > 0 ? exports.map((item) => item.kind).join(" · ") : "—"}
      </span>
    </div>
  );
}

export function SourcePipelineRow({ source, details }: { source: RunStageEntry; details: Record<string, StageDetailEntry> }) {
  const { t } = useTranslation();
  const unreached: Record<StageName, boolean> = {
    bronze: isUnreachedStage(source, "bronze"),
    silver: isUnreachedStage(source, "silver"),
    gold: isUnreachedStage(source, "gold"),
  };
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</span>
        <span className="font-mono text-xs">{source.source_key}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-1">
        <div className={source.bronze.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <BronzeStageBox state={source.bronze} detail={details[stageDetailKey(source.source_key, "bronze")]} />
          {unreached.bronze ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <div className={source.silver.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <SilverStageBox state={source.silver} detail={details[stageDetailKey(source.source_key, "silver")]} />
          {unreached.silver ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <div className={source.gold.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <GoldStageBox state={source.gold} detail={details[stageDetailKey(source.source_key, "gold")]} />
          {unreached.gold ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <OutputBox detail={details[stageDetailKey(source.source_key, "gold")]} />
      </div>
    </div>
  );
}
