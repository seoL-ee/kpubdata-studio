import { useTranslation } from "react-i18next";
import { glossaryDescription, type GlossaryKey } from "@/shared/content/glossary";
import { HelpTooltip } from "./HelpTooltip";

export function TermHelp({ term }: { term: GlossaryKey }) {
  const { t } = useTranslation();
  return (
    <HelpTooltip label={t("glossary.helpLabel", { term })} content={glossaryDescription(term)} />
  );
}
