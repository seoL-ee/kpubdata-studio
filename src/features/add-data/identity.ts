/**
 * Dataset identity 자동 생성 (#250 amendment 2).
 *
 * Public API/File/URL 세 source kind 모두에서 사용자가 매번 Dataset ID/제목/설명을
 * 직접 입력하지 않도록, 이미 선택/입력한 정보(catalog dataset, 파일명, endpoint)로부터
 * deterministic한 기본값을 만든다. 여기서 만드는 값은 어디까지나 "기본값"이며, 사용자는
 * 고급 설정(Dataset metadata)에서 언제든 덮어쓸 수 있다 — draft의 `*Touched` 플래그가
 * 그 이후로는 자동 생성이 값을 덮어쓰지 않도록 막는다(`AddDataPage`의 자동 반영 effect 참고).
 *
 * BuildSpec이 dataset_id/title/description을 요구한다는 사실 자체는 바뀌지 않는다 —
 * 바뀌는 것은 "누가 그 값을 채우는가"뿐이다.
 */
import { i18n } from "@/shared/i18n";
import type { CatalogDataset, CatalogProvider } from "@/shared/lib/builderApi";

export function findProvider(providers: readonly CatalogProvider[], name: string): CatalogProvider | undefined {
  return providers.find((p) => p.name === name);
}

export function findDataset(
  providers: readonly CatalogProvider[],
  provider: string,
  dataset: string,
): CatalogDataset | undefined {
  return findProvider(providers, provider)?.datasets.find((d) => d.name === dataset);
}

/** dataset_id로 쓰기에 안전한 slug. 영문/숫자/한글만 남기고 나머지는 `-`로 치환한다. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "dataset";
}

/** 여러 조각을 `-`로 이어붙인 뒤 slug화한다(provider+dataset name 조합 등). */
export function datasetIdFromParts(...parts: string[]): string {
  return slugify(parts.filter(Boolean).join("-"));
}

/** "my-file_name" → "My File Name" 처럼 파일명/경로 조각을 사람이 읽기 쉬운 제목으로 바꾼다. */
function humanize(base: string): string {
  const spaced = base.replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ");
  if (!spaced) return base;
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface DatasetIdentity {
  datasetId: string;
  title: string;
  description: string;
}

/**
 * Public API: catalog에서 선택한 provider/dataset으로부터 identity를 만든다.
 *
 * dataset_id는 provider+dataset name 기반 deterministic slug, title/description은
 * catalog dataset의 값을 그대로 쓴다(Prototype 등 illustrative 값이 아니라 실제 Builder
 * catalog 응답을 정본으로 삼는다).
 */
export function identityFromCatalog(provider: string, dataset: CatalogDataset): DatasetIdentity {
  return {
    datasetId: datasetIdFromParts(provider, dataset.name),
    title: dataset.title,
    // BuildSpec.description은 필수 필드다 — catalog가 description을 안 주면(null),
    // 값을 지어내지 않고 provider/dataset 출처만 서술하는 factual한 기본값을 쓴다.
    description: dataset.description ?? i18n.t("addData.identity.fromCatalog", { provider, name: dataset.name }),
  };
}

/**
 * File: 업로드한 파일명(확장자 제외)에서 dataset_id/title을 만든다.
 *
 * BuildSpec.description은 필수 필드라(`buildSpecSchema`) 빈 값으로 둘 수 없다 — 파일
 * source에는 사람이 지어낸 설명이 없으므로, 업로드 사실 자체를 서술하는 factual한
 * 문장을 기본값으로 준다(고급 설정에서 언제든 고쳐 쓸 수 있다).
 */
export function identityFromFilename(filename: string): DatasetIdentity {
  const base = filename.replace(/\.[^./\\]+$/, "");
  const title = humanize(base) || filename;
  return { datasetId: slugify(base), title, description: i18n.t("addData.identity.fromFile", { filename }) };
}

/**
 * URL: endpoint의 hostname+path만으로 dataset_id/title을 만든다.
 *
 * 주의: `new URL(endpoint)`가 만드는 URL 객체 "자체"는 `username`/`password`/`search`/
 * `hash`를 그대로 보존한다(`user:pass@host`, `?token=...`, `#frag` 모두 읽을 수 있다) —
 * "URL 객체가 credential/query를 담지 않는다"는 말은 틀렸다. 여기서 안전한 이유는
 * identity를 만들 때 그 객체에서 `hostname`/`pathname` 두 속성만 allowlist 방식으로
 * 골라 쓰고 나머지(username/password/search/hash)는 절대 읽지 않기 때문이다. description도
 * 같은 이유(BuildSpec 필수 필드)로 endpoint 사실을 서술하는 기본값을 준다.
 */
export function identityFromUrl(endpoint: string): DatasetIdentity {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    const base = `${url.hostname}${path}`;
    const title = humanize(base) || url.hostname;
    // description도 query string/credential이 없는 hostname+path만 사용한다(base) —
    // endpoint 원문을 그대로 쓰면 token 같은 값이 새어 들어갈 수 있다.
    return { datasetId: slugify(base), title, description: i18n.t("addData.identity.fromUrl", { host: base }) };
  } catch {
    return { datasetId: "", title: "", description: "" };
  }
}
