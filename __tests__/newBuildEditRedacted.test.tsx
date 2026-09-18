/**
 * Build Edit(`/builds/:buildId/edit`)에서 복원된 BuildSpec의 redaction marker가
 * Preview/Validate/Run 모든 진입점에서 fail-closed 되는지 확인한다 (S07 리뷰 §1).
 *
 * specStore는 실행 시점 spec을 보관할 때 credential을 `[REDACTED]`로 redact한다. 그
 * 값이 편집 폼으로 복원된 뒤 그대로 Builder(preview/validate/build)로 제출되면 literal
 * placeholder가 provider credential 자리에 들어간다 — 여기서 그 경로가 막히는지 본다.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewBuildPage } from "@/pages/NewBuildPage";
import { clearBuildSpecs, loadBuildSpec, saveBuildSpec } from "@/features/build-spec/specStore";
import type { BuildSpec } from "@/shared/lib/types";

// Builder API 경계를 직접 spy한다(S07 리뷰 §1). fail-closed는 "오류 UI가 뜬다"가 아니라
// "Builder로 아무것도 나가지 않는다"가 핵심 불변식이므로, redaction marker가 복원된
// 상태에서 Preview/Validate/Run 어느 경로도 이 세 함수를 호출하지 않음을 고정한다.
// - previewBuild : Builder `/preview`(newBuildWizard.test.tsx와 동일한 mock 지점)
// - validateSpec : Builder `/validate`
// - executeBuild : Builder `/build`(job.start → useBuildJob → executeBuild 실행 경계)
const { previewBuildMock, validateSpecMock, executeBuildMock } = vi.hoisted(() => ({
  previewBuildMock: vi.fn(),
  validateSpecMock: vi.fn(),
  executeBuildMock: vi.fn(),
}));

vi.mock("@/features/preview/api", () => ({ previewBuild: previewBuildMock }));
vi.mock("@/features/validation/api", () => ({ validateSpec: validateSpecMock }));
vi.mock("@/features/runs/api", async (importActual) => ({
  ...(await importActual<typeof import("@/features/runs/api")>()),
  executeBuild: executeBuildMock,
}));

/** 세 경로 모두 Builder 호출이 0회임을 한 번에 단언한다. */
function expectNoBuilderCalls() {
  expect(previewBuildMock).toHaveBeenCalledTimes(0);
  expect(validateSpecMock).toHaveBeenCalledTimes(0);
  expect(executeBuildMock).toHaveBeenCalledTimes(0);
}

const RUN_ID = "air-quality-redacted-run";

