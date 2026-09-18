/**
 * Report Draft 로컬 저장소 (#258).
 *
 * `draftStorage.ts`/`specStore.ts`와 같은 `{version, ...}` 봉투 규약을 따르되, 단일 키에
 * 하나만 저장하던 그 모듈들과 달리 **여러 Report를 각자의 id로 저장**한다(#258 §11 —
 * "단일 localStorage key 하나에 Report 하나만 저장하는 구조는 피한다"). `#260 Workspace`가
 * 나중에 같은 저장 계층을 재사용할 수 있도록 이 파일의 함수 시그니처만 의존하게 하고,
 * 내부 표현(localStorage 봉투)은 자유롭게 바꿀 수 있는 여지를 남긴다.
 *
 * 저장 실패(quota 초과/storage 사용 불가/직렬화 실패)를 조용히 삼키지 않는다 — 호출부가
 * "저장됨"이라고 잘못 표시하지 않도록 항상 명시적 결과를 반환한다(#258 §11, §12).
 */
import { i18n } from "@/shared/i18n";
import { REPORT_VERSION, type ReportDraft, type ReportSummary } from "./types";
import { ownedStorageKey } from "@/features/auth/storageOwner";

const STORE_KEY = "kpubdata-studio:reports";
export const STORE_VERSION = 1;

/** 저장 가능한 최대 Report 수. 넘으면 가장 오래 수정되지 않은 것부터 저장을 거부한다(자동 삭제하지 않음). */
export const REPORT_STORE_LIMIT = 30;

interface StoreEnvelope {
  version: number;
  reports: Record<string, ReportDraft>;
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: string; conflict?: boolean };

function emptyEnvelope(): StoreEnvelope {
  return { version: STORE_VERSION, reports: {} };
}

function isStorageAvailable(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** 저장된 봉투를 읽는다. 없거나 버전이 다르거나 손상되면 빈 봉투를 반환한다(손상 값은 정리). */
function readEnvelope(): StoreEnvelope {
  if (!isStorageAvailable()) return emptyEnvelope();
  try {
    const raw = localStorage.getItem(ownedStorageKey(STORE_KEY));
    if (!raw) return emptyEnvelope();
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as StoreEnvelope).version !== STORE_VERSION ||
      typeof (parsed as StoreEnvelope).reports !== "object" ||
      (parsed as StoreEnvelope).reports === null
    ) {
      localStorage.removeItem(ownedStorageKey(STORE_KEY));
      return emptyEnvelope();
    }
    return parsed as StoreEnvelope;
  } catch {
    return emptyEnvelope();
  }
}

/**
 * 봉투를 저장한다. 성공/실패를 그대로 알린다 — quota 초과·storage 미지원·직렬화 실패를
 * 구분해 이유를 돌려주고, 실패했는데도 저장된 것처럼 보이게 하지 않는다.
 */
