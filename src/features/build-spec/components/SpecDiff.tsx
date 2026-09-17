/**
 * 두 BuildSpec의 차이를 시각적으로 보여주는 컴포넌트 (#13, v0.3 MVP).
 *
 * diffSpecs 결과를 추가(초록)/삭제(빨강)/변경(노랑) 행으로 렌더링한다. 변경 없으면
 * "차이 없음" 안내를 보여준다.
 */
import { diffSpecs, type SpecChangeKind } from "@/features/build-spec/specDiff";
import type { BuildSpec } from "@/shared/lib/types";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/shared/ui";

const KIND_META: Record<SpecChangeKind, { labelKey: string; className: string; sign: string }> = {
  added: {
    labelKey: "added",
    className: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    sign: "+",
  },
  removed: {
    labelKey: "removed",
    className: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    sign: "−",
  },
  changed: {
    labelKey: "changed",
    className: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    sign: "~",
  },
};

export interface SpecDiffProps {
  /** 이전 스펙 */
  before: BuildSpec;
  /** 이후 스펙 */
  after: BuildSpec;
}

/**
 * 두 스펙의 필드 단위 차이를 목록으로 렌더링한다.
 *
 * @param props - before/after 스펙.
 * @returns 스펙 diff 엘리먼트.
 */
export function SpecDiff({ before, after }: SpecDiffProps) {
  const { t } = useTranslation();
  const changes = diffSpecs(before, after);

  if (changes.length === 0) {
    return <EmptyState title={t("specDiff.noDiff")} />;
  }

  return (
    <ul className="divide-y divide-border">
      {changes.map((change) => {
        const meta = KIND_META[change.kind];
        return (
          <li key={change.path} className="flex flex-wrap items-center gap-3 px-1 py-2 text-sm">
            <span
              className={`inline-flex w-12 justify-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
            >
              {meta.sign} {t(`specDiff.${meta.labelKey}`)}
            </span>
            <span className="font-mono text-foreground">{change.path}</span>
            <span className="text-muted-foreground">
              {change.kind === "changed" ? (
                <>
                  <span className="line-through">{change.before}</span> → {change.after}
                </>
              ) : change.kind === "added" ? (
                change.after
              ) : (
                <span className="line-through">{change.before}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
