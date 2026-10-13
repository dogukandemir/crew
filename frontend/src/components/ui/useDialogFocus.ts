import { useEffect, useRef } from 'react';

const dialogs: HTMLElement[] = [];
const selectors = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** A shared focus boundary for drawers and stacked dialogs. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const siblings = Array.from(document.body.children).filter((el) => el !== dialog);
    const inert = siblings.map((el) => el.hasAttribute('inert'));
    siblings.forEach((el) => el.setAttribute('inert', ''));
    dialogs.push(dialog);
    const targets = () => Array.from(dialog.querySelectorAll<HTMLElement>(selectors))
      .filter((el) => !el.closest('[hidden],[inert]') && el.getAttribute('aria-hidden') !== 'true');
    const focusFirst = () => (targets()[0] ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const items = targets();
        const first = items[0] ?? dialog;
        const last = items.at(-1) ?? dialog;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const focus = (event: FocusEvent) => {
      if (dialogs.at(-1) === dialog && !dialog.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    focusFirst();
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      const index = dialogs.indexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      siblings.forEach((el, i) => { if (!inert[i]) el.removeAttribute('inert'); });
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
    };
  }, [open]);
  return ref;
}
