/**
 * NewBuildPage ↔ Workspace Saved BuildSpec 연동 (#260).
 *
 * Review 단계의 "이 스펙 저장" 버튼이 실제로 savedSpecs 저장소에 기록되는지, 저장 시점의
 * 검증 상태가 함께 기록되는지, `?savedSpecId=`로 열었을 때 폼이 프리필되고 원본을 즉시
 * 덮어쓰지 않는지 확인한다.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewBuildPage } from "@/pages/NewBuildPage";
import { createSavedSpec, listSavedSpecSummaries } from "@/features/workspace/savedSpecs";

function next() {
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NewBuildPage />
    </MemoryRouter>,
  );
}

async function goToReviewAndValidate(path = "/builds/new") {
  renderAt(path);
  next(); // 템플릿 → 기본 정보
  fireEvent.change(screen.getByLabelText(/데이터셋 ID/), { target: { value: "air-quality" } });
  fireEvent.change(screen.getByLabelText(/제목/), { target: { value: "대기오염" } });
  fireEvent.change(screen.getByLabelText(/설명/), { target: { value: "설명" } });
  next();
  await screen.findByRole("heading", { name: "데이터 소스" });
  fireEvent.change(screen.getByLabelText(/제공자/), { target: { value: "datago" } });
  fireEvent.change(screen.getByLabelText(/데이터셋/), { target: { value: "air" } });
  next();
  await screen.findByRole("heading", { name: "파라미터" });
  next();
  await screen.findByRole("heading", { name: "미리보기" });
  next();
  await screen.findByRole("heading", { name: "출력 형식" });
  next();
  await screen.findByRole("heading", { name: "검증·실행" });
  fireEvent.click(screen.getByRole("button", { name: "다시 검증" }));
  await screen.findByText("검증을 통과했습니다. 빌드를 실행할 수 있습니다.");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("이 스펙 저장 (Review 단계)", () => {
  it("prompts for a name and stores the spec with the current validated_pass status", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("내 대기오염 스펙");
    await goToReviewAndValidate();

    fireEvent.click(screen.getByRole("button", { name: "이 스펙 저장 (Workspace)" }));

    expect(await screen.findByText(/내 대기오염 스펙.*Workspace에 저장했습니다/)).toBeInTheDocument();
    const summaries = listSavedSpecSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ name: "내 대기오염 스펙", provider: "datago", validationStatus: "validated_pass" });
  });

  it("records not_validated when the user saves before running validation", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("검증 전 저장");
    renderAt("/builds/new");
    next();
    fireEvent.change(screen.getByLabelText(/데이터셋 ID/), { target: { value: "air-quality" } });
    fireEvent.change(screen.getByLabelText(/제목/), { target: { value: "대기오염" } });
    fireEvent.change(screen.getByLabelText(/설명/), { target: { value: "설명" } });
    next();
    await screen.findByRole("heading", { name: "데이터 소스" });
    fireEvent.change(screen.getByLabelText(/제공자/), { target: { value: "datago" } });
    fireEvent.change(screen.getByLabelText(/데이터셋/), { target: { value: "air" } });
    next();
    await screen.findByRole("heading", { name: "파라미터" });
    next();
    await screen.findByRole("heading", { name: "미리보기" });
    next();
    await screen.findByRole("heading", { name: "출력 형식" });
    next();
    await screen.findByRole("heading", { name: "검증·실행" });
    // "다시 검증"을 누르지 않고 바로 저장한다.

    fireEvent.click(screen.getByRole("button", { name: "이 스펙 저장 (Workspace)" }));

    await screen.findByText(/Workspace에 저장했습니다/);
    expect(listSavedSpecSummaries()[0].validationStatus).toBe("not_validated");
  });

  it("does not save when the user cancels the name prompt", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    await goToReviewAndValidate();

    fireEvent.click(screen.getByRole("button", { name: "이 스펙 저장 (Workspace)" }));

    expect(listSavedSpecSummaries()).toHaveLength(0);
  });

  it("shows the save-failure reason when the storage layer rejects the save", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("실패할 저장");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    await goToReviewAndValidate();

    fireEvent.click(screen.getByRole("button", { name: "이 스펙 저장 (Workspace)" }));

    expect(await screen.findByText(/저장 공간이 부족합니다/)).toBeInTheDocument();
  });
});

describe("?savedSpecId= 로 열기", () => {
  it("prefills the form from the saved spec and shows a banner, without overwriting the original on open", async () => {
    const { entry } = createSavedSpec({
      name: "저장된 인구 스펙",
      spec: {
        datasetId: "kosis-population",
        title: "인구 통계",
        description: "설명",
        sources: [{ provider: "kosis", dataset: "population_migration", params: {} }],
        exports: [{ format: "jsonl" }],
        metadata: { outputPath: "artifacts/builds/population" },
      },
      validation: { status: "validated_pass", errors: [] },
    });

    renderAt(`/builds/new?savedSpecId=${entry.id}`);

    await screen.findByText(/불러왔습니다/);
      expect(document.body.textContent).toContain("저장된 인구 스펙");
    expect(screen.getByText(/불러왔습니다/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "기본 정보" })).toBeInTheDocument();
    expect(screen.getByLabelText(/제목/)).toHaveValue("인구 통계");

    // 열기만 했을 뿐 원본은 그대로다(아직 "이 스펙 저장"을 누르지 않음).
    expect(listSavedSpecSummaries()[0].name).toBe("저장된 인구 스펙");
    expect(listSavedSpecSummaries()[0].updatedAt).toBe(entry.updatedAt);
  });

  it("ignores an unknown savedSpecId without crashing", async () => {
    renderAt("/builds/new?savedSpecId=does-not-exist");
    expect(await screen.findByRole("heading", { name: "템플릿 선택" })).toBeInTheDocument();
  });
});
