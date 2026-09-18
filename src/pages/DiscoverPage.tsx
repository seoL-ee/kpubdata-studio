/**
 * Discover 화면 (`/discover`, #249).
 *
 * Builder 원천 provider/dataset 카탈로그(`GET /catalog`)를 정확 검색·필터로 탐색하고,
 * 선택한 항목을 Add Data Workbench(`/add`, #250)로 넘긴다. 자연어 검색(Kubi, #256)이나
 * 이미 빌드된 데이터셋 목록(Dataset Catalog, `/datasets`, #253)과는 다른 화면이다 —
 * `/catalog`(원본)와 `/datasets`(빌드 결과)를 섞지 않는다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useNavigate, useSearchParams } from "react-router-dom";
import { loadCatalog } from "@/features/discover/api";
import {
  computeProviderCounts,
  computeServiceKeyCount,
  flattenCatalog,
  matchesProviderFilter,
  matchesQuery,
  matchesServiceKeyFilter,
  uniqueProviders,
  type DiscoverEntry,
} from "@/features/discover/model";
import { providerLabel } from "@/shared/lib/providerLabels";
import { Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, TextInput } from "@/shared/ui";

interface CatalogState {
  status: "loading" | "loaded" | "error";
  entries?: DiscoverEntry[];
  error?: string;
}

const selectClassName =
  "h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DiscoverPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<CatalogState>({ status: "loading" });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadCatalog(controller.signal)
      .then((catalog) => setState({ status: "loaded", entries: flattenCatalog(catalog) }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("discover.errors.catalog"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  const query = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const onlyRequiresKey = searchParams.get("key") === "1";

  function updateParam(name: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next);
  }

  const entries = state.entries ?? [];
  const providerOptions = useMemo(() => uniqueProviders(entries), [entries]);
  const providerCounts = useMemo(() => computeProviderCounts(entries), [entries]);
  const serviceKeyCount = useMemo(() => computeServiceKeyCount(entries), [entries]);

  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          matchesQuery(entry, query) &&
          matchesProviderFilter(entry, provider) &&
          matchesServiceKeyFilter(entry, onlyRequiresKey),
      ),
    [entries, query, provider, onlyRequiresKey],
  );

  function startWithDataset(entry: DiscoverEntry) {
    navigate(`/add?provider=${encodeURIComponent(entry.provider)}&dataset=${encodeURIComponent(entry.dataset.name)}`);
  }

  const hasActiveFilters = Boolean(query || provider || onlyRequiresKey);

  return (
    <main className="flex flex-1 flex-col gap-5 px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
      <PageHeader
        eyebrow="Discover"
        title={t("discover.page.title")}
        description={t("discover.page.desc")}
      />

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1 lg:max-w-[390px]">
            <label htmlFor="discover-search" className="sr-only">
              {t("discover.searchLabel")}
            </label>
            <TextInput
              id="discover-search"
              placeholder={t("discover.searchLabel")}
              value={query}
              onChange={(event) => updateParam("q", event.target.value)}
            />
          </div>
          <label className="min-w-56 flex-1 sm:flex-none">
            <span className="sr-only">Provider</span>
            <select
              aria-label="Provider"
              className={`w-full ${selectClassName}`}
              value={provider}
              onChange={(event) => updateParam("provider", event.target.value)}
            >
              <option value="">{t("discover.allProviders", { count: entries.length })}</option>
              {providerOptions.map((item) => (
                <option key={item} value={item}>
                  {t("discover.providerOption", { label: providerLabel(item), count: providerCounts.get(item) ?? 0 })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={onlyRequiresKey}
              onChange={(event) => updateParam("key", event.target.checked ? "1" : "")}
            />
            {t("discover.serviceKeyOnly", { count: serviceKeyCount })}
          </label>
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={() => setSearchParams({})} className="ml-auto">
              {t("discover.resetFilters")}
            </Button>
          ) : null}
        </div>

        {state.status === "loading" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-32 w-full rounded-xl" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <ErrorState title={t("discover.errors.catalogTitle")} message={state.error} onRetry={load} />
        ) : entries.length === 0 ? (
          <EmptyState
            title={t("discover.empty.title")}
            description={t("discover.empty.desc")}
          />
        ) : visibleEntries.length === 0 ? (
          <EmptyState title={t("discover.noMatch.title")} description={t("discover.noMatch.desc")} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleEntries.map((entry) => (
              <Card key={`${entry.provider}/${entry.dataset.name}`} variant="elevated" className="flex flex-col gap-3">
                <div>
                  <p className="font-semibold text-foreground">{entry.dataset.title}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{entry.dataset.name}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-0.5">{providerLabel(entry.provider)}</span>
                  {entry.dataset.requires_service_key ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                      {t("discover.serviceKeyBadge")}
                    </span>
                  ) : null}
                </div>
                <Button size="sm" onClick={() => startWithDataset(entry)} className="mt-auto">
                  {t("discover.startWith")}
                </Button>
              </Card>
            ))}
          </div>
        )}

        {state.status === "loaded" ? (
          <p className="text-xs text-muted-foreground">{t("discover.shownCount", { count: visibleEntries.length })}</p>
        ) : null}
      </Card>
    </main>
  );
}
