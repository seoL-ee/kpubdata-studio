/**
 * Selected Run의 structured event timeline(#496 evidence, #255 P1) 표시 컴포넌트.
 *
 * Builder 실제 계약 필드(timestamp/source_key/stage/event/status/message/metrics)만
 * 그대로 보여준다. Stage Progress(#488)/Quality(#486)의 정본을 대체하는 새 판정을 여기서
 * 만들지 않는다 — 이 컴포넌트는 오직 append-only event evidence를 chronological ascending
 * 그대로 렌더링할 뿐이다.
 */
import { useTranslation } from "react-i18next";
import { formatDateTime } from "@/features/datasets/model";
import { lastOkRunEvent, summarizeEventMetrics } from "@/features/runs/model";
import type { BuildEvent } from "@/shared/lib/builderApi";

const STATUS_STYLES: Record<BuildEvent["status"], string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  fail: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
};

function EventStatusBadge({ status }: { status: BuildEvent["status"] }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${STATUS_STYLES[status]}`}>
      {status.toUpperCase()}
    </span>
  );
}

/** multi-source run에서 event를 첫 source로 뭉개지 않고, source_key 없는(run 전체) event도 구분해 보여준다. */
function EventSourceLabel({ sourceKey }: { sourceKey: string | null }) {
  const { t } = useTranslation();
  if (sourceKey === null) {
    return <span className="font-mono text-xs text-muted-foreground">{t("runs.timeline.wholeRun")}</span>;
  }
  return <span className="font-mono text-xs">{sourceKey}</span>;
}

/**
 * @param events - chronological ascending(Builder 계약)으로 정렬된 event 목록.
 */
export function EventTimeline({ events }: { events: BuildEvent[] }) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">{t("runs.timeline.empty")}</p>;
  }

  const lastOk = lastOkRunEvent(events);

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="py-2 pr-3">{t("runs.timeline.time")}</th>
            <th className="py-2 pr-3">Source</th>
            <th className="py-2 pr-3">Stage</th>
            <th className="py-2 pr-3">{t("runs.timeline.event")}</th>
            <th className="py-2 pr-3">Message</th>
            <th className="py-2">Metrics</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const metricsSummary = summarizeEventMetrics(event.metrics);
            const isLastOk = lastOk !== null && event === lastOk;
            return (
              <tr
                key={`${event.seq}-${event.event}`}
                className={`border-b border-border last:border-0 ${
                  event.status === "fail" ? "bg-red-50 dark:bg-red-950/20" : ""
                }`}
              >
                <td className="whitespace-nowrap py-2 pr-3 align-top text-xs text-muted-foreground">
                  {formatDateTime(event.timestamp)}
                </td>
                <td className="py-2 pr-3 align-top">
                  <EventSourceLabel sourceKey={event.source_key ?? null} />
                </td>
                <td className="py-2 pr-3 align-top text-xs capitalize text-muted-foreground">
                  {event.stage ?? "—"}
                </td>
                <td className="py-2 pr-3 align-top">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs">{event.event}</span>
                    <EventStatusBadge status={event.status} />
                    {isLastOk ? (
                      <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent-subtle-foreground">
                        {t("runs.timeline.lastOk")}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="max-w-xs py-2 pr-3 align-top text-xs">
                  {event.message ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="max-w-xs py-2 align-top text-xs text-muted-foreground">
                  {metricsSummary ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
