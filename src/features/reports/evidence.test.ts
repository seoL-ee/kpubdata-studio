import { afterEach, describe, expect, it, vi } from "vitest";
import * as datasetsApi from "@/features/datasets/api";
import { buildEvidenceRefs, fetchReportEvidence } from "./evidence";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("fetchReportEvidence (#258)", () => {
  it("모든 evidence를 한 번에 모은다(정상 dataset/run)", async () => {
    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");

    expect(evidence.dataset.ok).toBe(true);
    expect(evidence.run.ok).toBe(true);
    if (evidence.run.ok) expect(evidence.run.value.spec_digest).toBe("sha256:air14");
    expect(evidence.stages.ok).toBe(true);
    expect(evidence.quality.ok).toBe(true);
    if (evidence.quality.ok) expect(evidence.quality.value.availability).toBe("partial");
  });

  it("silver schema를 온전히 가진 source는 origin=silver, 실패한 source는 origin=unavailable로 구분한다", async () => {
    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");

    expect(evidence.schemas["datago__air"]?.origin).toBe("silver");
    expect(evidence.schemas["datago__air"]?.columns.length).toBeGreaterThan(0);
    // kma__weather는 mock에서 silver failed, gold not_run이라 schema를 얻을 수 없다.
    expect(evidence.schemas["kma__weather"]?.origin).toBe("unavailable");
    expect(evidence.schemas["kma__weather"]?.reason).toBeTruthy();
  });

  it("Silver schema를 사용하고 Silver stage detail을 limit=1로 조회한다", async () => {
    const spy = vi.spyOn(datasetsApi, "getBuildStageDetail");

    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");

    expect(evidence.schemas["datago__air"]?.origin).toBe("silver");
    expect(spy).toHaveBeenCalledWith("air-2026-08-14", "silver", "datago__air", 1, undefined);
  });

  it("Silver 실패 시 Gold column names로 fallback하고 Gold stage detail을 limit=1로 조회한다", async () => {
    const spy = vi.spyOn(datasetsApi, "getBuildStageDetail").mockImplementation(async (runId, stage, sourceKey) => {
      if (stage === "silver") throw new Error("silver unavailable");
      return {
        run_id: runId,
        stage: "gold",
        source_key: sourceKey,
        status: "completed",
        available: true,
        row_count: 1,
        columns: ["fallback_column"],
        splits: null,
        exports: [],
        sample: null,
        sample_available: false,
      };
    });

    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");

    expect(evidence.schemas["datago__air"]).toMatchObject({
      origin: "gold_names_only",
      columns: [],
      columnNamesOnly: ["fallback_column"],
    });
    expect(spy).toHaveBeenCalledWith("air-2026-08-14", "gold", "datago__air", 1, undefined);
  });

  it("Silver와 Gold 모두 실패하면 기존 unavailable semantics를 유지한다", async () => {
    vi.spyOn(datasetsApi, "getBuildStageDetail").mockRejectedValue(new Error("stage unavailable"));

    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");

    expect(evidence.schemas["datago__air"]?.origin).toBe("unavailable");
    expect(evidence.schemas["datago__air"]?.reason).toBeTruthy();
  });

  it("run이 dataset의 run 목록에 없으면 run을 실패로 표시하되 dataset/stages/quality는 그대로 시도한다(부분 실패 허용)", async () => {
    const evidence = await fetchReportEvidence("air-quality", "does-not-exist-run");

    expect(evidence.dataset.ok).toBe(true);
    expect(evidence.run.ok).toBe(false);
    if (!evidence.run.ok) expect(evidence.run.reason).toContain("run 목록");
  });

  it("존재하지 않는 dataset이면 dataset을 실패로 표시하지만 전체를 던지지 않는다", async () => {
    const evidence = await fetchReportEvidence("does-not-exist", "does-not-exist-run");

    expect(evidence.dataset.ok).toBe(false);
    expect(evidence.run.ok).toBe(false);
    expect(evidence.quality.ok).toBe(false);
  });

  it("mock/demo 모드에서는 output evidence를 신뢰할 수 있는 형태로 제공하지 않는다(임의 데이터를 만들지 않음)", async () => {
    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");
    expect(evidence.output.ok).toBe(false);
  });

  it("evidenceRefs는 실제로 확인된 조각만 포함한다", async () => {
    const evidence = await fetchReportEvidence("air-quality", "air-2026-08-14");
    const refs = buildEvidenceRefs(evidence);

    expect(refs.some((r) => r.kind === "dataset" && r.id === "air-quality")).toBe(true);
    expect(refs.some((r) => r.kind === "run" && r.id === "air-2026-08-14")).toBe(true);
    expect(refs.some((r) => r.kind === "output")).toBe(false);
  });
});
