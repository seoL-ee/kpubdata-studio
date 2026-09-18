/**
 * 자연어 → BuildSpec 생성 + 리페어 루프 (ST-A7, #210).
 *
 * 4중 게이트 환각 차단:
 * ① zod 파싱 → ② 카탈로그 대조 → ③ Builder /validate → ④ 사용자 승인
 * 각 게이트 실패 시 최대 2회 재생성. 상한 초과 시 부분 결과 반환.
 * 승인 전 /build 호출 금지.
 */
import type { AssistProvider, AssistMessage } from "./provider";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { CatalogResponse, ValidateResponse } from "@/shared/lib/builderApi";
import { parse } from "yaml";
import { z } from "zod";
import { i18n } from "@/shared/i18n";

/**
 * 사용자에게 보이는 문제 메시지만 옮긴다(#350). LLM에 보내는 시스템 프롬프트와
 * 재시도 지시문은 번역하지 않는다 — 어시스턴트의 출력 언어·품질을 바꾸는 별개 결정이다.
 */
const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(`assistant.generate.${key}`, params ?? {});

export interface GenerationResult {
  spec: string | null;
  status: "ok" | "partial" | "error";
  attempts: number;
  remaining_problems: string[];
}

const MAX_REPAIR_ATTEMPTS = 2;

const generatedBuildSpecSchema = z.object({
  dataset_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  sources: z.array(
    z.object({
      provider: z.string().min(1),
      dataset: z.string().min(1),
    }).passthrough(),
  ).min(1),
}).passthrough();

export interface GenerationOptions {
  catalog: CatalogResponse;
  validateFn: (spec: string, signal?: AbortSignal) => Promise<ValidateResponse>;
  signal?: AbortSignal;
}

function catalogProblems(
  spec: z.infer<typeof generatedBuildSpecSchema>,
  catalog: CatalogResponse,
): string[] {
  const providers = new Map(
    catalog.providers.map((provider) => [
      provider.name,
      new Set(provider.datasets.map((dataset) => dataset.name)),
    ]),
  );
  const problems: string[] = [];
  spec.sources.forEach((source, index) => {
    const datasets = providers.get(source.provider);
    if (!datasets) {
      problems.push(t("unknownProvider", { index, provider: source.provider }));
    } else if (!datasets.has(source.dataset)) {
      problems.push(
        t("unknownDataset", { index, provider: source.provider, dataset: source.dataset }),
      );
    }
  });
  return problems;
}

function parseGeneratedSpec(spec: string) {
  try {
    return generatedBuildSpecSchema.safeParse(parse(spec, { maxAliasCount: 10 }));
  } catch (error) {
    return {
      success: false as const,
      error: new z.ZodError([
        {
          code: "custom",
          path: [],
          message: error instanceof Error ? error.message : t("yamlParse"),
        },
      ]),
    };
  }
}

function extractYaml(rawOutput: string): string {
  const fenced = rawOutput.match(/```(?:yaml|yml)\s*\n([\s\S]*?)\n```/i);
  return (fenced?.[1] ?? rawOutput).trim();
}

export async function generateBuildSpec(
  provider: AssistProvider,
  userPrompt: string,
  options: GenerationOptions,
): Promise<GenerationResult> {
  if (!isRealBuilderEnabled()) {
    return {
      spec: null,
      status: "error",
      attempts: 0,
      remaining_problems: [t("mockDisabled")],
    };
  }

  if (!options?.validateFn) {
    return {
      spec: null,
      status: "error",
      attempts: 0,
      remaining_problems: [t("noValidate")],
    };
  }

  const availableCatalog = options.catalog.providers
    .filter((provider) => provider.datasets.length > 0);
  if (availableCatalog.length === 0) {
    return {
      spec: null,
      status: "error",
      attempts: 0,
      remaining_problems: [t("noCatalog")],
    };
  }

  const catalogContext = availableCatalog
    .map((provider) => `${provider.name}: ${provider.datasets.map((dataset) => dataset.name).join(", ")}`)
    .join("\n");

  // i18n-ignore: LLM 시스템 프롬프트 — 어시스턴트 출력 언어는 별개 결정이다(#350).
  const systemPrompt = `당신은 한국 공공데이터 BuildSpec 생성기입니다.
사용자의 자연어 요청을 BuildSpec YAML로 변환하세요.
사용 가능한 provider/dataset:\n${catalogContext}\n
목록 밖의 provider/dataset은 사용하지 마세요.
YAML만 출력하세요. 설명은 출력하지 마세요.`;

  let lastProblems: string[] = [];

  for (let attempts = 1; attempts <= MAX_REPAIR_ATTEMPTS + 1; attempts++) {
    const messages: AssistMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    if (lastProblems.length > 0) {
      messages.push({
        role: "assistant",
        // i18n-ignore: 모델에 되먹이는 대화 스캐폴딩 — 화면에 뜨지 않는다.
        content: "이전 출력에 오류가 있었습니다. 수정하겠습니다.",
      });
      messages.push({
        role: "user",
        // i18n-ignore: 모델에 되먹이는 재시도 지시문 — 화면에 뜨지 않는다.
        content: `오류:\n${lastProblems.join("\n")}\n\n이 오류를 수정한 YAML을 다시 출력하세요.`,
      });
    }

    const exchange = provider.exchange(messages, options.signal);
    let rawOutput = "";
    for await (const chunk of exchange.output) {
      rawOutput += chunk;
    }

    // ① YAML parse + 최소 BuildSpec source 구조 검증
    const spec = extractYaml(rawOutput);

    if (!spec) {
      lastProblems = [t("emptyOutput")];
      continue;
    }

    const parsed = parseGeneratedSpec(spec);
    if (!parsed.success) {
      lastProblems = parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "spec"}: ${issue.message}`
      );
      continue;
    }

    // ② typed /catalog 대조
    const groundingProblems = catalogProblems(parsed.data, options.catalog);
    if (groundingProblems.length > 0) {
      lastProblems = groundingProblems;
      continue;
    }

    let restoredSpec: string;
    try {
      restoredSpec = exchange.restoreText(spec);
    } catch (error) {
      return {
        spec: null,
        status: "error",
        attempts,
        remaining_problems: [
          error instanceof Error ? error.message : t("restoreFailed"),
        ],
      };
    }

    // ③ Builder 검증
    let validation: ValidateResponse;
    try {
      validation = await options.validateFn(restoredSpec, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return {
        spec: null,
        status: "error",
        attempts,
        remaining_problems: [
          error instanceof Error ? error.message : t("validateRequestFailed"),
        ],
      };
    }
    if (validation.status === "valid") {
      return { spec: restoredSpec, status: "ok", attempts, remaining_problems: [] };
    }
    if (validation.status === "invalid") {
      lastProblems = validation.problems.length > 0 ? validation.problems : [t("validationFailed")];
      continue;
    }
    return {
      spec: null,
      status: "error",
      attempts,
      remaining_problems: [validation.error],
    };
  }

  return {
    spec: null,
    status: "partial",
    attempts: MAX_REPAIR_ATTEMPTS + 1,
    remaining_problems: lastProblems,
  };
}
