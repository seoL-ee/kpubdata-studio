/**
 * Kubi 참고 노트 큐 → Report 반영 승인 패널 (#258 §7).
 *
 * `features/kubi/reportInbox.ts`(#256)에 쌓인, 사용자가 Kubi 채팅에서 이미 한 번
 * 승인한 노트를 보여준다. 여기서 다시 한번: note 원문 → 연결 evidence(문맥) →
 * 현재 Report의 기준 dataset/run과 같은지 → 사용자 승인 순서를 거친 뒤에만 Report에
 * KUBI_INTERPRETATION 블록으로 추가한다. 자동으로 추가되지 않는다.
 */
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { listKubiReportNotes, removeKubiReportNote, type KubiReportNote } from "@/features/kubi/reportInbox";
import { Card, EmptyState } from "@/shared/ui";
import { noteMatchesReportContext, reportNoteToBlock } from "../kubiBlocks";
import type { KubiInterpretationBlock, ReportDraft } from "../types";

export function KubiInboxPanel({
  report,
  onApprove,
  onNotesChanged,
}: {
  report: Pick<ReportDraft, "datasetId" | "baseRunId">;
  onApprove: (block: KubiInterpretationBlock) => void;
  /** 승인/무시로 큐가 바뀔 때마다 호출된다(Report Context sidebar의 대기 노트 수 갱신용). */
  onNotesChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<KubiReportNote[]>([]);

  useEffect(() => {
    setNotes(listKubiReportNotes());
  }, []);

  function approve(note: KubiReportNote) {
    onApprove(reportNoteToBlock(note, report));
    removeKubiReportNote(note);
    setNotes(listKubiReportNotes());
    onNotesChanged?.();
  }

  function discard(note: KubiReportNote) {
    removeKubiReportNote(note);
    setNotes(listKubiReportNotes());
    onNotesChanged?.();
  }

  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("reports.kubiInbox.title")}</p>
      {notes.length === 0 ? (
        <EmptyState
          className="py-6"
          title={t("reports.kubiInbox.emptyTitle")}
          description={t("reports.kubiInbox.emptyDesc")}
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {notes.map((note, index) => {
            const sameContext = noteMatchesReportContext(note, report);
            return (
              <li key={`${note.savedAt}-${index}`} className="rounded-lg border border-border p-3 text-sm">
                <p className="text-foreground">{note.note}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[note.context.datasetId, note.context.runId, note.context.stage].filter(Boolean).join(" · ") ||
                    t("reports.kubiInbox.noContext")}
                  {" · "}
                  {new Date(note.savedAt).toLocaleString("ko-KR")}
                </p>
                <p
                  className={`mt-1 text-xs font-medium ${sameContext ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}
                >
                  {sameContext ? t("reports.kubiInbox.sameContext") : t("reports.kubiInbox.otherContext")}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => approve(note)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    {t("reports.kubiInbox.add")}
                  </button>
                  <button
                    type="button"
                    onClick={() => discard(note)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                  >
                    {t("reports.kubiInbox.dismiss")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
