/** 마법사 1단계 — 데이터셋 기본 정보 (#379). */
import { useTranslation } from "react-i18next";
import type { FieldErrors, UseFormRegister } from "react-hook-form";

import { i18n } from "@/shared/i18n";
import { FormField, TextInput, Textarea } from "@/shared/ui";
import type { BuildFormValues } from "@/features/build-spec/newBuildModel";

export interface IdentityStepProps {
  register: UseFormRegister<BuildFormValues>;
  errors: FieldErrors<BuildFormValues>;
}

export function IdentityStep({ register, errors }: IdentityStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.identity.title")}</h3>
      <FormField
        id="datasetId"
        label={t("newBuild.identity.datasetIdLabel")}
        required
        help={t("newBuild.identity.datasetIdHelp")}
        error={errors.datasetId?.message}
      >
        {(field) => (
          <TextInput
            placeholder="kma-daily-observations"
            {...field}
            {...register("datasetId", { required: i18n.t("newBuild.errors.datasetIdRequired") })}
          />
        )}
      </FormField>
      <FormField id="title" label={t("newBuild.identity.titleLabel")} required error={errors.title?.message}>
        {(field) => (
          <TextInput
            placeholder={t("newBuild.identity.titlePlaceholder")}
            {...field}
            {...register("title", { required: i18n.t("newBuild.errors.titleRequired") })}
          />
        )}
      </FormField>
      <FormField
        id="description"
        label={t("newBuild.identity.descLabel")}
        required
        help={t("newBuild.identity.descHelp")}
        error={errors.description?.message}
      >
        {(field) => (
          <Textarea
            {...field}
            {...register("description", { required: i18n.t("newBuild.errors.descriptionRequired") })}
          />
        )}
      </FormField>
    </div>
  );
}