function writeEnvelope(envelope: StoreEnvelope): SaveResult {
  if (!isStorageAvailable()) {
    return { ok: false, reason: i18n.t("reports.storage.noStorage") };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    return { ok: false, reason: i18n.t("reports.storage.serializeFailed") };
  }
  try {
    localStorage.setItem(ownedStorageKey(STORE_KEY), serialized);
    return { ok: true, revision: 0 };
  } catch (cause) {
    const isQuota =
      cause instanceof DOMException &&
      (cause.name === "QuotaExceededError" || cause.name === "NS_ERROR_DOM_QUOTA_REACHED" || cause.code === 22);
    return {
      ok: false,
      reason: isQuota
        ? i18n.t("reports.storage.quotaExceeded")
        : i18n.t("reports.storage.saveFailed"),
    };
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 저장된 Report 목록을 최근 수정 순으로 요약해 반환한다. */
export function listReportSummaries(): ReportSummary[] {
  const envelope = readEnvelope();
  return Object.values(envelope.reports)
    .map((report) => ({
      id: report.id,
      title: report.title,
      datasetId: report.datasetId,
      baseRunId: report.baseRunId,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** id로 Report 전체를 불러온다. 없으면 null. */
export function getReport(id: string): ReportDraft | null {
  if (!id) return null;
  return readEnvelope().reports[id] ?? null;
}

/**
 * Report를 저장한다(생성/수정 공용). 이미 저장된 revision보다 낮은 revision으로 저장을
 * 시도하면(다른 탭에서 먼저 저장한 경우) 기본적으로 거부한다 — 복잡한 3-way merge 대신
 * "먼저 저장한 내용을 보존하고 사용자에게 알린다"는 최소 안전 모델을 따른다(#258 §13).
 * `force: true`를 넘기면 그래도 덮어쓴다(사용자가 명시적으로 선택했을 때만 호출부가 사용).
 */
export function saveReport(report: ReportDraft, options: { force?: boolean } = {}): SaveResult {
  const envelope = readEnvelope();
  const existing = envelope.reports[report.id];

  if (existing && !options.force && existing.revision > report.revision) {
    return {
      ok: false,
      conflict: true,
      reason: i18n.t("reports.storage.staleWrite"),
    };
  }

  const keys = Object.keys(envelope.reports);
  if (!existing && keys.length >= REPORT_STORE_LIMIT) {
    return {
      ok: false,
      reason: i18n.t("reports.storage.limitExceeded", { limit: REPORT_STORE_LIMIT }),
    };
  }

  const nextRevision = (existing?.revision ?? 0) + 1;
  const toStore: ReportDraft = { ...report, revision: nextRevision, updatedAt: new Date().toISOString() };
  envelope.reports[report.id] = toStore;

  const result = writeEnvelope(envelope);
  if (!result.ok) return result;
  return { ok: true, revision: nextRevision };
}

/** 새 Report를 만들어 저장한다. 저장 실패 시 report는 반환하되 저장은 되지 않았음을 result로 알린다. */
export function createReport(
  input: Pick<ReportDraft, "title" | "datasetId" | "baseRunId" | "buildSpecDigest" | "evidenceFetchedAt" | "blocks" | "evidenceRefs">,
): { report: ReportDraft; result: SaveResult } {
  const now = new Date().toISOString();
  const report: ReportDraft = {
    id: newId(),
    title: input.title,
    datasetId: input.datasetId,
    baseRunId: input.baseRunId,
    buildSpecDigest: input.buildSpecDigest,
    createdAt: now,
    updatedAt: now,
    evidenceFetchedAt: input.evidenceFetchedAt,
    version: REPORT_VERSION,
    revision: 0,
    blocks: input.blocks,
    evidenceRefs: input.evidenceRefs,
  };
  const result = saveReport(report, { force: true });
  return { report: result.ok ? { ...report, revision: result.revision } : report, result };
}

/** 제목만 바꿔 저장한다. */
export function renameReport(id: string, title: string): SaveResult {
  const report = getReport(id);
  if (!report) return { ok: false, reason: i18n.t("reports.storage.notFound") };
  return saveReport({ ...report, title }, { force: true });
}

/** 기존 Report를 복제해 새 id로 저장한다(블록/evidence 전부 복사, 참조 공유 없음). */
export function duplicateReport(id: string, titleOverride?: string): { report: ReportDraft; result: SaveResult } | null {
  const source = getReport(id);
  if (!source) return null;
  const now = new Date().toISOString();
  const cloned: ReportDraft = {
    ...structuredClone(source),
    id: newId(),
    title: titleOverride ?? i18n.t("reports.storage.copyOf", { name: source.title }),
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
  const result = saveReport(cloned, { force: true });
  return { report: result.ok ? { ...cloned, revision: result.revision } : cloned, result };
}

/** id의 Report를 삭제한다. 존재하지 않았거나 저장소 사용 불가 시 false. */
export function deleteReport(id: string): boolean {
  if (!isStorageAvailable()) return false;
  const envelope = readEnvelope();
  if (!envelope.reports[id]) return false;
  delete envelope.reports[id];
  return writeEnvelope(envelope).ok;
}

/** 저장된 Report가 있는지 확인한다(빈 상태 안내용). */
export function hasAnyReport(): boolean {
  return Object.keys(readEnvelope().reports).length > 0;
}
