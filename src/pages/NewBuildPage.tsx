/**
 * 새 빌드 작성 마법사(New Build Wizard) 화면.
 *
 * 단일 폼 대신 단계별 Stepper로 안내한다(제안 §5.2): 기본 정보 → 데이터 소스 →
 * 파라미터 → 미리보기 → 출력 형식 → 검증·실행. React Hook Form으로 입력을 관리하고
 * 각 단계 진행 전에 해당 단계 필드만 검증한다. Preview/Validate는 독립 페이지가 아니라
 * 마법사 내부 단계로 통합되어 있다(§5.3/§5.4).
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useParams, useSearchParams } from "react-router-dom";
import { clearDraft, hasDraft, loadDraft, saveDraft } from "@/features/build-spec/draftStorage";
import { previewBuild } from "@/features/preview/api";
import { useBuild } from "@/features/runs/useBuild";
import { useBuildJob } from "@/features/runs/useBuildJob";
import { validateSpec } from "@/features/validation/api";
import { createSavedSpec, getSavedSpec } from "@/features/workspace/savedSpecs";
import type { SavedSpecValidation } from "@/features/workspace/types";
import { builderApi } from "@/shared/lib/builderApi";
import { providerLabel } from "@/shared/lib/providerLabels";
import { buildFormValuesSchema } from "@/shared/lib/schemas";
import type { BuildSpec } from "@/shared/lib/types";
import { Button, Card, PageHeader, StatusBadge, Stepper } from "@/shared/ui";

import {
  buildSteps,
  catalogProvider,
  initialValues,
  redactDraftForStorage,
  toBuildSpec,
  toFormValues,
  STEP_FIELDS,
  type BuildFormValues,
  type CatalogState,
  type PreviewState,
  type ValidationState,
} from "@/features/build-spec/newBuildModel";
import type { BuildTemplate } from "@/features/build-spec/templates";
import { IdentityStep } from "@/features/build-spec/components/steps/IdentityStep";
import { OutputStep } from "@/features/build-spec/components/steps/OutputStep";
import { ParamsStep } from "@/features/build-spec/components/steps/ParamsStep";
import { PreviewStep } from "@/features/build-spec/components/steps/PreviewStep";
import { ReviewStep } from "@/features/build-spec/components/steps/ReviewStep";
import { SourceStep } from "@/features/build-spec/components/steps/SourceStep";
import { TemplateStep } from "@/features/build-spec/components/steps/TemplateStep";


/**
 * 단계별 New Build Wizard 페이지 컴포넌트.
 *
 * @returns 마법사 UI.
 */
