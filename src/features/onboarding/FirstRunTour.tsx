import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Button } from "@/shared/ui/Button";

export const ONBOARDING_STORAGE_KEY_PREFIX = "kpubdata:onboarding:v2";
const ONBOARDING_STORAGE_KEY = "kpubdata:onboarding:v1";

export function onboardingStorageKey(userId: string): string {
  return `${ONBOARDING_STORAGE_KEY_PREFIX}:${userId}`;
}

const emptyWorkspaceSteps = [
  { target: "sidebar" },
  { target: "workflow" },
  { target: "start-actions" },
  { target: "kubi-helper" },
] as const;

const dashboardSteps = [
  { target: "sidebar" },
  { target: "dashboard-overview" },
  { target: "dashboard-builds" },
  { target: "dashboard-quality" },
] as const;

function hasCompletedTour(userId: string) {
  try { return localStorage.getItem(onboardingStorageKey(userId)) === "complete"; } catch { return false; }
}

export function resetFirstRunTour(userId?: unknown) {
  try { localStorage.removeItem(ONBOARDING_STORAGE_KEY); } catch { /* storage를 사용할 수 없어도 수동 재생은 가능하다. */ }
  window.dispatchEvent(new CustomEvent("kpubdata:onboarding:replay", { detail: userId }));
}

export function FirstRunTour({
  userId,
  autoStart = true,
  variant = "empty-workspace",
}: {
  userId: string;
  autoStart?: boolean;
  variant?: "empty-workspace" | "dashboard";
}) {
  const { t } = useTranslation();
  const steps = variant === "dashboard" ? dashboardSteps : emptyWorkspaceSteps;
  const [open, setOpen] = useState(() => autoStart && !hasCompletedTour(userId));
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const replay = (event: Event) => {
      const requestedUserId = (event as CustomEvent<string | Event>).detail;
      if (typeof requestedUserId === "string" && requestedUserId !== userId) return;
      setStep(0); setOpen(true);
    };
    window.addEventListener("kpubdata:onboarding:replay", replay);
    return () => window.removeEventListener("kpubdata:onboarding:replay", replay);
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previousFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = () => setRect(document.querySelector<HTMLElement>(`[data-tour="${steps[step].target}"]`)?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, step, steps]);

  function close() {
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, "complete"); } catch { /* 비필수 저장소 */ }
    try { localStorage.setItem(onboardingStorageKey(userId), "complete"); } catch { /* storage unavailable */ }
    setOpen(false);
  }

  if (!open || typeof document === "undefined") return null;
  const width = Math.min(336, window.innerWidth - 24);
  const left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) : 12;
  const below = rect ? rect.bottom + 12 : 80;
  const top = Math.max(12, Math.min(below, window.innerHeight - 230));

  return createPortal(
    <>
      <div className="fixed inset-0 z-[80] bg-black/20" aria-hidden="true" />
      {rect ? <div aria-hidden="true" className="pointer-events-none fixed z-[81] rounded-xl ring-4 ring-accent ring-offset-4 ring-offset-background" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} /> : null}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
        className="fixed z-[82] rounded-xl border border-border bg-card p-5 text-foreground shadow-xl outline-none"
        style={{ left, top, width }}
      >
        <p className="text-xs font-semibold text-accent-subtle-foreground">{step + 1} / {steps.length}</p>
        <h2 id="onboarding-title" className="mt-1 text-base font-semibold">
          {t(`onboarding.steps.${steps[step].target}.title`)}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(`onboarding.steps.${steps[step].target}.copy`)}
        </p>
        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={close}>{t("onboarding.skip")}</Button>
          <div className="flex gap-2">
            {step > 0 ? <Button variant="secondary" size="sm" onClick={() => setStep((value) => value - 1)}>{t("onboarding.back")}</Button> : null}
            {step < steps.length - 1
              ? <Button size="sm" onClick={() => setStep((value) => value + 1)}>{t("onboarding.next")}</Button>
              : <Button size="sm" onClick={close}>{t("onboarding.done")}</Button>}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
