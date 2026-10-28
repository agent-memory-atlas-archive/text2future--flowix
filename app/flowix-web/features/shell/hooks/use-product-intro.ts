import { useCallback, useEffect, useRef, useState } from 'react';

const PRODUCT_INTRO_AUTO_SHOWN_KEY = 'flowix:product-intro:auto-shown';

/**
 * Owns the product intro dialog state for the main layout: it auto-opens
 * once per install after onboarding finishes (guarded by localStorage), and
 * defers a pending app-updater result until the intro/onboarding is closed so
 * the two dialogs never stack.
 */
export function useProductIntro({
  hasPendingAppUpdateResult,
  onboardingLoading,
  onboardingOpen,
  presentPendingAppUpdateResult,
}: {
  hasPendingAppUpdateResult: boolean;
  onboardingLoading: boolean;
  onboardingOpen: boolean;
  presentPendingAppUpdateResult: () => void;
}) {
  const [productIntroOpen, setProductIntroOpen] = useState(false);
  const productIntroAutoShownRef = useRef(false);

  const showProductIntroAfterOnboarding = useCallback(() => {
    if (productIntroAutoShownRef.current) return;
    productIntroAutoShownRef.current = true;

    try {
      if (window.localStorage.getItem(PRODUCT_INTRO_AUTO_SHOWN_KEY) === 'true') return;
      window.localStorage.setItem(PRODUCT_INTRO_AUTO_SHOWN_KEY, 'true');
    } catch {
      // Keep the in-memory guard so a storage failure cannot reopen it repeatedly.
    }

    setProductIntroOpen(true);
  }, []);

  useEffect(() => {
    if (!hasPendingAppUpdateResult
      || onboardingLoading
      || onboardingOpen
      || productIntroOpen) return;
    const frame = window.requestAnimationFrame(() => presentPendingAppUpdateResult());
    return () => window.cancelAnimationFrame(frame);
  }, [
    hasPendingAppUpdateResult,
    onboardingLoading,
    onboardingOpen,
    productIntroOpen,
    presentPendingAppUpdateResult,
  ]);

  return { productIntroOpen, setProductIntroOpen, showProductIntroAfterOnboarding };
}
