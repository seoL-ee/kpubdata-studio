/**
 * 공통 ErrorState 컴포넌트 (제안 §11).
 *
 * "오류 원인 + 다시 시도" 구조로 에러 상태를 일관되게 표현한다. role="alert"로 보조기기에
 * 즉시 안내하고, onRetry가 있으면 재시도 버튼을 노출한다.
 */
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface ErrorStateProps {
  /** 오류 제목 */
  title?: string;
  /** 오류 원인/설명 */
  message?: ReactNode;
  /** 재시도 핸들러(있으면 버튼 노출) */
  onRetry?: () => void;
  /** 재시도 버튼 라벨 */
  retryLabel?: string;
  /** 추가 className */
  className?: string;
}

/**
 * 오류 원인과 (선택적) 재시도 버튼을 보여준다.
 *
 * @param props - title/message/onRetry/retryLabel.
 * @returns 에러 상태 엘리먼트.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel,
  className,
}: ErrorStateProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("errorState.title");
  const resolvedRetry = retryLabel ?? t("errorState.retry");
  return (
    <div role="alert" className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      <p className="text-lg font-medium tracking-tight text-red-700 dark:text-red-300">{resolvedTitle}</p>
      {message ? (
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          {message}
        </p>
      ) : null}
      {onRetry ? (
        <div className="mt-6">
          <Button variant="secondary" onClick={onRetry}>
            {resolvedRetry}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
