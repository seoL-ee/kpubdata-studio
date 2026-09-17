/**
 * 공통 StatusBadge 컴포넌트.
 *
 * draft/run/publish 흐름의 모든 상태값을 한국어 라벨 + 일관된 색상으로 표시한다.
 * 색상만으로 의미를 전달하지 않도록 항상 텍스트 라벨을 함께 노출한다(접근성).
 */
import { cn } from "./cn";
import { useTranslation } from "react-i18next";

/** Studio 전반에서 배지로 표시 가능한 모든 상태값의 합집합 */
export type StatusValue =
  | "new"
  | "draft"
  | "dirty"
  | "validated"
  | "invalid"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "publishing"
  | "published";

interface StatusMeta {
  /** 라벨 i18n 키(`status.*`). 상수에 문구를 박으면 언어 전환이 반영되지 않는다(#350). */
  labelKey: string;
  /** Tailwind 색상 클래스 */
  className: string;
}

const STATUS_META: Record<StatusValue, StatusMeta> = {
  new: { labelKey: "new", className: "bg-muted text-muted-foreground" },
  draft: { labelKey: "draft", className: "bg-muted text-muted-foreground" },
  dirty: { labelKey: "dirty", className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  validated: { labelKey: "validated", className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300" },
  invalid: { labelKey: "invalid", className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  queued: { labelKey: "queued", className: "bg-muted text-muted-foreground" },
  running: { labelKey: "running", className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300" },
  cancelling: { labelKey: "cancelling", className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  succeeded: { labelKey: "succeeded", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
  failed: { labelKey: "failed", className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  cancelled: { labelKey: "cancelled", className: "bg-muted text-muted-foreground" },
  publishing: { labelKey: "publishing", className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300" },
  published: { labelKey: "published", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
};

/** 알 수 없는 상태값에 사용할 중립 배지 스타일 */
const FALLBACK_META: StatusMeta = {
  labelKey: "",
  className: "bg-muted text-muted-foreground",
};

export interface StatusBadgeProps {
  /**
   * 표시할 상태값.
   *
   * 알려진 `StatusValue`면 해당 라벨/색상으로, 그 외 임의 문자열이면 원본 라벨을 가진
   * 중립 배지로 안전하게 표시한다(매핑 누락 시 크래시 방지).
   */
  status: StatusValue | (string & {});
  /** 추가 className */
  className?: string;
}

/**
 * 상태값에 대응하는 라벨(현재 언어)과 색상을 가진 배지를 렌더링한다.
 *
 * 알 수 없는 상태값은 원본 문자열을 라벨로 사용하는 중립 배지로 폴백한다.
 *
 * @param props - status와 추가 className.
 * @returns 상태 배지 엘리먼트.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const known = STATUS_META[status as StatusValue] as StatusMeta | undefined;
  const meta = known ?? FALLBACK_META;
  // 알 수 없는 상태값은 번역하지 않고 원문을 그대로 보여준다(매핑 누락 시 크래시 방지).
  const label = known ? t(`status.${known.labelKey}`) : status;
  const isLive = status === "running" || status === "publishing" || status === "cancelling";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        meta.className,
        className,
      )}
    >
      {isLive ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  );
}
