/**
 * 빌드 결과물 페이지 (/builds/:buildId/artifacts).
 *
 * manifest 요약, 다운로드 가능한 파일 목록, manifest 원본(JSON)을 보여준다(제안 §5.7, #30).
 *
 * manifest 요약/JSON은 `GET /builds/{run_id}/manifest`에서, **다운로드 파일 목록은
 * `GET /artifacts/{run_id}`**에서 따로 받는다. 두 호출은 독립적이라 한쪽 실패가 다른 쪽을
 * 막지 않는다. 다운로드는 `/artifacts/{run_id}` 목록이 준 canonical run-relative 경로만
 * 쓴다 — `manifest.outputs`는 output_root 절대 storage 경로라 다운로드 식별자로 못 쓴다.
 * 일부 legacy/partial 실행은 manifest에 메타데이터 필드가 없을 수 있으며, 그 경우에만
 * "일부 메타데이터가 없다"고 사실대로 안내한다. mock 모드에서는 결정적 fixture를 쓴다.
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  downloadArtifact,
  getBuildManifest,
  listArtifactFiles,
  saveBlobAsFile,
} from "@/features/artifacts/api";
import type { BuildManifest } from "@/shared/lib/types";
import { Button, Card, EmptyState, ErrorState, LinkButton, PageHeader, SkeletonTable } from "@/shared/ui";

interface ManifestState {
  status: "loading" | "loaded" | "error";
  manifest?: BuildManifest;
  error?: string;
}

type ArtifactsState =
  | { status: "loading" }
  | { status: "loaded"; files: string[] }
  | { status: "error"; error: string };

/** 파일 경로에서 표시용 이름과 형식(확장자)을 뽑는다. */
function describeFile(path: string): { name: string; format: string } {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return { name, format: dot >= 0 ? name.slice(dot + 1) : "—" };
}

type RowDownloadState =
  | { status: "idle" }
  | { status: "downloading" }
  | { status: "error"; message: string };

/**
 * artifact 파일 한 줄. `path`는 `GET /artifacts/{run_id}`가 준 canonical run-relative
 * POSIX 경로다. 다운로드는 exact run_id + 이 경로를 그대로 써서 인증된 Builder 요청
 * (`downloadArtifact`)으로 받아 Blob으로 저장한다. 다운로드 중에는 버튼을 비활성화해
 * 중복 클릭을 막고, 실패는 이 row에만 표시한다 — 페이지 전체를 실패 상태로 만들지 않는다.
 */
