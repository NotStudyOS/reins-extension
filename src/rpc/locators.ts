import type {
  ClickByLabelParams,
  ClickByLabelResult,
  FillFormFromJsonParams,
  FillFormFromJsonResult,
  LocatorHealParams,
  LocatorHealResult,
  PageMapParams,
  PageMapResult,
  SelectorSuggestParams,
  SelectorSuggestResult,
} from "../shared/protocol";

/**
 * locators — element-finding ergonomics.
 *
 * page_map         — landmark/heading/form/button/link inventory, or
 *                    rich `describe` for a single element.
 * selector_suggest — generate stable CSS selectors for an element.
 * locator_heal     — take a broken selector + hints, return ranked candidates.
 * click_by_label   — click via visible label/aria-label, not CSS.
 * fill_form_from_json — populate a form from {fieldName: value}.
 */
export const locatorHandlers: Record<string, (p: any) => Promise<unknown>> = {
  page_map: async (p: PageMapParams): Promise<PageMapResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runPageMap as any,
      args: [p.selector ?? null, p.describe ?? null, p.perSection ?? 50],
    });
    // Frames listed via webNavigation API for accurate IDs.
    const out = result as PageMapResult;
    if (!p.describe) {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: p.tabId });
        out.frames = (frames ?? []).map((f) => ({ frameId: String(f.frameId), url: f.url }));
      } catch {}
    }
    return out;
  },

  selector_suggest: async (p: SelectorSuggestParams): Promise<SelectorSuggestResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runSelectorSuggest as any,
      args: [p.fromSelector ?? null, p.fromText ?? null, p.limit ?? 5],
    });
    return result as SelectorSuggestResult;
  },

  locator_heal: async (p: LocatorHealParams): Promise<LocatorHealResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runLocatorHeal as any,
      args: [p.brokenSelector, p.hints || {}],
    });
    return result as LocatorHealResult;
  },

  click_by_label: async (p: ClickByLabelParams): Promise<ClickByLabelResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runClickByLabel as any,
      args: [p.label, p.mode ?? "contains", p.flags ?? "i", p.role ?? null],
    });
    return result as ClickByLabelResult;
  },

  fill_form_from_json: async (p: FillFormFromJsonParams): Promise<FillFormFromJsonResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runFillFormFromJson as any,
      args: [p.selector ?? null, p.data, !!p.submit],
    });
    return result as FillFormFromJsonResult;
  },
};

// ─── in-page helpers (kept top-level so esbuild bundles them as funcs) ───

