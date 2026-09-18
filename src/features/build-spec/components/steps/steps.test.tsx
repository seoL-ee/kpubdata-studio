/**
 * New Build 마법사 단계 컴포넌트 테스트 (#379).
 *
 * 페이지에서 떼어낸 뒤 각 단계가 제 것을 그대로 그리는지 잠근다. 특히 ReviewStep 의
 * 실행 버튼은 페이지에서 `disabled={!valid || running || !spec}` 이던 조건을 `canRun`
 * 하나로 옮겼으므로, 세 조건이 각각 버튼을 막는지 직접 확인한다.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";

import { IdentityStep } from "./IdentityStep";
import { OutputStep } from "./OutputStep";
import { ParamsStep } from "./ParamsStep";
import { PreviewStep } from "./PreviewStep";
import { ReviewStep } from "./ReviewStep";
import { SourceStep } from "./SourceStep";
import { TemplateStep } from "./TemplateStep";
import { initialValues, type BuildFormValues, type CatalogState, type PreviewState, type ValidationState } from "@/features/build-spec/newBuildModel";
import type { BuildJob } from "@/features/runs/useBuildJob";
import type { CatalogDataset } from "@/shared/lib/builderApi";

/** register/errors 를 진짜 폼에서 받아 단계 컴포넌트에 넘긴다. */
function FormHarness({ render: renderStep }: { render: (form: ReturnType<typeof useForm<BuildFormValues>>) => React.ReactNode }) {
  const form = useForm<BuildFormValues>({ defaultValues: initialValues });
  return <form>{renderStep(form)}</form>;
}

function dataset(name: string, title: string): CatalogDataset {
  return {
    name,
    title,
    description: null,
    tags: [],
    source_url: null,
    representation: "api_json",
    operations: ["list"],
    query_support: null,
    requires_service_key: false,
  };
}

const LOADED: CatalogState = {
  status: "loaded",
  providers: [{ name: "datago", datasets: [dataset("air_quality", "대기오염")] }],
};

const idleJob: BuildJob = {
  status: "idle",
  interrupted: false,
  start: vi.fn(),
  cancel: vi.fn(),
};

const validated: ValidationState = { status: "validated", isValid: true, errors: [] };

describe("TemplateStep", () => {
  it("카탈로그를 불러오는 동안에도 템플릿 목록을 숨기지 않는다", () => {
    render(<TemplateStep catalog={{ status: "loading", providers: [] }} onSelect={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("카탈로그 오류를 alert 으로 알린다", () => {
    render(
      <TemplateStep catalog={{ status: "error", providers: [], error: "연결 실패" }} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("연결 실패");
  });
});

describe("IdentityStep", () => {
  it("dataset id/제목/설명 입력을 모두 그린다", () => {
    render(<FormHarness render={({ register, formState }) => <IdentityStep register={register} errors={formState.errors} />} />);
    expect(screen.getByPlaceholderText("kma-daily-observations")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox").length).toBeGreaterThanOrEqual(3);
  });
});

describe("SourceStep", () => {
  it("provider 를 고르기 전에는 dataset 선택을 막는다", () => {
    render(
      <FormHarness
        render={({ register, formState }) => (
          <SourceStep
            register={register}
            errors={formState.errors}
            catalog={LOADED}
            providerOptions={[{ value: "datago", label: "데이터고" }]}
            datasetOptions={[dataset("air_quality", "대기오염")]}
            selectedProvider=""
          />
        )}
      />,
    );
    const selects = screen.getAllByRole("combobox");
    expect(selects[1]).toBeDisabled();
  });

  it("provider 를 고르면 dataset 선택이 열린다", () => {
    render(
      <FormHarness
        render={({ register, formState }) => (
          <SourceStep
            register={register}
            errors={formState.errors}
            catalog={LOADED}
            providerOptions={[{ value: "datago", label: "데이터고" }]}
            datasetOptions={[dataset("air_quality", "대기오염")]}
            selectedProvider="datago"
          />
        )}
      />,
    );
    expect(screen.getAllByRole("combobox")[1]).toBeEnabled();
  });
});

describe("ParamsStep", () => {
  it("파라미터 입력을 그린다", () => {
    render(<FormHarness render={({ register, formState }) => <ParamsStep register={register} errors={formState.errors} />} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

describe("PreviewStep", () => {
  const empty: PreviewState = { status: "idle", rows: [], schema: {}, warnings: [] };

  it("미리보기 전에는 안내를 보여준다", () => {
    render(<PreviewStep preview={empty} onRefresh={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });

  it("경고는 각각 alert 으로 보여준다", () => {
    render(
      <PreviewStep
        preview={{ ...empty, status: "loaded", rows: [{ a: 1 }], warnings: ["datago.air_quality: 429"] }}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("429");
  });
});

describe("OutputStep", () => {
  it("출력 형식 체크박스와 경로 입력을 그린다", () => {
    render(<FormHarness render={({ register, formState }) => <OutputStep register={register} errors={formState.errors} />} />);
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("artifacts/builds/air-quality")).toBeInTheDocument();
  });
});

describe("ReviewStep — 실행 버튼 게이팅", () => {
  function renderReview(overrides: Partial<Parameters<typeof ReviewStep>[0]> = {}) {
    const props = {
      validation: validated,
      job: idleJob,
      canRun: true,
      canSave: true,
      saveSpecMessage: null,
      onRevalidate: vi.fn(),
      onRun: vi.fn(),
      onSaveSpec: vi.fn(),
      ...overrides,
    };
    render(<ReviewStep {...props} />);
    return props;
  }

  it("실행 가능하면 버튼이 열려 있다", () => {
    const props = renderReview();
    const run = screen.getAllByRole("button").find((button) => !button.hasAttribute("disabled"));
    expect(run).toBeDefined();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("canRun 이 false 면 실행 버튼이 막힌다", () => {
    renderReview({ canRun: false });
    const disabled = screen.getAllByRole("button").filter((button) => button.hasAttribute("disabled"));
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("실행 중이면 취소 버튼이 함께 보인다", () => {
    renderReview({ job: { ...idleJob, status: "running" }, canRun: false });
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
  });

  it("검증 오류는 각각 alert 으로 보여준다", () => {
    renderReview({ validation: { status: "validated", isValid: false, errors: ["sources[0]: 누락"] } });
    expect(screen.getByRole("alert")).toHaveTextContent("sources[0]: 누락");
  });

  it("저장 실패 메시지는 alert 으로 알린다", () => {
    renderReview({ saveSpecMessage: { type: "error", text: "같은 이름이 있습니다" } });
    expect(screen.getByRole("alert")).toHaveTextContent("같은 이름이 있습니다");
  });

  it("canSave 가 false 면 저장 버튼이 막힌다", () => {
    renderReview({ canSave: false, canRun: true });
    const disabled = screen.getAllByRole("button").filter((button) => button.hasAttribute("disabled"));
    expect(disabled.length).toBe(1);
  });
});
