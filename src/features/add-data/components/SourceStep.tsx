/**
 * Add Data 1단계 — Source 선택 (#250).
 *
 * Prototype(`kpubdata_ui_prototype_v1.html`의 `addData()`/`source-card`)의 3-카드
 * 레이아웃을 그대로 따른다: Public API / File Upload / URL·REST API.
 */
import { useTranslation } from "react-i18next";
import type { SourceKind } from "@/shared/lib/types";
import { Card } from "@/shared/ui";

interface SourceOption {
  kind: SourceKind;
  title: string;
  /** 설명 문구의 i18n 키(`addData.source.kind.*`) — 상수에 문구를 박지 않는다(#350). */
  descriptionKey: string;
}

const SOURCE_OPTIONS: SourceOption[] = [
  { kind: "public_api", title: "Public API", descriptionKey: "publicApi" },
  { kind: "file", title: "File Upload", descriptionKey: "file" },
  { kind: "url", title: "URL / REST API", descriptionKey: "url" },
];

export interface SourceStepProps {
  selected: SourceKind | null;
  onSelect: (kind: SourceKind) => void;
}

export function SourceStep({ selected, onSelect }: SourceStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("addData.source.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("addData.source.desc")}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {SOURCE_OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            onClick={() => onSelect(option.kind)}
            aria-pressed={selected === option.kind}
            className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
          >
            <Card
              variant={selected === option.kind ? "success" : "default"}
              className="h-full transition hover:border-accent/50 hover:shadow-md"
            >
              <p className="text-base font-semibold tracking-tight">{option.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t(`addData.source.kind.${option.descriptionKey}`)}</p>
            </Card>
          </button>
        ))}
      </div>
    </div>
  );
}