const SPEC_WITH_SECRET: BuildSpec = {
  datasetId: "air-quality",
  title: "대기오염",
  description: "설명",
  sources: [
    {
      provider: "datago",
      dataset: "air",
      params: { sidoName: "서울", serviceKey: "A7vK2mQ9xP4rT8yW3nC6dF1hJ5sL0zB4uH8" },
    },
  ],
  exports: [{ format: "jsonl" }],
  metadata: { outputPath: "artifacts/builds/air" },
};

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={[`/builds/${RUN_ID}/edit`]}>
      <Routes>
        <Route path="/builds/:buildId/edit" element={<NewBuildPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function gotoStep(heading: string) {
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  // 단계마다 catalog fetch effect가 끼어 재렌더가 늦을 수 있어(병렬 실행 부하) 여유를 둔다.
  await screen.findByRole("heading", { name: heading });
}

describe("Build Edit — 복원된 redaction marker fail-closed (S07)", () => {
  beforeEach(() => {
    clearBuildSpecs();
    saveBuildSpec(RUN_ID, SPEC_WITH_SECRET);
    previewBuildMock.mockReset().mockResolvedValue({ rows: [], schema: {}, warnings: [] });
    validateSpecMock.mockReset().mockResolvedValue({ valid: true, errors: [] });
    executeBuildMock.mockReset().mockResolvedValue({ id: "should-not-run", status: "succeeded" });
  });
  afterEach(() => clearBuildSpecs());

  it("specStore가 credential을 [REDACTED]로 보관한다(전제)", () => {
    const params = loadBuildSpec(RUN_ID)?.sources[0].params as Record<string, unknown>;
    expect(params.serviceKey).toBe("[REDACTED]");
    expect(params.sidoName).toBe("서울");
  });

  it("Preview 진입 시 fail-closed — 재입력을 요구한다", async () => {
    renderEdit();
    // 편집 모드는 build 로드 후 기본 정보 단계에서 시작한다.
    await screen.findByRole("heading", { name: "기본 정보" }, { timeout: 8000 });
    await gotoStep("데이터 소스");
    await gotoStep("파라미터");
    // 복원된 파라미터에 raw secret이 아니라 marker가 들어 있다.
    const paramsValue = (screen.getByLabelText(/요청 파라미터/) as HTMLTextAreaElement).value;
    expect(paramsValue).toContain("[REDACTED]");
    expect(paramsValue).not.toContain("A7vK2mQ9xP4rT8yW3nC6dF1hJ5sL0zB4uH8");

    await gotoStep("미리보기");
    fireEvent.click(screen.getByRole("button", { name: "미리보기 새로고침" }));

    expect(
      await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/),
    ).toBeInTheDocument();
    // 핵심: 오류 UI만이 아니라 Builder `/preview`로 marker가 전송되지 않았다.
    expect(previewBuildMock).toHaveBeenCalledTimes(0);
    expectNoBuilderCalls();
  });

  it("Validate 진입 시 fail-closed — 통과 메시지가 뜨지 않고 실행이 막힌다", async () => {
    renderEdit();
    await screen.findByRole("heading", { name: "기본 정보" }, { timeout: 8000 });
    await gotoStep("데이터 소스");
    await gotoStep("파라미터");
    await gotoStep("미리보기");
    await gotoStep("출력 형식");
    await gotoStep("검증·실행");

    fireEvent.click(screen.getByRole("button", { name: "다시 검증" }));

    expect(await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/)).toBeInTheDocument();
    expect(
      screen.queryByText("검증을 통과했습니다. 빌드를 실행할 수 있습니다."),
    ).not.toBeInTheDocument();

    // 핵심: Builder `/validate`가 호출되지 않았다(오류는 클라이언트 가드에서 났다).
    expect(validateSpecMock).toHaveBeenCalledTimes(0);

    // Run 경로도 막혀 있다 — 버튼은 disabled고, 강제로 클릭해도 executeBuild는 0회.
    const runButton = screen.getByRole("button", { name: "빌드 실행" });
    expect(runButton).toBeDisabled();
    fireEvent.click(runButton);
    expect(executeBuildMock).toHaveBeenCalledTimes(0);

    expectNoBuilderCalls();
  });

  it("Run 경로 — 검증·실행 단계까지 진행해도 Builder 실행 호출이 0회", async () => {
    renderEdit();
    await screen.findByRole("heading", { name: "기본 정보" }, { timeout: 8000 });
    await gotoStep("데이터 소스");
    await gotoStep("파라미터");
    await gotoStep("미리보기");
    // 미리보기 경로 시도.
    fireEvent.click(screen.getByRole("button", { name: "미리보기 새로고침" }));
    expect(
      await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/),
    ).toBeInTheDocument();

    await gotoStep("출력 형식");
    await gotoStep("검증·실행");
    // 검증 경로 시도.
    fireEvent.click(screen.getByRole("button", { name: "다시 검증" }));
    expect(
      await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/),
    ).toBeInTheDocument();

    // 실행 경로 시도.
    fireEvent.click(screen.getByRole("button", { name: "빌드 실행" }));

    // 세 경로 모두 Builder로 나가지 않았다.
    expectNoBuilderCalls();
  });
});
