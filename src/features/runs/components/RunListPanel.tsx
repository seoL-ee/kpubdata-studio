/**
 * Builds master 패널 — run 목록·검색·상태 필터 (#379로 BuildsPage에서 분리).
 */
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/features/datasets/model";
import { buildStatusFilters } from "@/features/runs/buildContext";
import type { RunStatusFilter } from "@/features/runs/model";
import type { BuildListItem } from "@/shared/lib/types";
import type { AsyncState } from "@/features/runs/asyncState";
import {
  Card,
  EmptyState,
  ErrorState,
  Select,
  SkeletonTable,
  StatusBadge,
  TextInput,
} from "@/shared/ui";

export function RunListPanel({
  listState,
  visible,
  query,
  onQueryChange,
  statusFilter,
  onStatusFilterChange,
  selectedRunId,
  onSelect,
  onRetry,
  hiddenByFilter,
}: {
  listState: AsyncState<BuildListItem[]>;
  visible: BuildListItem[];
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: RunStatusFilter;
  onStatusFilterChange: (value: RunStatusFilter) => void;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRetry: () => void;
  hiddenByFilter: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <TextInput
          aria-label={t("builds.search.aria")}
          placeholder={t("builds.search.placeholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="flex-1"
        />
        <Select
          aria-label={t("builds.search.filterAria")}
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as RunStatusFilter)}
          className="sm:w-36"
        >
          {buildStatusFilters(t).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {hiddenByFilter ? (
        <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          {t("builds.search.outOfScope")}
        </p>
      ) : null}

      {listState.status === "loading" ? (
        <SkeletonTable rows={6} />
      ) : listState.status === "error" ? (
        <ErrorState title={t("builds.errors.loadList")} message={listState.error} onRetry={onRetry} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("builds.search.emptyTitle")} description={t("builds.search.emptyDesc")} />
      ) : (
        <ul className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: "70vh" }}>
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={item.id === selectedRunId ? "true" : undefined}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                  item.id === selectedRunId
                    ? "border-accent bg-accent-subtle"
                    : "border-transparent hover:border-border hover:bg-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{item.title ?? item.id}</span>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{item.id}</span>
                  <span>{formatDateTime(item.startedAt)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
