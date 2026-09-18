/**
 * Add Data 2단계 — Configure (#250).
 *
 * source kind에 맞는 입력만 보여준다(Public API/File/URL). Dataset ID/제목/설명은
 * `AddDataPage`가 provider/dataset 선택·파일 업로드·URL 입력으로부터 자동 생성해
 * draft에 반영하므로(`features/add-data/identity.ts`), 이 컴포넌트는 그 결과를
 * "선택한 Dataset 요약"으로 보여주기만 한다 — 필수 수동 입력 폼으로 다시 요구하지
 * 않는다(#250 amendment 2). 자동 생성값을 고치고 싶을 때만 "고급 설정 · Dataset
 * metadata" collapsible을 연다. Output은 기존처럼 kind와 무관하게 항상 함께 보여준다.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { exportFormatSchema } from "@/shared/lib/schemas";
import { exampleParamsText, hasExampleParams, mergeExampleParams } from "@/features/add-data/requiredParams";
import { checkCredentialPrerequisite, credentialPrerequisiteMessage } from "@/features/add-data/credentialPrerequisite";
import { findDataset, findProvider } from "@/features/add-data/identity";
import type { AddDataDraft } from "@/features/add-data/model";
import type { SourceFormat } from "@/shared/lib/types";
import { Button, Card, FormField, Select, Textarea, TextInput } from "@/shared/ui";
import type { CatalogProvider } from "@/shared/lib/builderApi";

const EXPORT_FORMATS = exportFormatSchema.options;
const FILE_FORMATS: SourceFormat[] = ["csv", "json", "jsonl", "parquet"];
const URL_FORMATS = ["json", "jsonl", "csv"] as const;

export type CatalogState =
  | { status: "loading"; providers: readonly CatalogProvider[]; error?: undefined }
  | { status: "loaded"; providers: readonly CatalogProvider[]; error?: undefined }
  | { status: "error"; providers: readonly CatalogProvider[]; error: string };

export interface UploadState {
  status: "idle" | "uploading" | "done" | "error";
  error?: string;
}

export interface ConfigureStepProps {
  draft: AddDataDraft;
  updateDraft: (patch: Partial<AddDataDraft>) => void;
  catalog: CatalogState;
  upload: UploadState;
  onUploadFile: (file: File) => void;
  /** GET /providers 요약의 effective 구성 여부(provider -> configured). null = 아직 알 수 없음. */
  providerConfigured: Record<string, boolean> | null;
  /** "API 연결하기" CTA — draft를 저장하고 Provider 화면(returnTo=/add)으로 이동한다. */
  onConnectProvider: (provider: string) => void;
  specError?: string;
  yamlText: string;
  yamlEditError?: string;
  onApplyYaml: (text: string) => void;
}

