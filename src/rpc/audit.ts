import type {
  AuditCheck,
  AuditFinding,
  AuditParams,
  AuditResult,
} from "../shared/protocol";
import { readNetwork as readNet } from "../net";

/**
 * audit — runs one or more in-page checks. Most checks live entirely in
 * page context; a few (cookies, headers) consult network state from the
 * background. Findings share a common shape so a UI can render them.
 */
export const auditHandlers: Record<string, (p: any) => Promise<unknown>> = {
  audit: async (p: AuditParams): Promise<AuditResult> => {
    const checks = p.checks;
    const findings: AuditFinding[] = [];

    // In-page checks: run as one big script so we don't pay per-check
    // round-trip cost.
    const inPageChecks = checks.filter((c) => c !== "headers");
    if (inPageChecks.length) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        world: "MAIN",
        func: runAudit as any,
        args: [inPageChecks],
      });
      findings.push(...((result as AuditFinding[]) || []));
    }

    // Network-derived: headers audit reads response headers from the
    // capture buffer.
    if (checks.includes("headers")) {
      try {
        const entries = await readNet({ tabId: p.tabId, limit: 500, includeBodies: false });
        for (const e of entries) {
          const h = (k: string) =>
            e.responseHeaders?.[k] ?? e.responseHeaders?.[k.toLowerCase()] ?? e.responseHeaders?.[k.toUpperCase()] ?? "";
          if (e.url.startsWith("https://") && (e.responseHeaders ?? {}) && !h("strict-transport-security")) {
            findings.push({ check: "headers", severity: "warn", message: "Missing HSTS", details: { url: e.url } });
          }
          if (h("content-type").startsWith("text/html") && !h("content-security-policy")) {
            findings.push({ check: "headers", severity: "warn", message: "HTML response missing CSP", details: { url: e.url } });
          }
          if ((e.status ?? 0) >= 400) {
            findings.push({ check: "headers", severity: "error", message: `${e.status} on ${e.url}`, details: { url: e.url, status: e.status } });
          }
          const cc = h("cache-control");
          if (e.url.match(/\.(js|css|png|jpg|jpeg|webp|svg|woff2)/i) && !cc) {
            findings.push({ check: "headers", severity: "info", message: "Static asset missing cache-control", details: { url: e.url } });
          }
        }
      } catch (e: any) {
        findings.push({ check: "headers", severity: "warn", message: `headers audit skipped: ${String(e?.message ?? e)}` });
      }
    }

    // Summary roll-up.
    const summary: any = {};
    for (const c of checks) {
      const f = findings.filter((x) => x.check === c);
      summary[c] = {
        ran: true,
        total: f.length,
        errors: f.filter((x) => x.severity === "error").length,
        warns: f.filter((x) => x.severity === "warn").length,
      };
    }
    return { findings, summary };
  },
};

