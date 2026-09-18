/** 마법사 5단계 — 출력 형식과 경로 (#379). */
import { useTranslation } from "react-i18next";
import type { FieldErrors, UseFormRegister } from "react-hook-form";

import { i18n } from "@/shared/i18n";
import { exportFormatSchema } from "@/shared/lib/schemas";
import { FormField, TextInput } from "@/shared/ui";
import type { BuildFormValues } from "@/features/build-spec/newBuildModel";

const exportFormats = exportFormatSchema.options;

export interface OutputStepProps {
  register: UseFormRegister<BuildFormValues>;
  errors: FieldErrors<BuildFormValues>;
}

export function OutputStep({ register, errors }: OutputStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.output.title")}</h3>
      <fieldset>
        <legend className="text-sm font-medium text-foreground">{t("newBuild.output.formatsLabel")}</legend>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {exportFormats.map((format) => (
            <label
              key={format}
              className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3"
            >
              <input
                type="checkbox"
                value={format}
                className="h-4 w-4 accent-emerald-600"
                {...register("exportFormats", {
                  validate: (selected) =>
                    (selected?.length ?? 0) > 0 || i18n.t("newBuild.errors.outputRequired"),
                })}
              />
              <span className="text-sm font-medium capitalize">{format}</span>
            </label>
          ))}
        </div>
        {errors.exportFormats ? (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {errors.exportFormats.message}
          </p>
        ) : null}
      </fieldset>
      <FormField id="outputPath" label={t("newBuild.output.pathLabel")} required error={errors.outputPath?.message}>
        {(field) => (
          <TextInput
            placeholder="artifacts/builds/air-quality"
            {...field}
            {...register("outputPath", { required: i18n.t("newBuild.errors.outputPathRequired") })}
          />
        )}
      </FormField>
    </div>
  );
}
