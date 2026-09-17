/**
 * Deterministic Report section 생성 (#258 §4, §5).
 *
 * `ReportEvidenceBundle`(Builder에서 그대로 가져온 값)만 입력으로 받아 코드가 그대로
 * BUILDER_EVIDENCE 블록을 구성한다 — LLM은 이 단계에 전혀 관여하지 않는다. 값이 없거나
 * 조회에 실패한 항목은 "N/A"/"확인할 수 없음"으로 표시하며 0/PASS/정상으로 바꾸지 않는다.
 */
import { formatDateTime, sourceLabel } from "@/features/datasets/model";
import {
  flattenQualityResults,
  flattenSchemaDrift,
  formatQualityValue,
} from "@/features/quality/model";
import { i18n } from "@/shared/i18n";
import type { ReportEvidenceBundle } from "./evidence";
import { buildSectionSummaries, computeQualityCounts } from "./narrativeSummary";
import type { BuilderEvidenceBlock, BuilderEvidenceSection } from "./types";

/** 이 파일의 문장 키는 모두 이 네임스페이스 아래에 있다(#350). */
const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(`reports.sections.${key}`, params ?? {});

/** 숫자 구분자는 화면 언어를 따른다. */
function numberLocale(): string {
  return i18n.language?.startsWith("en") ? "en-US" : "ko-KR";
}

const NA = "N/A";

function newBlockId(section: BuilderEvidenceSection): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `evidence-${section}-${crypto.randomUUID()}`;
  return `evidence-${section}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeBlock(
  section: BuilderEvidenceSection,
  title: string,
  markdown: string,
  evidenceStatus: BuilderEvidenceBlock["evidenceStatus"],
  unavailableReason: string | undefined,
  now: string,
  summary: string,
): BuilderEvidenceBlock {
  return {
    id: newBlockId(section),
    provenance: "BUILDER_EVIDENCE",
    section,
    title,
    markdown,
    evidenceStatus,
    unavailableReason,
    summary,
    createdAt: now,
    updatedAt: now,
  };
}

function mdTable(header: string[], rows: string[][]): string {
  const sep = header.map(() => "---");
  return [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join(
    "\n",
  );
}

function buildOverview(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  if (!evidence.dataset.ok) {
    return makeBlock(
      "overview",
      "1. Overview",
      t("overview.loadFailed", { reason: evidence.dataset.reason }),
      "unavailable",
      evidence.dataset.reason,
      now,
      summary,
    );
  }
  const dataset = evidence.dataset.value;
  const rows: string[][] = [
    [t("overview.rowDataset"), `${dataset.title} (\`${dataset.dataset_id}\`)`],
    [t("overview.rowProviders"), [...new Set(dataset.sources.map((s) => s.provider))].join(", ") || NA],
    [t("overview.rowSources"), dataset.sources.map((s) => sourceLabel(s)).join(", ") || NA],
    [t("overview.rowRun"), `\`${evidence.runId}\``],
    [t("overview.rowRunStatus"), evidence.run.ok ? evidence.run.value.status : t("unavailable")],
    [
      t("overview.rowRunTimes"),
      evidence.run.ok
        ? `${formatDateTime(evidence.run.value.started_at)} → ${formatDateTime(evidence.run.value.finished_at)}`
        : t("unavailable"),
    ],
    [
      t("overview.rowSpecDigest"),
      evidence.run.ok ? (evidence.run.value.spec_digest ?? NA) : t("unavailable"),
    ],
    [t("overview.rowUpdatedAt"), formatDateTime(dataset.updated_at)],
  ];
  const status = evidence.run.ok ? "ok" : "partial";
  return makeBlock(
    "overview",
    "1. Overview",
    mdTable([t("overview.colItem"), t("overview.colValue")], rows),
    status,
    evidence.run.ok ? undefined : evidence.run.reason,
    now,
    summary,
  );
}

function buildPipeline(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  if (evidence.stages.ok) {
    const rows = evidence.stages.value.sources.map((source) => [
      `\`${source.source_key}\``,
      source.bronze.status,
      source.silver.status,
      source.gold.status,
    ]);
    if (rows.length === 0) {
      return makeBlock("pipeline", "2. Pipeline", t("pipeline.noSources"), "ok", undefined, now, summary);
    }
    return makeBlock(
      "pipeline",
      "2. Pipeline",
      mdTable(["Source", "Bronze", "Silver", "Gold"], rows),
      "ok",
      undefined,
      now,
      summary,
    );
  }

  // stage 상세 조회는 실패했지만 dataset 요약에 stage map이 남아있으면 그걸로 대체한다(부분 실패 허용).
  if (evidence.dataset.ok) {
    const rows = Object.entries(evidence.dataset.value.stages).map(([sourceKey, stage]) => [
      `\`${sourceKey}\``,
      stage.bronze,
      stage.silver,
      stage.gold,
    ]);
    return makeBlock(
      "pipeline",
      "2. Pipeline",
      `${t("pipeline.fallbackNote", { reason: evidence.stages.reason })}\n\n${mdTable(["Source", "Bronze", "Silver", "Gold"], rows)}`,
      "partial",
      evidence.stages.reason,
      now,
      summary,
    );
  }

  return makeBlock(
    "pipeline",
    "2. Pipeline",
    t("pipeline.loadFailed", { reason: evidence.stages.reason }),
    "unavailable",
    evidence.stages.reason,
    now,
    summary,
  );
}