// In-page audit dispatcher. Defined top-level so esbuild ships it as the
// `func` arg to chrome.scripting.executeScript.
function runAudit(checks: string[]): AuditFinding[] {
  const out: any[] = [];
  const push = (check: string, severity: "info" | "warn" | "error", message: string, extra?: any) => {
    out.push({ check, severity, message, ...(extra || {}) });
  };
  const sel = (el: Element): string => {
    if ((el as any).id) return `#${(el as any).id}`;
    const tag = el.tagName.toLowerCase();
    const cls = (el as HTMLElement).className && typeof (el as any).className === "string"
      ? "." + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    return tag + cls;
  };
  const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const isVisible = (el: HTMLElement) => {
    if (!el.offsetParent && el !== document.body) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  if (checks.includes("a11y")) {
    // Inputs missing accessible name.
    for (const inp of document.querySelectorAll<HTMLInputElement>("input, select, textarea")) {
      if (inp.type === "hidden") continue;
      const labelled =
        inp.getAttribute("aria-label") ||
        (inp.id && document.querySelector(`label[for="${inp.id}"]`)) ||
        inp.closest("label") ||
        inp.getAttribute("placeholder");
      if (!labelled) push("a11y", "error", `Form control without accessible name`, { selector: sel(inp) });
    }
    // Images missing alt.
    for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
      if (img.alt === undefined) continue;
      if (!img.alt && !img.getAttribute("role") && img.getAttribute("aria-hidden") !== "true") {
        push("a11y", "warn", "Image missing alt text", { selector: sel(img), details: { src: img.src } });
      }
    }
    // Buttons / links with empty accessible name.
    for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], a[href]")) {
      const name = el.getAttribute("aria-label") || text(el) || el.querySelector("img")?.getAttribute("alt") || "";
      if (!name && isVisible(el as HTMLElement)) {
        push("a11y", "error", "Interactive element with empty accessible name", { selector: sel(el) });
      }
    }
    // Landmark coverage.
    const landmarks = document.querySelectorAll("main, [role=main], nav, [role=navigation], header, [role=banner], footer, [role=contentinfo]");
    if (!document.querySelector("main, [role=main]")) push("a11y", "warn", "No <main> landmark");
    if (!landmarks.length) push("a11y", "warn", "No landmark regions found");
  }

  if (checks.includes("aria")) {
    const validRoles = new Set([
      "alert","alertdialog","application","article","banner","button","cell","checkbox","columnheader","combobox","complementary","contentinfo","definition","dialog","directory","document","feed","figure","form","grid","gridcell","group","heading","img","link","list","listbox","listitem","log","main","marquee","math","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none","note","option","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader","scrollbar","search","searchbox","separator","slider","spinbutton","status","switch","tab","table","tablist","tabpanel","term","textbox","timer","toolbar","tooltip","tree","treegrid","treeitem",
    ]);
    for (const el of document.querySelectorAll<HTMLElement>("[role]")) {
      const r = el.getAttribute("role")!;
      for (const part of r.split(/\s+/)) {
        if (!validRoles.has(part)) push("aria", "error", `Invalid ARIA role: "${part}"`, { selector: sel(el) });
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>("[aria-labelledby], [aria-describedby]")) {
      for (const a of ["aria-labelledby", "aria-describedby"]) {
        const v = el.getAttribute(a);
        if (!v) continue;
        for (const id of v.split(/\s+/)) {
          if (!document.getElementById(id)) push("aria", "error", `${a}="${id}" points to missing id`, { selector: sel(el) });
        }
      }
    }
  }

  if (checks.includes("contrast")) {
    // WCAG-ish luminance check; only for visible text elements.
    const lum = (rgb: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const parse = (s: string): number[] | null => {
      const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const seen = new Set<Element>();
    const probes = [...document.querySelectorAll<HTMLElement>("p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, button, label")].slice(0, 600);
    for (const el of probes) {
      if (!isVisible(el)) continue;
      if (!text(el)) continue;
      let host: HTMLElement | null = el;
      let bg = "rgba(0, 0, 0, 0)";
      while (host) {
        bg = getComputedStyle(host).backgroundColor;
        if (parse(bg) && bg !== "rgba(0, 0, 0, 0)") break;
        host = host.parentElement;
      }
      const fgRgb = parse(getComputedStyle(el).color);
      const bgRgb = parse(bg) || [255, 255, 255];
      if (!fgRgb) continue;
      const fl = lum(fgRgb), bl = lum(bgRgb);
      const ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
      const fontSize = parseFloat(getComputedStyle(el).fontSize);
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && parseInt(getComputedStyle(el).fontWeight) >= 700);
      const min = isLarge ? 3 : 4.5;
      if (ratio < min) {
        if (seen.has(el)) continue;
        seen.add(el);
        push("contrast", "warn", `Contrast ${ratio.toFixed(2)}:1 below WCAG AA (${min}:1)`, { selector: sel(el), details: { ratio, fontSize } });
      }
    }
  }

  if (checks.includes("seo")) {
    if (!document.title) push("seo", "error", "Missing <title>");
    if (document.title.length > 60) push("seo", "warn", `Title is ${document.title.length} chars (>60)`);
    const desc = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || "";
    if (!desc) push("seo", "warn", "Missing meta description");
    else if (desc.length > 160) push("seo", "info", `Meta description is ${desc.length} chars (>160)`);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) push("seo", "warn", "Missing canonical link");
    const h1s = document.querySelectorAll("h1");
    if (h1s.length === 0) push("seo", "warn", "No <h1> on page");
    if (h1s.length > 1) push("seo", "info", `${h1s.length} <h1> tags (some SEO guidelines prefer 1)`);
    const robots = (document.querySelector('meta[name="robots"]') as HTMLMetaElement | null)?.content || "";
    if (/noindex/i.test(robots)) push("seo", "info", `robots="${robots}" (noindex set)`);
  }

  if (checks.includes("analytics")) {
    const found: string[] = [];
    const w: any = window;
    if (w.gtag || w.ga || /www\.googletagmanager\.com\/gtag\/js/.test(document.head.innerHTML)) found.push("Google Analytics (gtag)");
    if (w.dataLayer || /googletagmanager\.com\/gtm\.js/.test(document.head.innerHTML)) found.push("Google Tag Manager");
    if (w.fbq || /connect\.facebook\.net\/.+\/fbevents\.js/.test(document.head.innerHTML)) found.push("Meta Pixel");
    if (w.analytics?.identify || /cdn\.segment\.com/.test(document.head.innerHTML)) found.push("Segment");
    if (w.plausible || /plausible\.io/.test(document.head.innerHTML)) found.push("Plausible");
    if (w.hj || /static\.hotjar\.com/.test(document.head.innerHTML)) found.push("Hotjar");
    if (w._paq || /matomo/.test(document.head.innerHTML)) found.push("Matomo");
    if (w.mixpanel) found.push("Mixpanel");
    if (w.amplitude) found.push("Amplitude");
    if (w.posthog) found.push("PostHog");
    if (!found.length) push("analytics", "info", "No common analytics tags detected");
    else push("analytics", "info", `Detected: ${found.join(", ")}`, { details: { found } });
  }

  if (checks.includes("cookies")) {
    // We can only see non-HttpOnly cookies from the page; flag structural
    // smells from the visible set.
    const cookieStr = document.cookie;
    if (cookieStr) {
      // No SameSite info is exposed via document.cookie; flag the lack of
      // a signal so the caller knows to inspect via cookies_get.
      push("cookies", "info", `Page cookies present (${cookieStr.split(";").length}); use cookies_get for SameSite/Secure flags`);
    }
  }

  if (checks.includes("images")) {
    for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
      if (img.complete && img.naturalWidth === 0) push("images", "error", "Broken image", { selector: sel(img), details: { src: img.src } });
      const display = img.getBoundingClientRect();
      if (img.naturalWidth && display.width && img.naturalWidth > display.width * 2 + 50) {
        push("images", "warn", `Oversized image (${img.naturalWidth}px served, ${Math.round(display.width)}px displayed)`, { selector: sel(img), details: { src: img.src } });
      }
      if (!img.loading || img.loading === "eager") {
        if (display.top > window.innerHeight * 1.5) push("images", "info", "Below-fold image without loading=lazy", { selector: sel(img) });
      }
      if (!img.alt && img.getAttribute("alt") === null) push("images", "warn", "Image missing alt", { selector: sel(img) });
    }
  }

  if (checks.includes("fonts")) {
    const fonts = (document as any).fonts as FontFaceSet | undefined;
    if (fonts) {
      const families = new Set<string>();
      fonts.forEach((f: FontFace) => families.add(f.family));
      push("fonts", "info", `${families.size} font families loaded`, { details: { families: [...families] } });
    }
    const stylesheets = [...document.styleSheets];
    let withoutDisplay = 0;
    for (const s of stylesheets) {
      try {
        for (const r of [...((s as CSSStyleSheet).cssRules || [])]) {
          if (r.constructor.name === "CSSFontFaceRule") {
            const t = (r as any).cssText || "";
            if (!/font-display\s*:/.test(t)) withoutDisplay++;
          }
        }
      } catch {}
    }
    if (withoutDisplay) push("fonts", "warn", `${withoutDisplay} @font-face rules without font-display`);
  }

  if (checks.includes("responsive") || checks.includes("overflow")) {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) push("responsive", "warn", `Horizontal scroll detected (${root.scrollWidth} > ${root.clientWidth})`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (!isVisible(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible") {
        push("responsive", "warn", "Element overflows horizontally", { selector: sel(el) });
      }
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth) {
        push("overflow", "info", "Text clipped by ellipsis", { selector: sel(el) });
      }
    }
  }

  if (checks.includes("html")) {
    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLElement>("[id]")) {
      const id = el.id;
      ids.set(id, (ids.get(id) || 0) + 1);
    }
    for (const [id, n] of ids) if (n > 1) push("html", "error", `Duplicate id="${id}" (${n} elements)`);
    if (!document.querySelector("title")) push("html", "warn", "Missing <title>");
  }

  if (checks.includes("i18n")) {
    if (!document.documentElement.lang) push("i18n", "warn", "<html> has no lang attribute");
    const dir = document.documentElement.dir || "ltr";
    if (dir !== "ltr" && dir !== "rtl") push("i18n", "warn", `Unusual <html dir="${dir}">`);
  }

  if (checks.includes("hydration")) {
    const w: any = window;
    if (w.__NEXT_DATA__ && !document.querySelector("[data-reactroot], #__next")) push("hydration", "warn", "Next.js data present but no React root mounted");
    // Watch for hydration mismatch flag set by recent React.
    if (w.__REACT_ERROR_OVERLAY__) push("hydration", "error", "React error overlay active");
  }

  if (checks.includes("auth")) {
    const w: any = window;
    const cookieStr = document.cookie;
    const hasAuthCookie = /(session|sid|auth|token|jwt)/i.test(cookieStr);
    const hasAuthLocal = ["token","jwt","auth","session","access_token"].some((k) => localStorage.getItem(k) !== null);
    const accountUI = document.querySelector("[class*=account], [class*=user-menu], [aria-label*=account i]") !== null;
    const loggedIn = hasAuthCookie || hasAuthLocal || accountUI;
    push("auth", loggedIn ? "info" : "warn", loggedIn ? "Looks logged-in" : "No auth signals detected", {
      details: { hasAuthCookie, hasAuthLocal, accountUI, hasUser: !!w.user || !!w.currentUser },
    });
  }

  return out;
}
