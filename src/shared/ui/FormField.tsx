/**
 * 공통 FormField 컴포넌트.
 *
 * label + help 텍스트 + error 메시지를 일관되게 배치하고, 접근성을 위해 control에
 * 연결할 id와 aria-describedby를 계산해 render-prop으로 넘긴다(제안 §8/§12.3).
 *
 * 사용 예:
 *   <FormField id="datasetId" label="데이터셋 ID" help="예: kma-daily-observations"
 *              error={errors.datasetId?.message}>
 *     {(field) => <TextInput {...register("datasetId")} {...field} />}
 *   </FormField>
 */
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { ErrorMessage } from "./ErrorMessage";

export interface FormFieldRenderProps {
  /** control의 id (label htmlFor와 연결됨) */
  id: string;
  /** help/error id를 합친 aria-describedby 값(없으면 undefined) */
  "aria-describedby": string | undefined;
  /** 오류 여부 */
  invalid: boolean;
}

export interface FormFieldProps {
  /** control과 label을 연결할 기본 id */
  id: string;
  /** 필드 라벨(한국어) */
  label: string;
  /** 입력 형식 등 보조 설명 */
  help?: ReactNode;
  /** 검증 오류 메시지 */
  error?: ReactNode;
  /** 필수 표시(*) 여부 */
  required?: boolean;
  /** 계산된 접근성 속성을 받아 control을 렌더링하는 함수 */
  children: (field: FormFieldRenderProps) => ReactNode;
  /** 추가 className */
  className?: string;
}

/**
 * 라벨/도움말/오류와 접근성 속성이 연결된 폼 필드 래퍼를 렌더링한다.
 *
 * @param props - id/label/help/error/required/children.
 * @returns 폼 필드 엘리먼트.
 */
export function FormField({
  id,
  label,
  help,
  error,
  required,
  children,
  className,
}: FormFieldProps) {
  const { t } = useTranslation();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required ? (
          <>
            {/* 시각적 별표는 보조기기에서 숨기고, 스크린리더에는 '(필수)'를 읽어준다. */}
            <span aria-hidden="true" className="ml-0.5 text-red-600">
              *
            </span>
            <span className="sr-only">{t("formField.required")}</span>
          </>
        ) : null}
      </label>
      {children({ id, "aria-describedby": describedBy, invalid: Boolean(error) })}
      {help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      <ErrorMessage id={errorId}>{error}</ErrorMessage>
    </div>
  );
}