function pathFor(el: Element): string {
  if ((el as any).id && /^[A-Za-z][\w-]*$/.test((el as any).id)) return `#${(el as any).id}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && parts.length < 6) {
    let part = cur.tagName.toLowerCase();
    if (cur.parentElement) {
      const sibs = [...cur.parentElement.children].filter((c) => c.tagName === cur!.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function roleOf(el: Element): string {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a") return "link";
  if (t === "button") return "button";
  if (t === "input") {
    const tp = (el as HTMLInputElement).type;
    if (tp === "checkbox") return "checkbox";
    if (tp === "radio") return "radio";
    if (tp === "submit" || tp === "button") return "button";
    return "textbox";
  }
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "main") return "main";
  if (t === "nav") return "navigation";
  if (t === "header") return "banner";
  if (t === "footer") return "contentinfo";
  if (t === "aside") return "complementary";
  if (/^h[1-6]$/.test(t)) return "heading";
  return "";
}

function nameOf(el: Element): string {
  return (
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    (el as any).labels?.[0]?.textContent ||
    (el.textContent || "").replace(/\s+/g, " ").trim()
  );
}

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function isVisibleEl(el: HTMLElement): boolean {
  if (!el.offsetParent && el !== document.body) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function elInfo(el: Element, perSelectorAttrs: string[] = []): any {
  const out: any = {
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: nameOf(el).slice(0, 200),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    selector: pathFor(el),
    rect: rectOf(el),
  };
  if (perSelectorAttrs.length) {
    out.attrs = {};
    for (const a of perSelectorAttrs) {
      const v = el.getAttribute(a);
      if (v !== null) out.attrs[a] = v;
    }
  }
  return out;
}

// page_map
function runPageMap(selector: string | null, describe: string | null, per: number): PageMapResult {
  if (describe) {
    const el = document.querySelector(describe);
    if (!el) return { url: location.href, title: document.title } as any;
    const cs = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const k of ["display", "position", "color", "background-color", "font-size", "font-family", "z-index", "opacity"]) {
      styles[k] = cs.getPropertyValue(k);
    }
    const ancestors: any[] = [];
    let cur: Element | null = el.parentElement;
    while (cur && ancestors.length < 6) {
      ancestors.push({ tag: cur.tagName.toLowerCase(), selector: pathFor(cur) });
      cur = cur.parentElement;
    }
    return {
      url: location.href,
      title: document.title,
      element: {
        ...elInfo(el),
        styles,
        visible: isVisibleEl(el as HTMLElement),
        ancestors,
      },
    };
  }

  const root: ParentNode = (selector ? document.querySelector(selector) : document) ?? document;
  const take = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].slice(0, per).map((e) => elInfo(e));
  return {
    url: location.href,
    title: document.title,
    landmarks: take("main, [role=main], nav, [role=navigation], header, [role=banner], footer, [role=contentinfo], aside, [role=complementary]"),
    headings: take("h1,h2,h3,h4,h5,h6"),
    forms: take("form"),
    buttons: take("button, [role=button], input[type=button], input[type=submit]"),
    links: take("a[href]"),
  };
}

// selector_suggest
function runSelectorSuggest(fromSelector: string | null, fromText: string | null, limit: number): SelectorSuggestResult {
  let target: Element | null = null;
  if (fromSelector) target = document.querySelector(fromSelector);
  else if (fromText) {
    const all = [...document.querySelectorAll<HTMLElement>("body *")];
    target = all.find((el) => (el.textContent || "").trim() === fromText) ||
             all.find((el) => (el.textContent || "").includes(fromText)) || null;
  }
  if (!target) return { suggestions: [] };
  const suggestions: Array<{ selector: string; rationale: string; uniqueness: number }> = [];
  const tryAdd = (s: string, rationale: string) => {
    try {
      const matches = document.querySelectorAll(s).length;
      if (matches > 0) suggestions.push({ selector: s, rationale, uniqueness: 1 / matches });
    } catch {}
  };

  // Strongest: id
  if ((target as HTMLElement).id) tryAdd(`#${(target as HTMLElement).id}`, "element id");
  // data-testid family
  for (const a of ["data-testid", "data-test", "data-cy", "data-qa"]) {
    const v = target.getAttribute(a);
    if (v) tryAdd(`[${a}="${v}"]`, `${a} attribute`);
  }
  // name attr (for forms)
  const name = target.getAttribute("name");
  if (name) tryAdd(`${target.tagName.toLowerCase()}[name="${name}"]`, "name attribute");
  // aria-label
  const al = target.getAttribute("aria-label");
  if (al) tryAdd(`${target.tagName.toLowerCase()}[aria-label="${al.replace(/"/g, '\\"')}"]`, "aria-label");
  // role + text
  const role = roleOf(target);
  const txt = (target.textContent || "").trim().slice(0, 40);
  if (role && txt) tryAdd(`[role="${role}"]`, `role="${role}"`);
  // tag + class chain (filter utility classes)
  const cls = (target as HTMLElement).className && typeof (target as any).className === "string"
    ? (target as HTMLElement).className.trim().split(/\s+/).filter((c) => !/^(p|m|w|h|text|bg|flex|grid|gap|hover:|sm:|md:|lg:|xl:)/.test(c)).slice(0, 2)
    : [];
  if (cls.length) tryAdd(`${target.tagName.toLowerCase()}.${cls.join(".")}`, "tag + non-utility class");
  // ancestor with id + tag
  let p: Element | null = target.parentElement;
  while (p) {
    if ((p as HTMLElement).id) {
      tryAdd(`#${(p as HTMLElement).id} ${target.tagName.toLowerCase()}`, "scoped under nearest id ancestor");
      break;
    }
    p = p.parentElement;
  }
  // Fallback: nth-of-type path
  tryAdd(pathFor(target), "structural path (fragile)");

  return { suggestions: suggestions.sort((a, b) => b.uniqueness - a.uniqueness).slice(0, limit) };
}

