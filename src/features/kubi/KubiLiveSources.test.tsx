import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as datasetsApi from "@/features/datasets/api";
import { KubiPage } from "@/pages/KubiPage";
import { useKubiStore } from "./useKubiSession";
import type { RunStagesResponse } from "@/shared/lib/builderApi";

function stages(runId: string, sourceKeys: string[]): RunStagesResponse {
  return {
    run_id: runId,
    sources: sourceKeys.map((source_key) => ({
      source_key,
      bronze: { status: "completed", available: true },
      silver: { status: "completed", available: true },
      gold: { status: "completed", available: true },
    })),
  };
}

function Harness({ initialPath = "/kubi?run=run-a" }: { initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <KubiPage />
      <LocationHarness />
    </MemoryRouter>
  );
}

function LocationHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}{location.search}</output>
      <button type="button" onClick={() => navigate("/kubi?run=run-b")}>Run B로 이동</button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useKubiStore.setState({ turns: [], onboarded: false, pendingSeed: null });
  vi.restoreAllMocks();
});

describe("Kubi live Builder-confirmed source picker", () => {
  it("shows a multi-source picker before the first question, without quality evidence", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.a", "provider.b"]));
    render(<Harness />);
    const picker = await screen.findByLabelText("Kubi 분석 Source");
    expect(useKubiStore.getState().turns).toHaveLength(0);
    expect(picker).toHaveTextContent("provider.a");
    expect(picker).toHaveTextContent("provider.b");
  });

  it("does not expose stale Run A sources after changing to Run B", async () => {
    const runA = deferred<RunStagesResponse>();
    const runB = deferred<RunStagesResponse>();
    vi.spyOn(datasetsApi, "listBuildStages").mockImplementation((runId) => runId === "run-a" ? runA.promise : runB.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Run B로 이동" }));
    await act(async () => { runB.resolve(stages("run-b", ["provider.b1", "provider.b2"])); });
    expect(await screen.findByText("provider.b1", { selector: "option" })).toBeInTheDocument();
    await act(async () => { runA.resolve(stages("run-a", ["provider.a1", "provider.a2"])); });
    expect(screen.queryByText("provider.a1", { selector: "option" })).not.toBeInTheDocument();
  });

  it("shows no fake source option when the Builder source fetch fails", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockRejectedValue(new Error("network"));
    render(<Harness />);
    await waitFor(() => expect(datasetsApi.listBuildStages).toHaveBeenCalled());
    expect(screen.queryByLabelText("Kubi 분석 Source")).not.toBeInTheDocument();
  });

  it("keeps single-source behavior without presenting an unnecessary picker", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.only"]));
    render(<Harness />);
    await waitFor(() => expect(datasetsApi.listBuildStages).toHaveBeenCalled());
    expect(screen.queryByLabelText("Kubi 분석 Source")).not.toBeInTheDocument();
  });

  it("writes a selected confirmed source into URL context", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.a", "provider.b"]));
    render(<Harness initialPath="/kubi?run=run-a&stage=gold" />);
    fireEvent.change(await screen.findByLabelText("Kubi 분석 Source"), { target: { value: "provider.b" } });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/kubi?run=run-a&source=provider.b"));
  });

  it("remains fail-closed when a multi-source Run has no selected source", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.a", "provider.b"]));
    render(<Harness initialPath="/kubi?run=run-a&stage=gold" />);
    expect(await screen.findByText("이 Run에는 source가 여러 개 있습니다. 분석할 source를 먼저 선택하세요.")).toBeInTheDocument();
    expect(screen.getByLabelText("Kubi 분석 Source")).toHaveValue("");
  });

  it("disables the Stage select on a multi-source Run until a source is chosen (A4)", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.a", "provider.b"]));
    render(<Harness initialPath="/kubi?run=run-a&stage=gold" />);

    // multi-source인데 source 미선택 → Stage 선택 불가(evidence가 fail-closed로 빠지므로).
    //
    // findBy*는 "요소가 생겼는가"만 기다리고 **속성이 정해졌는가는 기다리지 않는다**.
    // 이 select는 먼저 enabled로 렌더된 뒤 run stage가 도착하면 disabled가 되므로,
    // 느린 러너에서는 그 사이에 단언이 떨어진다(Node 20 레인 실패). 조건 자체를 기다린다.
    await waitFor(() => expect(screen.getByLabelText("Kubi 분석 Stage")).toBeDisabled());
    // disabled 상태여도 안내는 유지된다.
    expect(screen.getByText("이 Run에는 source가 여러 개 있습니다. 분석할 source를 먼저 선택하세요.")).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Kubi 분석 Source"), { target: { value: "provider.b" } });
    await waitFor(() => expect(screen.getByLabelText("Kubi 분석 Stage")).toBeEnabled());
  });

  it("keeps the Stage select usable on a single-source Run even without an explicit source (A4)", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.only"]));
    render(<Harness initialPath="/kubi?run=run-a" />);
    await waitFor(() => expect(datasetsApi.listBuildStages).toHaveBeenCalled());
    expect(screen.getByLabelText("Kubi 분석 Stage")).toBeEnabled();
  });

  it("disables the Stage select when there is no Run in context (A4)", async () => {
    vi.spyOn(datasetsApi, "listBuildStages").mockResolvedValue(stages("run-a", ["provider.a"]));
    render(<Harness initialPath="/kubi" />);
    expect(await screen.findByLabelText("Kubi 분석 Stage")).toBeDisabled();
  });
});