export function NewBuildPage() {
  const { t } = useTranslation();
  const steps = buildSteps(t);
  // /builds/:buildId/edit 로 진입한 경우(편집 모드). buildId가 있으면 기존 스펙을 로드한다.
  const { buildId } = useParams();
  const [searchParams] = useSearchParams();
  const { build, isLoading: buildLoading } = useBuild(buildId || "");
  const isEditMode = !!buildId && build !== null;

  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", rows: [], schema: {}, warnings: [] });
  const [validation, setValidation] = useState<ValidationState>({
    status: "idle",
    isValid: false,
    errors: [],
  });
  // 편집 중인 원본 스펙. 폼이 표현하지 못하는 소스/메타데이터를 보존하는 기준이 된다.
  const [baseSpec, setBaseSpec] = useState<BuildSpec | null>(null);
  // 저장된 초안이 있으면 복원 배너를 보여준다 (#10). 마운트 시 한 번만 확인한다.
  // 편집 모드에서는 초안을 복원하면 불러온 스펙을 덮어써 버리므로 배너를 띄우지 않는다.
  const [draftAvailable, setDraftAvailable] = useState(() => !buildId && hasDraft());
  const [draftSaved, setDraftSaved] = useState(false);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading", providers: [] });
  // Workspace(#260)에서 "?savedSpecId=" 로 열었을 때 어떤 Saved BuildSpec을 불러왔는지.
  // 열었다고 곧바로 원본을 덮어쓰지 않는다 — 아래 "이 스펙 저장"을 눌러야만 반영된다.
  const [openedSavedSpecName, setOpenedSavedSpecName] = useState<string | null>(null);
  const [saveSpecMessage, setSaveSpecMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const job = useBuildJob();

  const {
    formState: { errors, isDirty },
    register,
    trigger,
    watch,
    getValues,
    reset,
    setValue,
  } = useForm<BuildFormValues>({ defaultValues: initialValues, mode: "onChange" });

  const values = watch();
  const specPreview = useMemo(() => toBuildSpec(values, baseSpec), [values, baseSpec]);
  const selectedProvider = values.provider;
  const providerOptions = catalog.providers.map((provider) => ({
    value: provider.name,
    label: providerLabel(provider.name),
  }));
  const datasetOptions = catalogProvider(catalog.providers, selectedProvider)?.datasets ?? [];

  // 마지막으로 검증한 폼 입력의 스냅샷. 검증 이후 입력이 바뀌면 검증 결과를 초기화하기 위해
  // 비교 기준으로 사용한다(stale validation 방지, #72).
  const validatedSnapshotRef = useRef<string | null>(null);

  // 검증을 통과/완료한 뒤 watch된 폼 값이 바뀌면, 검증되지 않은(수정된) 스펙이 그대로
  // 실행되지 않도록 검증 상태를 idle/invalid로 되돌린다(#72).
  useEffect(() => {
    if (validation.status === "idle") return;
    const current = JSON.stringify(values);
    if (validatedSnapshotRef.current === null) {
      validatedSnapshotRef.current = current;
      return;
    }
    if (current !== validatedSnapshotRef.current) {
      validatedSnapshotRef.current = null;
      setValidation({ status: "idle", isValid: false, errors: [] });
    }
  }, [values, validation.status]);

  useEffect(() => {
    const controller = new AbortController();
    builderApi.catalog(controller.signal)
      .then((response) => {
        setCatalog({ status: "loaded", providers: response.providers });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog({
          status: "error",
          providers: [],
          error: cause instanceof Error ? cause.message : i18n.t("newBuild.errors.catalogFail"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (catalog.status !== "loaded" || selectedProvider === "") return;
    const datasets = catalogProvider(catalog.providers, selectedProvider)?.datasets ?? [];
    if (datasets.length === 0) return;
    if (datasets.some((dataset) => dataset.name === values.sourceDataset)) return;
    setValue("sourceDataset", datasets[0].name, { shouldDirty: true, shouldValidate: true });
  }, [catalog, selectedProvider, setValue, values.sourceDataset]);

  // 편집 모드에서 build가 로드되면 폼을 초기화한다.
  //
  // 템플릿 선택(selectTemplate)과 동일하게, 폼을 갈아끼울 때는 이전 스펙 기준으로 만든
  // 미리보기/검증 결과가 남지 않도록 함께 초기화한다(stale 상태 방지, #72).
  useEffect(() => {
    if (!isEditMode || !build || buildLoading) return;
    setBaseSpec(build.spec);
    reset(toFormValues(build.spec));
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setStep(1); // 템플릿 단계를 건너뛰고 기본 정보부터 시작
  }, [isEditMode, build, buildLoading, reset]);

  // Workspace(#260)에서 "Saved BuildSpec 열기"로 진입한 경우(`?savedSpecId=`). 마운트 시
  // 한 번만 반영한다 — 열자마자 원본을 덮어쓰지 않고 폼만 채운다(#260 review §3).
  const savedSpecPrefillApplied = useRef(false);
  useEffect(() => {
    if (savedSpecPrefillApplied.current || buildId) return;
    const savedSpecId = searchParams.get("savedSpecId");
    if (!savedSpecId) return;
    savedSpecPrefillApplied.current = true;
    const entry = getSavedSpec(savedSpecId);
    if (!entry) return;
    setBaseSpec(entry.spec);
    reset(toFormValues(entry.spec));
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setOpenedSavedSpecName(entry.name);
    setStep(1);
  }, [buildId, searchParams, reset]);

  const draftStatus = validation.isValid ? "validated" : isDirty ? "dirty" : "new";

  // 템플릿을 선택하면 폼을 해당 값으로 채우고 기본 정보 단계로 넘어간다 (#11).
  // 이전 템플릿에서 로드된 미리보기/검증 결과가 남지 않도록 함께 초기화한다.
  function selectTemplate(template: BuildTemplate) {
    reset(template.values);
    // 템플릿으로 새로 시작하므로 편집 중이던 원본 스펙의 잔여 소스/메타데이터를 버린다.
    setBaseSpec(null);
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setStep(1);
  }

  // 현재 입력을 localStorage 초안으로 저장한다 (#10).
  // 방금 저장한 값을 기준으로 reset 하여 dirty 상태를 정리하고, 같은 세션에서 복원 배너가
  // 뜨지 않도록 draftAvailable은 건드리지 않는다(배너는 새 마운트 시 복원용).
  function saveCurrentDraft() {
    const current = getValues();
    // persistence boundary(S07): credential-like 값이 localStorage 초안에 평문으로 남지
    // 않도록 저장 직전에 redact한다. 화면의 in-memory 폼 상태(current)는 그대로 두므로
    // 진행 중인 Preview/Build는 영향이 없다.
    saveDraft(redactDraftForStorage(current));
    reset(current);
    setDraftSaved(true);
  }

  // 저장된 초안을 복원해 기본 정보 단계로 이동한다.
  function restoreDraft() {
    // 저장된 초안을 버전·스키마로 검증해 복원한다. 버전 불일치/손상 시 null을 받는다(#84).
    // 과거 버전이 평문 secret을 저장해 둔 초안이면 복원 시점에 redact본으로 다시 저장되고
    // (loadDraft의 sanitize rewrite), 반환값도 redact된 상태다 — 아래 toBuildSpec 가드가
    // marker를 감지해 재입력을 요구한다.
    const saved = loadDraft<BuildFormValues>(buildFormValuesSchema, undefined, redactDraftForStorage);
    if (!saved) {
      // 깨진 값이 남아 배너가 반복되지 않도록 정리하고, 이동/숨김은 하지 않는다.
      clearDraft();
      setDraftAvailable(false);
      return;
    }
    reset(saved);
    setDraftAvailable(false);
    setStep(1);
  }

  // 저장된 초안을 삭제하고 배너를 숨긴다.
  function discardDraft() {
    clearDraft();
    setDraftAvailable(false);
  }

  async function goNext() {
    const fields = STEP_FIELDS[step];
    const ok = fields.length === 0 ? true : await trigger(fields);
    if (!ok) return;
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function goBack() {
    setStep((current) => Math.max(current - 1, 0));
  }

  async function runPreview() {
    const next = toBuildSpec(getValues(), baseSpec);
    if (next.error || !next.spec) {
      setPreview({ status: "error", rows: [], schema: {}, warnings: [], error: next.error });
      return;
    }
    setPreview({ status: "loading", rows: [], schema: {}, warnings: [] });
    try {
      const result = await previewBuild(next.spec);
      setPreview({
        status: "loaded",
        rows: result.rows,
        schema: result.schema,
        warnings: result.warnings.map((warning) => `${warning.sourceKey}: ${warning.error}`),
      });
    } catch (cause) {
      setPreview({
        status: "error",
        rows: [],
        schema: {},
        warnings: [],
        error: cause instanceof Error ? cause.message : i18n.t("newBuild.errors.previewFail"),
      });
    }
  }

  async function runValidate() {
    // 검증 대상 입력의 스냅샷을 기록한다. 이후 폼이 바뀌면 effect가 이를 감지해 검증 상태를
    // 초기화한다(#72).
    validatedSnapshotRef.current = JSON.stringify(getValues());
    const next = toBuildSpec(getValues(), baseSpec);
    if (next.error || !next.spec) {
      setValidation({ status: "validated", isValid: false, errors: [next.error ?? i18n.t("newBuild.errors.specError")] });
      return;
    }
    setValidation({ status: "validating", isValid: false, errors: [] });
    try {
      const result = await validateSpec(next.spec);
      setValidation({ status: "validated", isValid: result.valid, errors: result.errors });
    } catch (cause) {
      // 네트워크/5xx/파싱 실패를 화면에서 확인할 수 있게 오류로 반영한다(미처리 rejection 방지).
      setValidation({
        status: "validated",
        isValid: false,
        errors: [cause instanceof Error ? cause.message : i18n.t("newBuild.errors.validateFail")],
      });
    }
  }

  // 현재 스펙을 Workspace(#260)의 Saved BuildSpec으로 저장한다. 저장 시점의 검증 상태를
  // 그대로 함께 기록한다 — 검증 안 한 스펙을 "통과"로 보여주지 않기 위함이다.
  function saveAsSavedSpec() {
    if (!specPreview.spec) return;
    const name = window.prompt(i18n.t("newBuild.review.savePrompt"), specPreview.spec.title || i18n.t("newBuild.review.unnamed"));
    if (!name) return;

    const validationSummary: SavedSpecValidation =
      validation.status === "validated"
        ? { status: validation.isValid ? "validated_pass" : "validated_fail", errors: validation.errors }
        : { status: "not_validated", errors: [] };

    const { result } = createSavedSpec({ name, spec: specPreview.spec, validation: validationSummary });
    setSaveSpecMessage(
      result.ok
        ? { type: "success", text: i18n.t("newBuild.review.savedAs", { name }) }
        : { type: "error", text: result.reason },
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={isEditMode ? t("newBuild.page.eyebrowEdit") : t("newBuild.page.eyebrowNew")}
        title={isEditMode ? t("newBuild.page.titleEdit", { title: baseSpec?.title || buildId }) : t("newBuild.page.titleNew")}
        description={
          isEditMode
            ? t("newBuild.page.descEdit")
            : t("newBuild.page.descNew")
        }
        actions={<StatusBadge status={draftStatus} />}
      />

      {buildId && buildLoading ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-muted-foreground">{t("newBuild.page.loadingSpec")}</p>
        </Card>
      ) : null}

      {buildId && !buildLoading && !isEditMode ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.specNotFound", { id: buildId })}
          </p>
        </Card>
      ) : null}

      {isEditMode ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.specEditing", { id: buildId })}
          </p>
        </Card>
      ) : null}

      {openedSavedSpecName ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.savedSpecLoaded", { name: openedSavedSpecName })}
          </p>
        </Card>
      ) : null}

      {draftAvailable ? (
        <Card variant="dashed" className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">
            {t("newBuild.page.draftExists")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={restoreDraft}>
              {t("newBuild.page.load")}
            </Button>
            <Button size="sm" variant="ghost" onClick={discardDraft}>
              {t("newBuild.page.delete")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <Stepper steps={steps} current={step} onStepClick={setStep} />
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.8fr)]">
        <Card>
          {step === 0 ? <TemplateStep catalog={catalog} onSelect={selectTemplate} /> : null}

          {step === 1 ? <IdentityStep register={register} errors={errors} /> : null}

          {step === 2 ? (
            <SourceStep
              register={register}
              errors={errors}
              catalog={catalog}
              providerOptions={providerOptions}
              datasetOptions={datasetOptions}
              selectedProvider={selectedProvider}
            />
          ) : null}

          {step === 3 ? <ParamsStep register={register} errors={errors} /> : null}

          {step === 4 ? <PreviewStep preview={preview} onRefresh={() => void runPreview()} /> : null}

          {step === 5 ? <OutputStep register={register} errors={errors} /> : null}

          {step === 6 ? (
            <ReviewStep
              validation={validation}
              job={job}
              canRun={validation.isValid && job.status !== "running" && !!specPreview.spec}
              canSave={!!specPreview.spec}
              saveSpecMessage={saveSpecMessage}
              onRevalidate={() => void runValidate()}
              onRun={() => {
                if (specPreview.spec) void job.start(specPreview.spec);
              }}
              onSaveSpec={saveAsSavedSpec}
            />
          ) : null}

          {/* 모바일에서는 하단 sticky action bar로 고정해 긴 폼에서도 이전/다음이 항상 보이게 한다(§13). */}
          <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-8 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none sm:dark:bg-transparent">
            <Button variant="ghost" onClick={goBack} disabled={step === 0}>
              {t("newBuild.nav.prev")}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={saveCurrentDraft}>
                {draftSaved && !isDirty ? t("newBuild.nav.saved") : t("newBuild.nav.saveDraft")}
              </Button>
              {step < steps.length - 1 ? (
                <Button onClick={() => void goNext()}>{t("newBuild.nav.next")}</Button>
              ) : null}
            </div>
          </div>
        </Card>

        <aside className="space-y-5">
          <Card>
            {/* 모바일에서 공간을 아끼도록 기본 접힘(details). 데스크톱(xl)에서는 별도 컬럼에
                표시되며 필요 시 펼친다(§13). */}
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("newBuild.nav.specTitle")}
                <span className="text-base transition group-open:rotate-180" aria-hidden="true">
                  ⌄
                </span>
              </summary>
              <pre className="mt-4 overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
                <code>{JSON.stringify(specPreview.spec ?? values, null, 2)}</code>
              </pre>
            </details>
          </Card>
        </aside>
      </div>
    </main>
  );
}

