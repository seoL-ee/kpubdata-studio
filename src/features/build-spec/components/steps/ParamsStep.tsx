/** 마법사 3단계 — 요청 파라미터 (#379). */
import { useTranslation } from "react-i18next";
import type { FieldErrors, UseFormRegister } from "react-hook-form";

import { i18n } from "@/shared/i18n";
import { parseSourceParams } from "@/features/build-spec/paramsInput";
import { FormField, Textarea } from "@/shared/ui";
import type { BuildFormValues } from "@/features/build-spec/newBuildModel";

export interface ParamsStepProps {
  register: UseFormRegister<BuildFormValues>;
  errors: FieldErrors<BuildFormValues>;
}

export function ParamsStep({ register, errors }: ParamsStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.params.title")}</h3>
      <FormField
        id="sourceParams"
        label={t("newBuild.params.label")}
        help={t("newBuild.params.help")}
        error={errors.sourceParams?.message}
      >
        {(field) => (
          <Textarea
            mono
            rows={8}
            {...field}
            {...register("sourceParams", {
              required: i18n.t("newBuild.errors.paramsRequired"),
              // JSON 문법/객체 여부를 단계 이동(trigger) 시점에 바로 막고 필드에 표시한다.
              validate: (value) => parseSourceParams(value).error ?? true,
            })}
          />
        )}
      </FormField>
    </div>
  );
}
