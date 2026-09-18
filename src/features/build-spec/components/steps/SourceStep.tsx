/** 마법사 2단계 — 데이터 소스 선택 (#379). */
import { useTranslation } from "react-i18next";
import type { FieldErrors, UseFormRegister } from "react-hook-form";

import { i18n } from "@/shared/i18n";
import { FormField, Select } from "@/shared/ui";
import type { BuildFormValues, CatalogState } from "@/features/build-spec/newBuildModel";
import type { CatalogDataset } from "@/shared/lib/builderApi";

export interface SourceStepProps {
  register: UseFormRegister<BuildFormValues>;
  errors: FieldErrors<BuildFormValues>;
  catalog: CatalogState;
  providerOptions: { value: string; label: string }[];
  datasetOptions: CatalogDataset[];
  selectedProvider: string;
}

export function SourceStep({
  register,
  errors,
  catalog,
  providerOptions,
  datasetOptions,
  selectedProvider,
}: SourceStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.source.title")}</h3>
      <FormField id="provider" label={t("newBuild.source.providerLabel")} required error={errors.provider?.message}>
        {(field) => (
          <Select {...field} {...register("provider", { required: i18n.t("newBuild.errors.providerRequired") })}>
            <option value="">{t("newBuild.source.providerSelect")}</option>
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        id="sourceDataset"
        label={t("newBuild.source.datasetLabel")}
        required
        help={t("newBuild.source.datasetHelp")}
        error={errors.sourceDataset?.message}
      >
        {(field) => (
          <Select
            {...field}
            disabled={!selectedProvider || datasetOptions.length === 0}
            {...register("sourceDataset", { required: i18n.t("newBuild.errors.datasetRequired") })}
          >
            <option value="">{t("newBuild.source.datasetSelect")}</option>
            {datasetOptions.map((dataset) => (
              <option key={dataset.name} value={dataset.name}>
                {dataset.title} ({dataset.name})
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {catalog.status === "loading" ? (
        <p className="text-sm text-muted-foreground">{t("newBuild.template.catalogLoading")}</p>
      ) : null}
      {catalog.status === "error" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {catalog.error}
        </p>
      ) : null}
    </div>
  );
}
