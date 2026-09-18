import { describe, expect, it } from "vitest";
import { normalizeBuildContextSearch } from "./buildContext";
import type { AsyncState } from "./asyncState";
import type { BuildSpecSnapshotResponse, RunStagesResponse } from "@/shared/lib/builderApi";

const loadingSpec: AsyncState<BuildSpecSnapshotResponse> = { status: "loading" };
const loadingStages: AsyncState<RunStagesResponse> = { status: "loading" };
const loadedSpec: AsyncState<BuildSpecSnapshotResponse> = {
  status: "loaded",
  data: { run_id: "run-1", spec: "dataset_id: dataset-1\n", spec_digest: "sha256:test" },
};

function source(source_key: string, gold: "completed" | "failed" | "not_run" = "completed") {
  return {
    source_key,
    bronze: { status: "completed" as const, available: true },
    silver: { status: "completed" as const, available: true },
    gold: { status: gold, available: gold === "completed" },
  };
}

function loadedStages(sources: RunStagesResponse["sources"]): AsyncState<RunStagesResponse> {
  return { status: "loaded", data: { run_id: "run-1", sources } };
}

function normalize(query: string, spec = loadingSpec, stages = loadingStages): URLSearchParams {
  return normalizeBuildContextSearch(new URLSearchParams(query), spec, stages);
}

describe("Builds Kubi context URL normalization", () => {
  it("preserves valid-looking source/stage while stages are loading", () => {
    expect(normalize("source=B&stage=gold").toString()).toBe("source=B&stage=gold");
  });

  it("preserves dataset while the spec is loading", () => {
    expect(normalize("dataset=dataset-1").get("dataset")).toBe("dataset-1");
  });

  it("retains loaded valid dataset/source/stage", () => {
    const result = normalize("dataset=dataset-1&source=A&stage=gold", loadedSpec, loadedStages([source("A"), source("B")]));
    expect(result.toString()).toBe("dataset=dataset-1&source=A&stage=gold");
  });

  it("removes an invalid source after stages load", () => {
    const result = normalize("source=ghost&stage=gold", loadedSpec, loadedStages([source("A"), source("B")]));
    expect(result.has("source")).toBe(false);
    expect(result.has("stage")).toBe(false);
  });

  it("rejects a stage that is not_run for the selected source even when another source completed it", () => {
    const result = normalize("source=B&stage=gold", loadedSpec, loadedStages([source("A"), source("B", "not_run")]));
    expect(result.get("source")).toBe("B");
    expect(result.has("stage")).toBe(false);
  });

  it("keeps single-source auto source behavior", () => {
    const result = normalize("stage=gold", loadedSpec, loadedStages([source("only.source")]));
    expect(result.get("source")).toBe("only.source");
    expect(result.get("stage")).toBe("gold");
  });

  it("keeps the unique failedStage fallback", () => {
    const result = normalize("", loadedSpec, loadedStages([source("A"), source("B", "failed")]));
    expect(result.get("stage")).toBe("gold");
  });
});