// locator_heal
function runLocatorHeal(broken: string, hints: { text?: string; role?: string; attrs?: Record<string, string> }): LocatorHealResult {
  const candidates: Array<{ selector: string; score: number; rationale: string }> = [];
  // Try the broken selector first; if matches, no heal needed.
  try {
    const found = document.querySelectorAll(broken);
    if (found.length) return { candidates: [{ selector: broken, score: 1, rationale: "still works" }] };
  } catch {}

  const all = [...document.querySelectorAll<HTMLElement>("body *")];
  const want = hints.text?.toLowerCase();
  const wantRole = hints.role;

  for (const el of all) {
    let score = 0;
    const reasons: string[] = [];
    if (want && (el.textContent || "").toLowerCase().includes(want)) { score += 0.4; reasons.push("text"); }
    if (wantRole && roleOf(el) === wantRole) { score += 0.3; reasons.push("role"); }
    if (hints.attrs) {
      for (const [k, v] of Object.entries(hints.attrs)) {
        if (el.getAttribute(k) === v) { score += 0.2; reasons.push(`@${k}`); }
      }
    }
    // Tag match against the last simple selector in `broken`.
    const lastTag = (broken.match(/([a-z][\w-]*)\s*$/i)?.[1] || "").toLowerCase();
    if (lastTag && el.tagName.toLowerCase() === lastTag) { score += 0.1; reasons.push("tag"); }
    if (score > 0) {
      candidates.push({ selector: pathFor(el), score: +score.toFixed(2), rationale: reasons.join("+") });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates: candidates.slice(0, 8) };
}

// click_by_label
function runClickByLabel(label: string, mode: string, flags: string, role: string | null): ClickByLabelResult {
  const matchFn = (s: string): boolean => {
    if (mode === "exact") return s === label;
    if (mode === "regex") return new RegExp(label, flags).test(s);
    return s.toLowerCase().includes(label.toLowerCase());
  };

  const candidates: Array<{ el: HTMLElement; name: string }> = [];
  // 1) <label for="x"> → click associated control.
  for (const lab of document.querySelectorAll<HTMLLabelElement>("label")) {
    const t = (lab.textContent || "").trim();
    if (!matchFn(t)) continue;
    const ctrlId = lab.getAttribute("for");
    let ctrl: HTMLElement | null = null;
    if (ctrlId) ctrl = document.getElementById(ctrlId);
    if (!ctrl) ctrl = lab.querySelector("input,button,select,textarea");
    if (ctrl) candidates.push({ el: ctrl as HTMLElement, name: t });
  }
  // 2) aria-label / aria-labelledby
  for (const el of document.querySelectorAll<HTMLElement>("[aria-label], [aria-labelledby], button, [role]")) {
    if (role && roleOf(el) !== role) continue;
    const aLabel = el.getAttribute("aria-label") || "";
    const aLabelledBy = el.getAttribute("aria-labelledby");
    let derived = aLabel;
    if (!derived && aLabelledBy) {
      derived = aLabelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
    }
    if (!derived) derived = (el.textContent || "").trim();
    if (matchFn(derived)) candidates.push({ el, name: derived });
  }
  // 3) Fallback: any clickable with matching text.
  for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], a[href], summary, [onclick]")) {
    if (role && roleOf(el) !== role) continue;
    const t = (el.textContent || "").trim();
    if (matchFn(t)) candidates.push({ el, name: t });
  }

  const visible = candidates.filter((c) => isVisibleEl(c.el));
  const target = visible[0] || candidates[0];
  if (!target) return { clicked: false, selector: "", matchedLabel: "" };
  target.el.click();
  return { clicked: true, selector: pathFor(target.el), matchedLabel: target.name };
}

// fill_form_from_json
function runFillFormFromJson(selector: string | null, data: any, submit: boolean): FillFormFromJsonResult {
  const form = (selector ? document.querySelector(selector) : document.querySelector("form")) as HTMLFormElement | null;
  if (!form) return { filled: [], missing: Object.keys(data), submitted: false };

  const filled: string[] = [];
  const missing: string[] = [];
  const set = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, raw: any) => {
    const value = String(typeof raw === "object" && raw !== null ? raw.value : raw);
    if (input instanceof HTMLSelectElement) {
      const opt = [...input.options].find((o) => o.value === value || (o.textContent || "").trim() === value);
      input.value = opt ? opt.value : value;
    } else if ((input as HTMLInputElement).type === "checkbox" || (input as HTMLInputElement).type === "radio") {
      (input as HTMLInputElement).checked = value === "true" || value === "1" || value === (input as HTMLInputElement).value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const findField = (key: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
    const byName = form.querySelector<HTMLInputElement>(`[name="${key}"]`);
    if (byName) return byName;
    const byId = form.querySelector<HTMLInputElement>(`#${CSS.escape(key)}`);
    if (byId) return byId;
    // Match by associated label text.
    for (const lab of form.querySelectorAll<HTMLLabelElement>("label")) {
      if ((lab.textContent || "").trim().toLowerCase() === key.toLowerCase()) {
        const ctrlId = lab.getAttribute("for");
        if (ctrlId) {
          const e = document.getElementById(ctrlId);
          if (e && (e as any).tagName) return e as any;
        }
        const inner = lab.querySelector<HTMLInputElement>("input,select,textarea");
        if (inner) return inner;
      }
    }
    // aria-label
    const aria = form.querySelector<HTMLInputElement>(`[aria-label="${key}"]`);
    if (aria) return aria;
    return null;
  };

  for (const [k, v] of Object.entries(data)) {
    const f = findField(k);
    if (!f) { missing.push(k); continue; }
    set(f, v);
    filled.push(k);
  }

  if (submit) {
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"], input[type="submit"]');
    if (submitBtn) submitBtn.click(); else form.submit();
  }

  return { filled, missing, submitted: !!submit };
}
