import type {
  DomAllLinksParams,
  DomAllLinksResult,
  DomFormSchemaParams,
  DomFormSchemaResult,
  DomQueryParams,
  DomQueryResult,
  DomXpathParams,
  DomXpathResult,
} from "../../../src/shared/protocol";

export const domHandlers: Record<string, (params: any) => Promise<unknown>> = {
  "dom.xpath": async (p: DomXpathParams): Promise<DomXpathResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: (xp: string, attr: string | null) => {
        const out: string[] = [];
        const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < snap.snapshotLength; i++) {
          const n = snap.snapshotItem(i);
          if (!n) continue;
          if (attr && n instanceof Element) out.push(n.getAttribute(attr) ?? "");
          else out.push(n.textContent ?? "");
        }
        return out;
      },
      // Coerce undefined → null; chrome.scripting rejects undefined args.
      args: [p.xpath, p.attr ?? null],
    });
    return { values: result as string[] };
  },

  "dom.all_links": async (p: DomAllLinksParams): Promise<DomAllLinksResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: () =>
        [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => ({
          href: a.href,
          text: (a.innerText || "").trim(),
          rel: a.rel || undefined,
        })),
    });
    return { links: result as DomAllLinksResult["links"] };
  },

  "dom.form_schema": async (p: DomFormSchemaParams): Promise<DomFormSchemaResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: () =>
        [...document.querySelectorAll<HTMLFormElement>("form")].map((f) => ({
          action: f.action,
          method: f.method,
          fields: [...f.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea",
          )].map((el) => {
            const base = {
              name: el.name || el.id || "",
              type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
              required: (el as HTMLInputElement).required ?? false,
              value: (el as HTMLInputElement).value ?? "",
            };
            if (el instanceof HTMLSelectElement) {
              return { ...base, options: [...el.options].map((o) => o.value) };
            }
            return base;
          }),
        })),
    });
    return { forms: result as DomFormSchemaResult["forms"] };
  },

  "dom.query": async (p: DomQueryParams): Promise<DomQueryResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: (
        selector: string,
        attrs: string[],
        limit: number,
        visibleOnly: boolean,
        pierceShadow: boolean,
        wantRect: boolean,
        styleProps: string[],
        wantOuterHtml: boolean,
        outerHtmlMaxBytes: number,
        highlightMs: number,
      ) => {
        // Collect, optionally piercing open shadow roots breadth-first.
        const collect = (root: ParentNode): HTMLElement[] => {
          const direct = [...root.querySelectorAll<HTMLElement>(selector)];
          if (!pierceShadow) return direct;
          const all: HTMLElement[] = [...direct];
          const walker = (n: Element) => {
            const sr = (n as any).shadowRoot as ShadowRoot | null;
            if (sr) {
              all.push(...sr.querySelectorAll<HTMLElement>(selector));
              for (const child of sr.querySelectorAll<HTMLElement>("*")) walker(child);
            }
          };
          for (const el of root.querySelectorAll<HTMLElement>("*")) walker(el);
          // De-dup while preserving order.
          return [...new Set(all)];
        };
        const all = collect(document);
        const total = all.length;
        const isVisible = (el: HTMLElement) => {
          if (!el.offsetParent && el !== document.body) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const filtered = visibleOnly ? all.filter(isVisible) : all;
        const capped = filtered.slice(0, limit);

        if (highlightMs > 0) {
          const prev: Array<{ el: HTMLElement; outline: string; outlineOffset: string }> = [];
          for (const el of capped) {
            prev.push({
              el,
              outline: el.style.outline,
              outlineOffset: el.style.outlineOffset,
            });
            el.style.outline = "2px solid red";
            el.style.outlineOffset = "1px";
          }
          setTimeout(() => {
            for (const { el, outline, outlineOffset } of prev) {
              el.style.outline = outline;
              el.style.outlineOffset = outlineOffset;
            }
          }, highlightMs);
        }

        const matches = capped.map((el) => {
          const href = (el as unknown as { href?: string }).href;
          const out: any = { text: (el.textContent || "").trim() };
          if (typeof href === "string" && href) out.href = href;
          if (attrs && attrs.length) {
            out.attrs = {};
            for (const a of attrs) {
              const v = el.getAttribute(a);
              if (v !== null) out.attrs[a] = v;
            }
          }
          if (wantRect) {
            const r = el.getBoundingClientRect();
            out.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          if (styleProps && styleProps.length) {
            const cs = getComputedStyle(el);
            out.styles = {};
            for (const prop of styleProps) out.styles[prop] = cs.getPropertyValue(prop);
          }
          if (wantOuterHtml) {
            const html = el.outerHTML ?? "";
            if (html.length > outerHtmlMaxBytes) {
              out.outerHtml = html.slice(0, outerHtmlMaxBytes);
              out.outerHtmlTruncated = true;
            } else {
              out.outerHtml = html;
              out.outerHtmlTruncated = false;
            }
          }
          return out;
        });
        return { matches, total };
      },
      args: [
        p.selector,
        p.attrs ?? [],
        p.limit ?? 500,
        !!p.visibleOnly,
        !!p.pierceShadow,
        !!p.boundingRect,
        p.computedStyles ?? [],
        !!p.outerHtml,
        p.outerHtmlMaxBytes ?? 50_000,
        p.highlightMs ?? 0,
      ],
    });
    return result as DomQueryResult;
  },
};
