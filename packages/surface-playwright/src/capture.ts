/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The in-page human-action capture (01 §11, D-036). Serialised by Playwright and installed in
 * every frame, so it must be self-contained: no imports, no module scope. It reports clicks on
 * interactive controls, value changes and Enter-key submits through an exposed binding, with the
 * element described the way the snapshot describes it: role, accessible name, structural path.
 */
export interface RawHumanEvent {
  kind: 'click' | 'change' | 'submit';
  tag: string;
  path: string;
  role: string;
  name: string;
  value?: string;
  inputType?: string;
  at: string;
}

export function installHumanCapture(arg: { binding: string }): boolean {
  const w = window as unknown as Record<string, unknown>;
  if (w.__handsoff_capture) return false;
  w.__handsoff_capture = true;

  const TRANSPARENT = new Set(['TBODY', 'THEAD', 'TFOOT']);
  const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  const pathOf = (el: Element): string => {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (!TRANSPARENT.has(cur.tagName)) {
        let index = 1;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) index += 1;
          sib = sib.previousElementSibling;
        }
        segs.unshift(`${cur.tagName.toLowerCase()}[${index}]`);
      }
      cur = cur.parentElement;
    }
    return segs.join('/');
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    switch (el.tagName) {
      case 'A':
        return 'link';
      case 'BUTTON':
        return 'button';
      case 'INPUT': {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
          return 'button';
        }
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      case 'SELECT':
        return 'combobox';
      case 'TEXTAREA':
        return 'textbox';
      default:
        return el.tagName.toLowerCase();
    }
  };

  const labelFor = (el: Element): string | undefined => {
    const id = (el as HTMLInputElement).id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return collapse(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) return collapse(wrapping.textContent);
    return undefined;
  };

  const nameOf = (el: Element, role: string): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return collapse(aria);
    switch (el.tagName) {
      case 'INPUT': {
        const input = el as HTMLInputElement;
        if (role === 'button') {
          return collapse(input.value) || (input.type === 'submit' ? 'Submit' : 'Button');
        }
        return labelFor(el) ?? (collapse(input.title) || collapse(input.placeholder));
      }
      case 'SELECT':
      case 'TEXTAREA':
        return labelFor(el) ?? collapse((el as HTMLElement).title);
      default:
        return collapse(el.textContent).slice(0, 120);
    }
  };

  const controlValueOf = (el: Element): string | undefined => {
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'password') return undefined;
      if (input.type === 'checkbox' || input.type === 'radio') {
        return input.checked ? 'checked' : 'unchecked';
      }
      return input.value;
    }
    if (el.tagName === 'TEXTAREA') return (el as HTMLTextAreaElement).value;
    if (el.tagName === 'SELECT') {
      const option = (el as HTMLSelectElement).selectedOptions[0];
      return option ? collapse(option.textContent) : '';
    }
    return undefined;
  };

  // A change only counts when the person produced input since capture started: a field automation
  // filled fires a stale change when the person clicks away from it.
  let touched = new WeakSet<Element>();
  w.__handsoff_capture_reset = () => {
    touched = new WeakSet<Element>();
  };
  document.addEventListener(
    'input',
    (e) => {
      if (e.target instanceof Element) touched.add(e.target);
    },
    true,
  );

  const report = (event: RawHumanEvent): void => {
    const fn = w[arg.binding];
    if (typeof fn === 'function') void (fn as (e: RawHumanEvent) => unknown)(event);
  };

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest(
        'a[href],button,input,select,textarea,[role="button"],[role="link"]',
      );
      if (!el) return;
      const role = roleOf(el);
      // Focusing a field is not an action; checkboxes and radios report through change.
      if (role === 'textbox' || role === 'combobox' || role === 'checkbox' || role === 'radio') {
        return;
      }
      report({
        kind: 'click',
        tag: el.tagName,
        path: pathOf(el),
        role,
        name: nameOf(el, role),
        at: new Date().toISOString(),
      });
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (
        !(
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        )
      ) {
        return;
      }
      if (!touched.has(el)) return;
      touched.delete(el);
      const role = roleOf(el);
      const value = controlValueOf(el);
      report({
        kind: 'change',
        tag: el.tagName,
        path: pathOf(el),
        role,
        name: nameOf(el, role),
        ...(value !== undefined ? { value } : {}),
        ...(el instanceof HTMLInputElement ? { inputType: el.type } : {}),
        at: new Date().toISOString(),
      });
    },
    true,
  );

  document.addEventListener(
    'submit',
    (e) => {
      // A click on the submit button was already reported; only an Enter-key submit is new.
      if ((e as SubmitEvent).submitter) return;
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (!form) return;
      report({
        kind: 'submit',
        tag: 'FORM',
        path: pathOf(form),
        role: 'form',
        name: collapse(form.getAttribute('action')),
        at: new Date().toISOString(),
      });
    },
    true,
  );

  return true;
}
