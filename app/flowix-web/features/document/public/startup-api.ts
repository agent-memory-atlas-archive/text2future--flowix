import { useDocumentStore } from '@features/document/store/document-store';

/** Wait for the restored document's content load to finish before disk maintenance starts. */
export function waitForInitialDocumentLoad(timeoutMs = 60_000): Promise<'settled' | 'skipped' | 'superseded' | 'timeout'> {
  const initial = useDocumentStore.getState();
  if (!initial.isDocumentTransitioning) {
    return Promise.resolve(initial.activeMemoSession || initial.activeExternalSession ? 'settled' : 'skipped');
  }
  const transitionId = initial.documentTransitionId;

  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: 'settled' | 'superseded' | 'timeout') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    unsubscribe = useDocumentStore.subscribe((state) => {
      if (state.documentTransitionId !== transitionId) finish('superseded');
      else if (!state.isDocumentTransitioning) finish('settled');
    });
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    // The transition may finish between the first snapshot and subscribe().
    const current = useDocumentStore.getState();
    if (current.documentTransitionId !== transitionId) finish('superseded');
    else if (!current.isDocumentTransitioning) finish('settled');
  });
}
