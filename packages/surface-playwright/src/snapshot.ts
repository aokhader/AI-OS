/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The in-page accessibility walker. This function is serialised by Playwright and evaluated inside
 * every frame, so it must be self-contained: no imports, no references to module scope.
 *
 * It produces the surface-agnostic node list described in docs/context/01-architecture.md §5:
 * a role derived from HTML semantics, an accessible name, a value, states, a bounding box and a
 * structural path. Element handles for the refs are kept on `window.__handsoff_refs` so the
 * surface can act on a ref from the same observation.
 */
export interface RawSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  bbox: { x: number; y: number; w: number; h: number };
  path: string;
  parentRef?: string;
}

export interface RawSnapshot {
  url: string;
  title: string;
  nodes: RawSnapshotNode[];
  count: number;
}

export function snapshotDocument(arg: { start: number }): RawSnapshot {
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
    'OPTION',
    'FRAME',
    'IFRAME',
    'FRAMESET',
    'SVG',
  ]);
  const TRANSPARENT = new Set(['TBODY', 'THEAD', 'TFOOT']);
  const TEXT_CONTAINERS = new Set([
    'DIV',
    'SPAN',
    'P',
    'FONT',
    'B',
    'I',
    'U',
    'STRONG',
    'EM',
    'SMALL',
    'LI',
    'LABEL',
    'LEGEND',
    'DT',
    'DD',
    'CENTER',
    'PRE',
    'CODE',
    'BLOCKQUOTE',
  ]);
  const NO_TEXT_UNDER = new Set(['cell', 'columnheader', 'link', 'button', 'heading', 'text']);

  const refs: Record<string, Element> = {};
  (window as unknown as { __handsoff_refs?: Record<string, Element> }).__handsoff_refs = refs;
  const nodes: RawSnapshotNode[] = [];
  let counter = arg.start;

  const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  const ownText = (el: Element): string => {
    let t = '';
    el.childNodes.forEach((c) => {
      if (c.nodeType === 3) t += ` ${c.textContent ?? ''}`;
    });
    return collapse(t);
  };

  const allText = (el: Element): string => collapse(el.textContent);

  const visible = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

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

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    switch (el.tagName) {
      case 'A':
        return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON':
        return 'button';
      case 'INPUT': {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (type === 'hidden') return null;
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
      case 'TD':
        return 'cell';
      case 'TH':
        return 'columnheader';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return 'heading';
      case 'IMG':
        return collapse(el.getAttribute('alt')) ? 'image' : null;
      default:
        return TEXT_CONTAINERS.has(el.tagName) && ownText(el) ? 'text' : null;
    }
  };

  const labelFor = (el: Element): string | undefined => {
    const id = (el as HTMLInputElement).id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return allText(label);
    }
    const wrapping = el.closest('label');
    if (wrapping) return allText(wrapping);
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
      case 'IMG':
        return collapse(el.getAttribute('alt'));
      default:
        return role === 'text' ? ownText(el) : allText(el);
    }
  };

  const controlValue = (el: Element, role: string): string | undefined => {
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'password') return undefined;
      return role === 'textbox' ? input.value : undefined;
    }
    if (el.tagName === 'TEXTAREA') return (el as HTMLTextAreaElement).value;
    if (el.tagName === 'SELECT') {
      const option = (el as HTMLSelectElement).selectedOptions[0];
      return option ? collapse(option.textContent) : '';
    }
    return undefined;
  };

  const statesOf = (el: Element): string[] => {
    const s: string[] = [];
    const control = el as HTMLInputElement;
    if (control.disabled) s.push('disabled');
    if (document.activeElement === el) s.push('focused');
    if (control.checked) s.push('checked');
    if (control.readOnly) s.push('readonly');
    if (control.required) s.push('required');
    return s;
  };

  const walk = (el: Element, parentRef: string | undefined, parentRole: string | undefined) => {
    if (SKIP.has(el.tagName)) return;
    if (!visible(el)) return;
    let role = roleOf(el);
    if (role === 'text' && parentRole && NO_TEXT_UNDER.has(parentRole)) role = null;
    let myRef = parentRef;
    let myRole = parentRole;
    if (role) {
      counter += 1;
      const ref = `e${counter}`;
      refs[ref] = el;
      const r = el.getBoundingClientRect();
      const node: RawSnapshotNode = {
        ref,
        role,
        name: nameOf(el, role),
        states: statesOf(el),
        bbox: { x: r.left, y: r.top, w: r.width, h: r.height },
        path: pathOf(el),
      };
      const value = controlValue(el, role);
      if (value !== undefined) node.value = value;
      if (parentRef) node.parentRef = parentRef;
      nodes.push(node);
      myRef = ref;
      myRole = role;
    }
    for (const child of Array.from(el.children)) walk(child, myRef, myRole);
  };

  if (document.body) walk(document.body, undefined, undefined);
  return { url: location.href, title: document.title, nodes, count: counter - arg.start };
}
