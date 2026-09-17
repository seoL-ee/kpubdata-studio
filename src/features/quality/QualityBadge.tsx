import { useTranslation } from "react-i18next";
import type { QualityState, ValidationStatus } from "./model";

const STATUS_CLASS: Record<ValidationStatus, string> = {
  PASS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  WARN: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  FAIL: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  "N/A": "bg-muted text-muted-foreground",
};

export function QualityBadge({ status }: { status: ValidationStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[status]}`}>
      {status}
    </span>
  );
}

/**
 * Quality Center(#254)에서 쓰는 5상태 배지.
 *
 * `QualityBadge`(PASS/WARN/FAIL/N/A)는 #253에서 이미 검증된 단일-source 스코프 표시용이라
 * 그대로 두고, NOT_EVALUATED(평가 없음)와 UNAVAILABLE(availability=unavailable)을 N/A 하나로
 * 뭉개지 않아야 하는 화면(#254 §4)을 위해 별도 배지를 추가한다. 색상뿐 아니라 문구로도 구분한다.
 */
const STATE_CLASS: Record<QualityState, string> = {
  FAIL: STATUS_CLASS.FAIL,
  WARN: STATUS_CLASS.WARN,
  PASS: STATUS_CLASS.PASS,
  NOT_EVALUATED: "bg-muted text-muted-foreground",
  UNAVAILABLE: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const STATE_LABEL: Record<QualityState, string> = {
  FAIL: "FAIL",
  WARN: "WARN",
  PASS: "PASS",
  NOT_EVALUATED: "quality.badge.notEvaluated",
  UNAVAILABLE: "quality.badge.unavailable",
};

export function QualityStateBadge({ state }: { state: QualityState }) {
  const { t } = useTranslation();
  // PASS/WARN/FAIL은 Builder 어휘라 그대로 두고, 설명성 라벨만 번역한다.
  const label = STATE_LABEL[state].startsWith("quality.badge.") ? t(STATE_LABEL[state]) : STATE_LABEL[state];
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_CLASS[state]}`}>
      {label}
    </span>
  );
}