function ArtifactRow({ runId, path }: { runId: string; path: string }) {
  const { t } = useTranslation();
  const { name, format } = describeFile(path);
  const [state, setState] = useState<RowDownloadState>({ status: "idle" });

  const onDownload = useCallback(() => {
    if (state.status === "downloading") return;
    setState({ status: "downloading" });
    downloadArtifact(runId, path)
      .then(({ blob, filename }) => {
        saveBlobAsFile(blob, filename);
        setState({ status: "idle" });
      })
      .catch((cause: unknown) => {
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : i18n.t("artifacts.errors.download"),
        });
      });
  }, [runId, path, state.status]);

  return (
    <li className="grid grid-cols-[1.6fr_0.6fr_0.8fr] items-center gap-4 border-b border-border px-6 py-3 text-sm last:border-0">
      <span className="break-all font-medium">{name}</span>
      <span className="uppercase text-muted-foreground">{format}</span>
      <span className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          variant="secondary"
          loading={state.status === "downloading"}
          disabled={state.status === "downloading"}
          onClick={onDownload}
        >
          {t("artifacts.files.download")}
        </Button>
        {state.status === "error" ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.message}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * 빌드가 생성한 결과물과 manifest 요약을 보여주는 페이지.
 *
 * @returns 결과물 화면.
 */
export function BuildArtifactsPage() {
  const { t } = useTranslation();
  const { buildId = "" } = useParams();
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const [artifacts, setArtifacts] = useState<ArtifactsState>({ status: "loading" });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    setArtifacts({ status: "loading" });
    getBuildManifest(buildId, controller.signal)
      .then((manifest) => {
        if (!controller.signal.aborted) setState({ status: "loaded", manifest });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("artifacts.errors.manifest"),
        });
      });
    // 다운로드 가능한 파일 목록은 canonical `GET /artifacts/{run_id}`에서 별도로 받는다
    // (manifest.outputs는 storage 절대경로라 다운로드 식별자로 못 쓴다). manifest 로드와
    // 독립적이라 한쪽 실패가 다른 쪽을 막지 않는다.
    listArtifactFiles(buildId, controller.signal)
      .then((files) => {
        if (!controller.signal.aborted) setArtifacts({ status: "loaded", files });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setArtifacts({
          status: "error",
          error: cause instanceof Error ? cause.message : i18n.t("artifacts.errors.files"),
        });
      });
    return () => controller.abort();
  }, [buildId]);

  useEffect(() => load(), [load]);

  const manifest = state.manifest;
  // outputs가 undefined이면 formats도 undefined로, 빈 배열이면 빈 배열로 상태를 보존 (#119)
  const formats = manifest?.outputs
    ? [...new Set(manifest.outputs.map((path) => describeFile(path).format))]
    : manifest?.outputs ?? undefined;
  // Builder는 소스별 row_counts(dict)를 주므로 UI 요약에서는 합계로 보여준다.
  // row_counts가 제공되지 않으면(undefined) 레코드 수를 "미제공"으로 표시한다.
  const totalRecords = manifest?.row_counts
    ? Object.values(manifest.row_counts).reduce((sum, count) => sum + count, 0)
    : undefined;
  // legacy/partial manifest 안내용: 일부 실행은 manifest에 메타데이터 필드가 없다.
  const hasMetadata =
    manifest?.row_counts !== undefined && manifest?.provenance !== undefined;

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("artifacts.page.eyebrow")}
        title={t("artifacts.page.title", { build: buildId || "Build" })}
        description={t("artifacts.page.desc")}
        actions={<LinkButton to={`/builds/${buildId}/publish`}>{t("artifacts.page.publish")}</LinkButton>}
      />

      {state.status === "loading" ? (
        <Card className="p-0">
          <SkeletonTable rows={4} />
        </Card>
      ) : null}

      {state.status === "error" ? (
        <Card variant="error" className="p-0">
          <ErrorState
            title={t("artifacts.errors.loadTitle")}
            message={state.error}
            onRetry={() => load()}
          />
        </Card>
      ) : null}

      {state.status === "loaded" && manifest ? (
        <>
          <Card>
            <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("artifacts.manifest.summary")}
            </p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{t("artifacts.manifest.records")}</dt>
                <dd className="text-foreground">
                  {totalRecords !== undefined
                    ? totalRecords.toLocaleString("ko-KR")
                    : i18n.t("artifacts.manifest.notProvided")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("artifacts.manifest.formats")}</dt>
                <dd className="text-foreground">
                  {formats === undefined
                    ? t("buildArtifacts.notProvided")
                    : formats.length > 0
                      ? formats.join(", ")
                      : t("buildArtifacts.noExports")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("artifacts.manifest.sources")}</dt>
                <dd className="text-foreground">
                  {manifest.provenance === undefined
                    ? t("buildArtifacts.notProvided")
                    : manifest.provenance.length > 0
                      ? manifest.provenance.map((p) => `${p.provider}.${p.dataset}`).join(", ")
                      : t("buildArtifacts.noSources")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("artifacts.manifest.buildId")}</dt>
                <dd className="break-all text-foreground">{manifest?.build_id || i18n.t("artifacts.manifest.notProvided")}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-0">
            <div className="grid grid-cols-[1.6fr_0.6fr_0.8fr] gap-4 border-b border-border px-6 py-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{t("artifacts.files.title")}</span>
              <span>{t("artifacts.files.format")}</span>
              <span>{t("artifacts.files.action")}</span>
            </div>
            {artifacts.status === "loading" ? (
              <SkeletonTable rows={4} />
            ) : artifacts.status === "error" ? (
              <EmptyState title={t("artifacts.errors.files")} description={artifacts.error} />
            ) : artifacts.files.length === 0 ? (
              <EmptyState title={t("artifacts.files.emptyTitle")} />
            ) : (
              <ul>
                {artifacts.files.map((path) => (
                  <ArtifactRow key={path} runId={buildId} path={path} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              manifest.json
            </p>
            {!hasMetadata && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {t("buildArtifacts.partialManifest")}
              </p>
            )}
            <pre className="mt-4 overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
              <code>{JSON.stringify(manifest, null, 2)}</code>
            </pre>
          </Card>
        </>
      ) : null}
    </main>
  );
}