function buildQuality(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  const qualityCounts = computeQualityCounts(evidence) ?? undefined;
  if (!evidence.quality.ok) {
    return {
      ...makeBlock(
        "quality",
        "3. Quality",
        t("quality.loadFailed", { reason: evidence.quality.reason }),
        "unavailable",
        evidence.quality.reason,
        now,
        summary,
      ),
      qualityCounts,
    };
  }
  const quality = evidence.quality.value;
  if (quality.availability === "unavailable") {
    return {
      ...makeBlock(
        "quality",
        "3. Quality",
        t("quality.notProvided"),
        "ok",
        undefined,
        now,
        summary,
      ),
      qualityCounts,
    };
  }

  const results = flattenQualityResults(quality);
  const drift = flattenSchemaDrift(quality);
  const pass = results.filter((r) => r.status === "pass").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;

  const summaryLine = `availability: \`${quality.availability}\` · evaluated_checks: **${quality.evaluated_checks}** · PASS ${pass} / WARN ${warn} / FAIL ${fail}`;

  const resultRows =
    results.length === 0
      ? []
      : results.map((r) => [
          `\`${r.source_key}\``,
          r.category,
          r.rule,
          r.column ?? NA,
          r.status.toUpperCase(),
          formatQualityValue(r.rule, r.actual),
          formatQualityValue(r.rule, r.threshold),
        ]);

  const driftLines =
    drift.length === 0
      ? t("quality.noDrift")
      : drift.map((d) => `- \`${d.column ?? NA}\`: ${d.kind} — ${d.detail}`).join("\n");

  const parts = [summaryLine];
  if (resultRows.length > 0) {
    parts.push(mdTable(
      ["Source", "Category", "Rule", "Column", t("quality.colResult"), t("quality.colActual"), t("quality.colThreshold")],
      resultRows,
    ));
  } else {
    parts.push(t("quality.noneEvaluated"));
  }
  parts.push(`**${t("quality.driftTitle")}**\n\n${driftLines}`);

  return {
    ...makeBlock("quality", "3. Quality", parts.join("\n\n"), "ok", undefined, now, summary),
    qualityCounts,
  };
}

function buildSchema(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  const entries = Object.entries(evidence.schemas);
  if (entries.length === 0) {
    return makeBlock(
      "schema",
      "4. Schema",
      t("schema.noSources"),
      "unavailable",
      undefined,
      now,
      summary,
    );
  }

  const unavailableCount = entries.filter(([, schema]) => schema.origin === "unavailable").length;
  const parts = entries.map(([sourceKey, schema]) => {
    if (schema.origin === "silver") {
      const rows = schema.columns.map((col) => [col.name, col.dtype, col.nullable ? "Y" : "N", String(col.unique_count)]);
      return `**\`${sourceKey}\`** (silver)\n\n${mdTable([t("schema.colColumn"), t("schema.colType"), t("schema.colNullable"), t("schema.colUnique")], rows)}`;
    }
    if (schema.origin === "gold_names_only") {
      const rows = (schema.columnNamesOnly ?? []).map((name) => [name, NA, NA]);
      return `**\`${sourceKey}\`** ${t("schema.goldNamesOnly")}\n\n${mdTable([t("schema.colColumn"), t("schema.colType"), t("schema.colNullable")], rows)}`;
    }
    return `**\`${sourceKey}\`**: ${t("unavailable")}${schema.reason ? ` (${schema.reason})` : ""}`;
  });

  const status: BuilderEvidenceBlock["evidenceStatus"] =
    unavailableCount === 0 ? "ok" : unavailableCount === entries.length ? "unavailable" : "partial";

  return makeBlock("schema", "4. Schema", parts.join("\n\n"), status, undefined, now, summary);
}

function buildDataSummary(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  if (!evidence.dataset.ok) {
    return makeBlock(
      "data_summary",
      "5. Data Summary",
      t("dataSummary.loadFailed", { reason: evidence.dataset.reason }),
      "unavailable",
      evidence.dataset.reason,
      now,
      summary,
    );
  }
  const dataset = evidence.dataset.value;
  const locale = numberLocale();
  const rows = Object.entries(dataset.row_counts).map(([sourceKey, count]) => [
    `\`${sourceKey}\``,
    count.toLocaleString(locale),
  ]);
  const body = [
    `**${t("dataSummary.totalLabel")}**: ${dataset.total_row_count.toLocaleString(locale)}`,
    rows.length > 0
      ? mdTable(["Source", t("dataSummary.colRowCount")], rows)
      : t("dataSummary.noBreakdown"),
  ].join("\n\n");
  return makeBlock("data_summary", "5. Data Summary", body, "ok", undefined, now, summary);
}

function buildOutput(evidence: ReportEvidenceBundle, now: string, summary: string): BuilderEvidenceBlock {
  if (!evidence.output.ok) {
    return makeBlock(
      "output",
      "6. Output",
      t("output.loadFailed", { reason: evidence.output.reason }),
      "unavailable",
      evidence.output.reason,
      now,
      summary,
    );
  }
  const files = evidence.output.value.files;
  if (files.length === 0) {
    return makeBlock("output", "6. Output", t("output.none"), "ok", undefined, now, summary);
  }
  return makeBlock(
    "output",
    "6. Output",
    files.map((f) => `- \`${f}\``).join("\n"),
    "ok",
    undefined,
    now,
    summary,
  );
}

/** evidence bundle로부터 6개 deterministic BUILDER_EVIDENCE 블록을 생성한다. */
export function buildDeterministicSections(evidence: ReportEvidenceBundle): BuilderEvidenceBlock[] {
  const now = new Date().toISOString();
  const summaries = buildSectionSummaries(evidence);
  return [
    buildOverview(evidence, now, summaries.overview),
    buildPipeline(evidence, now, summaries.pipeline),
    buildQuality(evidence, now, summaries.quality),
    buildSchema(evidence, now, summaries.schema),
    buildDataSummary(evidence, now, summaries.data_summary),
    buildOutput(evidence, now, summaries.output),
  ];
}
