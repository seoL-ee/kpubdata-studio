/**
 * Report 블록의 출처(provenance)를 항상 눈에 보이게 표시하는 배지 (#258 §2, §10).
 *
 * Builder evidence/AI 해석/사용자 작성 내용을 시각적으로 구분해, 어떤 값이 정본이고
 * 어떤 값이 사람 또는 AI가 쓴 설명인지 색으로만이 아니라 텍스트로도 드러낸다.
 */
import { useTranslation } from "react-i18next";
import type { BlockProvenance } from "../types";

const META: Record<BlockProvenance, { labelKey: string; className: string }> = {
  BUILDER_EVIDENCE: {
    labelKey: "builder",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  KUBI_INTERPRETATION: {
    labelKey: "kubi",
    className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300",
  },
  USER_CONTENT: {
    labelKey: "user",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  },
};

export function ProvenanceBadge({ provenance, className }: { provenance: BlockProvenance; className?: string }) {
  const { t } = useTranslation();
  const meta = META[provenance];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className} ${className ?? ""}`}
    >
      {t(`reports.provenance.${meta.labelKey}`)}
    </span>
  );
}