export function ConfigureStep({
  draft,
  updateDraft,
  catalog,
  upload,
  onUploadFile,
  providerConfigured,
  onConnectProvider,
  specError,
  yamlText,
  yamlEditError,
  onApplyYaml,
}: ConfigureStepProps) {
  const { t } = useTranslation();
  const [editorMode, setEditorMode] = useState<"form" | "yaml">("form");
  const [yamlDraft, setYamlDraft] = useState(yamlText);

  const selectedDataset = findDataset(catalog.providers, draft.publicApi.provider, draft.publicApi.dataset);
  const requestParameters = selectedDataset?.request_parameters ?? [];
  const credentialPrerequisite = checkCredentialPrerequisite(
    selectedDataset,
    providerConfigured,
    draft.publicApi.provider,
  );
  const application = selectedDataset?.application ?? null;
  const prerequisiteMessage = credentialPrerequisiteMessage();
  // generic Provider probe는 임의의 첫 Dataset을 필수 파라미터 없이 호출하므로
  // "연결 성공 여부"로 쓰지 않는다(#S-provider-probe). authoritative prerequisite
  // (requires credential AND configured === false)만 사용하고, 실제 사용 가능
  // 여부는 Preview가 확인한다.
  const providerReady =
    !!selectedDataset?.requires_service_key &&
    providerConfigured?.[draft.publicApi.provider] === true;

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold tracking-tight">{t("addData.configure.title")}</h3>

      {draft.sourceKind === "public_api" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.apiPrepTitle")}</div>
            {catalog.status === "loading" ? (
              <p className="text-sm text-muted-foreground">{t("addData.configure.catalogLoading")}</p>
            ) : null}
            {catalog.status === "error" ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">{catalog.error}</p>
            ) : null}
            {catalog.status === "loaded" && catalog.providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("addData.configure.noProviders")}</p>
            ) : null}
            <FormField id="add-data-provider" label={t("addData.configure.providerLabel")}>
              {(field) => (
                <Select
                  {...field}
                  value={draft.publicApi.provider}
                  onChange={(e) => {
                    // canonical Provider selection이 실제로 바뀌면 기존 Dataset도
                    // 무효가 되므로, 같은 update에서 dataset과 이전 Dataset 전용
                    // 요청 파라미터까지 atomic하게 초기화한다(후행 effect에 의존하지
                    // 않는다 — #S-stale-params).
                    const nextProvider = e.target.value;
                    const providerChanged = nextProvider !== draft.publicApi.provider;
                    updateDraft({
                      publicApi: {
                        ...draft.publicApi,
                        provider: nextProvider,
                        dataset: "",
                        sourceParams: providerChanged ? "{}" : draft.publicApi.sourceParams,
                      },
                    });
                  }}
                >
                  <option value="">{t("addData.configure.providerSelect")}</option>
                  {catalog.providers.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField id="add-data-dataset" label={t("addData.configure.datasetLabel")}>
              {(field) => (
                <Select
                  {...field}
                  disabled={!draft.publicApi.provider}
                  value={draft.publicApi.dataset}
                  onChange={(e) => {
                    // 실제 다른 Dataset을 고르는 순간 이전 Dataset 전용 요청 파라미터를
                    // 같은 update에서 비운다 — 새 Dataset의 request_parameters 안내/
                    // 예시는 이 초기화된 값 위에서 렌더된다(#S-stale-params).
                    const nextDataset = e.target.value;
                    const datasetChanged = nextDataset !== draft.publicApi.dataset;
                    updateDraft({
                      publicApi: {
                        ...draft.publicApi,
                        dataset: nextDataset,
                        sourceParams: datasetChanged ? "{}" : draft.publicApi.sourceParams,
                      },
                    });
                  }}
                >
                  <option value="">{t("addData.configure.datasetSelect")}</option>
                  {findProvider(catalog.providers, draft.publicApi.provider)?.datasets.map((d) => (
                    <option key={d.name} value={d.name}>{d.title} ({d.name})</option>
                  ))}
                </Select>
              )}
            </FormField>
            {credentialPrerequisite.blocked ? (
              <Card variant="error" className="space-y-3">
                <p className="font-semibold">{prerequisiteMessage.title}</p>
                <p className="whitespace-pre-line text-sm">{prerequisiteMessage.body}</p>
                <Button size="sm" onClick={() => onConnectProvider(draft.publicApi.provider)}>
                  {prerequisiteMessage.cta}
                </Button>
              </Card>
            ) : providerReady ? (
              <Card variant="dashed" className="space-y-1 p-3 text-sm">
                <p className="font-semibold text-foreground">{t("addData.configure.authReady")}</p>
                <p className="text-muted-foreground">{t("addData.configure.authReadyDesc")}</p>
              </Card>
            ) : null}
          </div>

          <div className="space-y-4">
            <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.queryTitle")}</div>
            {selectedDataset ? (
              <Card variant="dashed" className="p-3 text-sm text-muted-foreground">
                {selectedDataset.description ?? t("addData.configure.noDesc")}
                {selectedDataset.tags.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {selectedDataset.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</span>
                    ))}
                  </div>
                ) : null}
              </Card>
            ) : null}
            {requestParameters.length > 0 ? (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <p className="font-semibold text-foreground">{t("addData.configure.paramsTitle")}</p>
                <ul className="mt-1.5 space-y-1">
                  {requestParameters.map((p) => (
                    <li key={p.name} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{p.name}</span>
                      {p.required ? (
                        <span className="ml-1 font-medium text-red-600 dark:text-red-400">{t("addData.configure.required")}</span>
                      ) : (
                        <span className="ml-1">{t("addData.configure.optional")}</span>
                      )}
                      {p.description ? <span> — {p.description}</span> : null}
                      {p.example ? <span className="ml-1 text-muted-foreground">{t("addData.configure.example", { value: p.example })}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {application?.required ? (
              <Card variant="dashed" className="space-y-2 p-3 text-xs">
                <p className="font-semibold text-foreground">{t("addData.configure.approvalTitle")}</p>
                <p className="text-muted-foreground">{t("addData.configure.approvalDesc")}</p>
                <a
                  href={application.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex text-sm font-medium text-accent-subtle-foreground underline underline-offset-2"
                >
                  {t("addData.configure.officialPage")}
                </a>
              </Card>
            ) : null}
            <FormField
              id="add-data-params"
              label={t("addData.configure.requestParamsLabel")}
              help={t("addData.configure.example", { value: exampleParamsText(requestParameters) })}
            >
              {(field) => (
                <div className="space-y-2">
                  {hasExampleParams(requestParameters) ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        updateDraft({
                          publicApi: {
                            ...draft.publicApi,
                            sourceParams: mergeExampleParams(draft.publicApi.sourceParams, requestParameters),
                          },
                        })
                      }
                    >
                      {t("addData.configure.applyExample")}
                    </Button>
                  ) : null}
                  <Textarea
                    {...field}
                    mono
                    rows={6}
                    value={draft.publicApi.sourceParams}
                    onChange={(e) => updateDraft({ publicApi: { ...draft.publicApi, sourceParams: e.target.value } })}
                  />
                </div>
              )}
            </FormField>
          </div>
        </div>
      ) : null}

      {draft.sourceKind === "file" ? (
        <div className="space-y-4">
          <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.fileUploadTitle")}</div>
          <FormField id="add-data-format" label={t("addData.configure.formatLabel")} required>
            {(field) => (
              <Select
                {...field}
                value={draft.file.format ?? ""}
                onChange={(e) => updateDraft({ file: { ...draft.file, format: (e.target.value || null) as SourceFormat | null } })}
              >
                <option value="">{t("addData.configure.formatSelect")}</option>
                {FILE_FORMATS.map((f) => (
                  <option key={f} value={f}>{f.toUpperCase()}</option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField id="add-data-encoding" label={t("addData.configure.encodingLabel")}>
            {(field) => (
              <TextInput
                {...field}
                value={draft.file.encoding}
                onChange={(e) => updateDraft({ file: { ...draft.file, encoding: e.target.value } })}
              />
            )}
          </FormField>
          <FormField id="add-data-file" label={t("addData.configure.fileLabel")} required>
            {(field) => (
              <input
                id={field.id}
                type="file"
                accept=".csv,.json,.jsonl,.parquet"
                disabled={!draft.file.format}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUploadFile(file);
                }}
                className="block w-full text-sm text-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-foreground"
              />
            )}
          </FormField>
          {!draft.file.format ? (
            <p className="text-xs text-muted-foreground">{t("addData.configure.formatFirst")}</p>
          ) : null}
          {upload.status === "uploading" ? <p className="text-sm text-muted-foreground">{t("addData.configure.uploading")}</p> : null}
          {upload.status === "error" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{upload.error}</p> : null}
          {upload.status === "done" && draft.file.uploadId ? (
            <p className="text-sm text-accent-subtle-foreground">
              {t("addData.configure.uploadDone", {
                name: draft.file.filename ?? draft.file.uploadId,
                bytes: draft.file.sizeBytes ?? 0,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {draft.sourceKind === "url" ? (
        <div className="space-y-4">
          <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.urlTitle")}</div>
          <FormField id="add-data-endpoint" label="Endpoint" required help={t("addData.configure.endpointHelp")}>
            {(field) => (
              <TextInput
                {...field}
                placeholder="https://api.example.org/data"
                value={draft.url.endpoint}
                onChange={(e) => updateDraft({ url: { ...draft.url, endpoint: e.target.value } })}
              />
            )}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="add-data-method" label={t("addData.configure.methodLabel")}>
              {(field) => <TextInput {...field} value="GET" readOnly disabled />}
            </FormField>
            <FormField id="add-data-auth" label={t("addData.configure.authLabel")}>
              {(field) => <TextInput {...field} value={t("addData.configure.authNone")} readOnly disabled />}
            </FormField>
          </div>
          <FormField id="add-data-url-format" label={t("addData.configure.urlFormatLabel")} help={t("addData.configure.urlFormatHelp")}>
            {(field) => (
              <Select
                {...field}
                value={draft.url.format ?? ""}
                onChange={(e) =>
                  updateDraft({ url: { ...draft.url, format: (e.target.value || null) as typeof draft.url.format } })
                }
              >
                <option value="">{t("addData.configure.urlFormatInfer")}</option>
                {URL_FORMATS.map((f) => (
                  <option key={f} value={f}>{f.toUpperCase()}</option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      ) : null}

      <div className="space-y-3 border-t border-border pt-4">
        <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.summaryTitle")}</div>
        {draft.datasetId || draft.title ? (
          <Card variant="dashed" className="space-y-1 p-3">
            <p className="text-sm font-semibold">{draft.title || t("addData.configure.noTitle")}</p>
            <p className="text-xs text-muted-foreground">ID: {draft.datasetId || "—"}</p>
            {draft.description ? <p className="text-xs text-muted-foreground">{draft.description}</p> : null}
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            {draft.sourceKind === "public_api"
              ? t("addData.configure.autoFillPublicApi")
              : draft.sourceKind === "file"
                ? t("addData.configure.autoFillFile")
                : t("addData.configure.autoFillUrl")}
          </p>
        )}

        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("addData.configure.advancedTitle")}
            <span className="text-base transition group-open:rotate-180" aria-hidden="true">⌄</span>
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="add-data-dataset-id" label={t("addData.configure.datasetIdLabel")}>
                {(field) => (
                  <TextInput
                    {...field}
                    value={draft.datasetId}
                    onChange={(e) => updateDraft({ datasetId: e.target.value, datasetIdTouched: true })}
                  />
                )}
              </FormField>
              <FormField id="add-data-title" label={t("addData.configure.titleLabel")}>
                {(field) => (
                  <TextInput
                    {...field}
                    value={draft.title}
                    onChange={(e) => updateDraft({ title: e.target.value, titleTouched: true })}
                  />
                )}
              </FormField>
            </div>
            <FormField id="add-data-description" label={t("addData.configure.descriptionLabel")}>
              {(field) => (
                <Textarea
                  {...field}
                  value={draft.description}
                  onChange={(e) => updateDraft({ description: e.target.value, descriptionTouched: true })}
                />
              )}
            </FormField>
          </div>
        </details>
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        <div className="section-title text-sm font-semibold text-muted-foreground">{t("addData.configure.outputTitle")}</div>
        <fieldset>
          <legend className="text-sm font-medium text-foreground">{t("addData.configure.exportLegend")}</legend>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {EXPORT_FORMATS.map((format) => (
              <label key={format} className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3">
                <input
                  type="checkbox"
                  checked={draft.exportFormats.includes(format)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.exportFormats, format]
                      : draft.exportFormats.filter((f) => f !== format);
                    updateDraft({ exportFormats: next });
                  }}
                  className="h-4 w-4 accent-emerald-600"
                />
                <span className="text-sm font-medium capitalize">{format}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormField id="add-data-output-path" label={t("addData.configure.outputPathLabel")}>
          {(field) => (
            <TextInput {...field} value={draft.outputPath} onChange={(e) => updateDraft({ outputPath: e.target.value })} />
          )}
        </FormField>
      </div>

      {specError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">{specError}</p>
      ) : null}

      <details className="group border-t border-border pt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("addData.configure.canonicalTitle")}
          <span className="text-base transition group-open:rotate-180" aria-hidden="true">⌄</span>
        </summary>
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <Button
              variant={editorMode === "form" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setEditorMode("form")}
            >
              Form
            </Button>
            <Button
              variant={editorMode === "yaml" ? "primary" : "secondary"}
              size="sm"
              onClick={() => {
                setYamlDraft(yamlText);
                setEditorMode("yaml");
              }}
            >
              YAML
            </Button>
          </div>
          {editorMode === "form" ? (
            <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
              <code>{yamlText}</code>
            </pre>
          ) : (
            <div className="space-y-2">
              <Textarea mono rows={14} value={yamlDraft} onChange={(e) => setYamlDraft(e.target.value)} />
              {yamlEditError ? (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">{yamlEditError}</p>
              ) : null}
              <Button size="sm" onClick={() => onApplyYaml(yamlDraft)}>{t("addData.configure.applyYaml")}</Button>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
