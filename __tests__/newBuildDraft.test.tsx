import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewBuildPage } from "@/pages/NewBuildPage";
import { clearDraft } from "@/features/build-spec/draftStorage";

// Builder API 경계 spy (S07 리뷰 §2). legacy 평문 draft가 복원되어 secret placeholder가
// 폼에 들어간 상태에서 Preview/Validate/Run 어느 경로도 Builder를 호출하지 않아야 한다.
// newBuildWizard.test.tsx와 동일하게 feature api 모듈 자체를 mock한다.
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

function renderWizard() {
  return render(
    <MemoryRouter>
      <NewBuildPage />
    </MemoryRouter>,
  );
}

describe("New Build draft persistence (#10)", () => {
  beforeEach(() => {
    clearDraft();
    previewBuildMock.mockReset().mockResolvedValue({ rows: [], schema: {}, warnings: [] });
    validateSpecMock.mockReset().mockResolvedValue({ valid: true, errors: [] });
    executeBuildMock.mockReset().mockResolvedValue({ id: "should-not-run", status: "succeeded" });
  });
  afterEach(() => clearDraft());

  it("saves the current input and restores it on a fresh mount", async () => {
    const first = renderWizard();
    // 템플릿 → 기본 정보
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.change(screen.getByLabelText(/데이터셋 ID/), { target: { value: "kma-daily" } });
    fireEvent.click(screen.getByRole("button", { name: "초안 저장" }));
    expect(screen.getByRole("button", { name: /저장됨/ })).toBeInTheDocument();

    // 새로 마운트하면 복원 배너가 보인다.
    first.unmount();
    renderWizard();
    expect(screen.getByText("저장된 초안이 있습니다. 이어서 편집할까요?")).toBeInTheDocument();

    // 불러오면 저장한 값으로 채워진 기본 정보 단계로 이동한다.
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    expect(screen.getByRole("heading", { name: "기본 정보" })).toBeInTheDocument();
    expect(screen.getByLabelText(/데이터셋 ID/)).toHaveValue("kma-daily");
  });

  it("scrubs credential-like sourceParams before writing the draft to localStorage (S07)", async () => {
    const secret = "abcdef0123456789abcdef0123456789ABCDEF";
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "다음" })); // 템플릿 → 기본 정보
    fireEvent.change(screen.getByLabelText(/데이터셋 ID/), { target: { value: "air-quality" } });
    fireEvent.change(screen.getByLabelText(/제목/), { target: { value: "대기오염" } });
    fireEvent.change(screen.getByLabelText(/설명/), { target: { value: "설명" } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "데이터 소스" });
    fireEvent.change(screen.getByLabelText(/제공자/), { target: { value: "datago" } });
    fireEvent.change(screen.getByLabelText(/데이터셋/), { target: { value: "air" } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "파라미터" });

    fireEvent.change(screen.getByLabelText(/요청 파라미터/), {
      target: { value: JSON.stringify({ sidoName: "서울", serviceKey: secret }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "초안 저장" }));
    expect(screen.getByRole("button", { name: /저장됨/ })).toBeInTheDocument();

    // 저장된 어떤 localStorage 항목에도 raw secret이 남지 않는다.
    const dump = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? "")
      .join("\n");
    expect(dump).not.toContain(secret);
    expect(dump).toContain("__KPD_PARAMS_SECRET_REDACTED__");
    // 비민감 파라미터는 초안에 그대로 남는다.
    expect(dump).toContain("sidoName");

    // in-memory 폼 상태는 그대로라 진행 중인 Preview/Build 요청에 영향이 없다.
    expect(screen.getByLabelText(/요청 파라미터/)).toHaveValue(
      JSON.stringify({ sidoName: "서울", serviceKey: secret }),
    );
  });

  it("read-time로 legacy 평문 draft를 sanitize + rewrite하고, 복원된 marker는 fail-closed 처리한다 (S07 리뷰 §2)", async () => {
    const secret = "abcdef0123456789abcdef0123456789ABCDEF";
    // S07 이전 포맷: sanitize 없이 raw serviceKey가 그대로 저장된 초안.
    localStorage.setItem(
      "kpubdata-studio:new-build-draft",
      JSON.stringify({
        version: 1,
        savedAt: "2020-01-01T00:00:00.000Z",
        data: {
          datasetId: "air-quality",
          title: "대기오염",
          description: "설명",
          provider: "datago",
          sourceDataset: "air",
          sourceParams: JSON.stringify({ sidoName: "서울", serviceKey: secret }),
          outputPath: "artifacts/builds/air",
          exportFormats: ["jsonl"],
        },
      }),
    );

    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));

    // 복원 직후 localStorage가 sanitized 됐다 — raw secret 제거, marker 삽입.
    const stored = localStorage.getItem("kpubdata-studio:new-build-draft") ?? "";
    expect(stored).not.toContain(secret);
    expect(stored).toContain("__KPD_PARAMS_SECRET_REDACTED__");

    // 파라미터 단계로 이동하면 필드에 raw secret이 아니라 marker가 보인다.
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "데이터 소스" });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "파라미터" });
    const fieldValue = (screen.getByLabelText(/요청 파라미터/) as HTMLTextAreaElement).value;
    expect(fieldValue).toContain("__KPD_PARAMS_SECRET_REDACTED__");
    expect(fieldValue).not.toContain(secret);

    // 미리보기 진입 시 fail-closed — Builder로 marker를 제출하지 않는다.
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "미리보기" });
    fireEvent.click(screen.getByRole("button", { name: "미리보기 새로고침" }));
    expect(
      await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/),
    ).toBeInTheDocument();
    // 오류 문구만이 아니라 Builder `/preview` 자체가 호출되지 않았다.
    expect(previewBuildMock).toHaveBeenCalledTimes(0);

    // Validate 경로도 동일하게 fail-closed — Builder `/validate` 미호출.
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "출력 형식" });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "검증·실행" });
    fireEvent.click(screen.getByRole("button", { name: "다시 검증" }));
    expect(
      await screen.findByText(/시크릿이 포함된 파라미터 값이 제거되었습니다/),
    ).toBeInTheDocument();
    expect(validateSpecMock).toHaveBeenCalledTimes(0);

    // Run 경로 — 버튼은 disabled고, 강제 클릭해도 Builder 실행(executeBuild)은 0회.
    const runButton = screen.getByRole("button", { name: "빌드 실행" });
    expect(runButton).toBeDisabled();
    fireEvent.click(runButton);
    expect(executeBuildMock).toHaveBeenCalledTimes(0);
  });

  it("discards the saved draft and hides the banner", () => {
    const first = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(screen.getByRole("button", { name: "초안 저장" }));
    first.unmount();

    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(
      screen.queryByText("저장된 초안이 있습니다. 이어서 편집할까요?"),
    ).not.toBeInTheDocument();
  });
});
