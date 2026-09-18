/**
 * New Build 마법사의 시작 템플릿 (#379로 NewBuildPage에서 분리).
 *
 * 템플릿은 catalog 에 실제로 있는 provider/dataset 일 때만 고를 수 있다 — 없는 조합을
 * 눌러 두고 다음 단계에서 실패하게 두지 않는다.
 */
import {
  catalogDataset,
  initialValues,
  type BuildFormValues,
  type CatalogState,
} from "@/features/build-spec/newBuildModel";
import { i18n } from "@/shared/i18n";

export interface BuildTemplate {
  id: string;
  name: string;
  description: string;
  values: BuildFormValues;
}

export const TEMPLATES: BuildTemplate[] = [
  {
    id: "blank",
    name: i18n.t("newBuild.templates.blank"),
    description: i18n.t("newBuild.templates.blankDesc"),
    values: initialValues,
  },
  {
    id: "air_quality",
    name: i18n.t("newBuild.templates.air"),
    description: i18n.t("newBuild.templates.airDesc"),
    values: {
      datasetId: "datago-air-quality",
      title: i18n.t("newBuild.templates.airTitle"),
      description: i18n.t("newBuild.templates.airSourceDesc"),
      provider: "datago",
      sourceDataset: "air_quality",
      sourceParams: '{"sidoName": "서울"}',
      outputPath: "artifacts/builds/air-quality",
      exportFormats: ["jsonl"],
    },
  },
  {
    id: "interest_rate",
    name: i18n.t("newBuild.templates.rate"),
    description: i18n.t("newBuild.templates.rateDesc"),
    values: {
      datasetId: "bok-interest-rate",
      title: i18n.t("newBuild.templates.rateTitle"),
      description: i18n.t("newBuild.templates.rateSourceDesc"),
      provider: "bok",
      sourceDataset: "base_rate",
      sourceParams: '{"stat_code": "722Y001"}',
      outputPath: "artifacts/builds/bok-interest-rate",
      exportFormats: ["jsonl", "parquet"],
    },
  },
  {
    id: "population",
    name: i18n.t("newBuild.templates.pop"),
    description: i18n.t("newBuild.templates.popDesc"),
    values: {
      datasetId: "kosis-population",
      title: i18n.t("newBuild.templates.popTitle"),
      description: i18n.t("newBuild.templates.popSourceDesc"),
      provider: "kosis",
      sourceDataset: "population_migration",
      sourceParams: '{"region": "11"}',
      outputPath: "artifacts/builds/population",
      exportFormats: ["jsonl"],
    },
  },
];

export function isTemplateAvailable(template: BuildTemplate, catalog: CatalogState): boolean {
  if (!template.values.provider || !template.values.sourceDataset || catalog.status !== "loaded") return true;
  return catalogDataset(catalog.providers, template.values.provider, template.values.sourceDataset) !== undefined;
}

