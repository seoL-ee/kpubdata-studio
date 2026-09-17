/**
 * USER_CONTENT 블록 추가/편집 폼 (#258 §10).
 *
 * Builder evidence 블록과 섞이지 않도록 항상 별도 블록으로만 저장한다. 여기서 입력한
 * 원문은 저장 시 그대로 markdown으로 보관되고, 렌더링은 항상 `markdown.ts`의 안전
 * 렌더러를 거친다(에디터 자체는 plain textarea이므로 입력 단계에서 스크립트가 실행될
 * 여지가 없다).
 */
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Button, Textarea, TextInput } from "@/shared/ui";

export function UserContentEditor({
  initialHeading = "",
  initialMarkdown = "",
  onSave,
  onCancel,
}: {
  initialHeading?: string;
  initialMarkdown?: string;
  onSave: (heading: string, markdown: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [heading, setHeading] = useState(initialHeading);
  const [markdown, setMarkdown] = useState(initialMarkdown);

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-border p-4">
      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="user-block-heading">
          {t("reports.userEditor.heading")}
        </label>
        <TextInput
          id="user-block-heading"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          placeholder={t("reports.userEditor.headingPlaceholder")}
          className="mt-1"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="user-block-markdown">
          {t("reports.userEditor.body")}
        </label>
        <Textarea
          id="user-block-markdown"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          rows={6}
          placeholder={t("reports.userEditor.bodyPlaceholder")}
          className="mt-1"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t("reports.userEditor.cancel")}
        </Button>
        <Button
          onClick={() => onSave(heading.trim() || t("reports.userEditor.untitled"), markdown)}
          disabled={markdown.trim().length === 0}
        >
          {t("reports.userEditor.save")}
        </Button>
      </div>
    </div>
  );
}
