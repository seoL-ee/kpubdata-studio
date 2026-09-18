/**
 * 개별 빌드 실행 정보 조회 API (#120, F02).
 *
 * mock 모드에서는 결정적 mock 이력이 전체 BuildSpec을 들고 있으므로 그대로 쓴다.
 *
 * 실연동 모드에서는 Builder current contract를 authoritative source로 쓴다:
 *  - BuildSpec: `GET /builds/{run_id}/spec` snapshot이 정본이다(다른 브라우저/CLI에서
 *    생성돼 localStorage에 스펙이 없어도 편집 가능). legacy run(snapshot 404)일 때만
 *    로컬 `specStore`로 fallback한다.
 *  - status: 절대 임의로 succeeded로 만들지 않는다. `GET /builds` 목록에 있으면 그
 *    terminal summary status를, 없으면 authoritative `GET /builds/{run_id}/manifest`의
 *    `status`(ok→succeeded / failed→failed / cancelled→cancelled)를 쓴다. 둘 다
 *    불가하면 succeeded/failed/cancelled를 추측하지 않고 명시적 오류로 처리한다.
 */
import { i18n } from "@/shared/i18n";
import { loadBuildSpec, redactSpecForStorage } from "@/features/build-spec/specStore";
import { fromYamlText } from "@/features/build-spec/yamlText";
import { ApiError, builderApi, isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { BuildListItem, BuildRun, BuildRunStatus, BuildSpec } from "@/shared/lib/types";
import { listBuilds, mockBuilds } from "./index";

/**
 * authoritative manifest의 `status`를 Studio BuildRunStatus로 매핑한다. `status` 필드가
 * 없는 legacy/partial manifest는 null(추측 금지).
 */
async function resolveManifestStatus(runId: string): Promise<BuildRunStatus | null> {
  try {
    const manifest = await builderApi.getBuildManifest(runId);
    switch (manifest.status) {
      case "ok":
        return "succeeded";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * buildId로 빌드 실행 정보를 조회한다.
 *
 * @param buildId - 조회할 빌드 ID(run_id).
 * @returns 빌드 실행 정보.
 * @throws Error 스펙 또는 상태를 authoritative하게 확인할 수 없는 경우.
 */
export async function getBuild(buildId: string): Promise<BuildRun> {
  if (!buildId) {
    throw new Error(i18n.t("runs.errors.missingId"));
  }

  const storedSpec = loadBuildSpec(buildId);

  // mock 모드: 결정적 mock 이력이 전체 BuildSpec을 들고 있으므로 그대로 활용한다.
  if (!isRealBuilderEnabled()) {
    const mockRun = mockBuilds().find((candidate) => candidate.id === buildId);
    if (mockRun) {
      return storedSpec ? { ...mockRun, spec: storedSpec } : mockRun;
    }
    if (storedSpec) {
      return { id: buildId, spec: storedSpec, status: "succeeded" as const, startedAt: "" };
    }
    throw new Error(i18n.t("runs.errors.notFound", { buildId }));
  }

  // --- 실연동 모드 ---

  // 1) BuildSpec: Builder snapshot이 authoritative. legacy(404)일 때만 로컬 fallback.
  let spec: BuildSpec | null = null;
  try {
    const snapshot = await builderApi.getBuildSpecSnapshot(buildId);
    // Builder가 redaction한 canonical YAML. 복원 시 storage 경계와 동일하게 한 번 더
    // 정규화해 secret-keyed 값이 인식 가능한 `[REDACTED]` marker가 되도록 한다 — 기존
    // S07 marker detection/fail-closed가 그대로 동작한다. raw credential은 복원하지 않는다.
    spec = redactSpecForStorage(fromYamlText(snapshot.spec));
  } catch (cause) {
    // snapshot이 legacy(404)일 때만 로컬 specStore로 내려간다. 권한/네트워크/파싱
    // 오류는 "정보 없음"으로 뭉개지 않고 그대로 노출한다.
    if (!(cause instanceof ApiError && cause.status === 404)) {
      throw cause;
    }
    if (storedSpec) {
      spec = storedSpec;
    }
  }

  if (!spec) {
    throw new Error(
      i18n.t("runs.errors.notFoundNoSpec", { buildId }),
    );
  }

  // 2) status: GET /builds 목록 > authoritative manifest.status > 명시적 오류.
  const items: BuildListItem[] = await listBuilds().catch(() => [] as BuildListItem[]);
  const item = items.find((candidate) => candidate.id === buildId);
  if (item) {
    return {
      id: buildId,
      spec,
      status: item.status,
      startedAt: item.startedAt ?? "",
      finishedAt: item.finishedAt ?? undefined,
    };
  }

  const manifestStatus = await resolveManifestStatus(buildId);
  if (manifestStatus) {
    return { id: buildId, spec, status: manifestStatus, startedAt: "", finishedAt: undefined };
  }

  throw new Error(
    i18n.t("runs.errors.statusUnknown", { buildId }),
  );
}
