import type {
  ExtractParams,
  ExtractResult,
} from "../../../src/shared/protocol";

/**
 * extract — fat extraction tool. Each `type` runs an in-page extractor and
 * returns either {items} (list shape) or {data} (single shape). Extractors
 * are deliberately heuristic — for sites with structured data we read it,
 * for everything else we fall back on visible-text + nearby-label patterns.
 *
 * All extractors run in MAIN world via chrome.scripting so they see the
 * post-hydration DOM (matters for SPAs).
 */
export const extractHandlers: Record<string, (p: any) => Promise<unknown>> = {
  extract: async (p: ExtractParams): Promise<ExtractResult> => {
    // chrome.scripting.executeScript args must be JSON-serializable —
    // undefined is rejected with "Value is unserializable". Coerce missing
    // optionals to null (the in-page func handles null/undefined the same).
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runExtract as any,
      args: [p.type, p.selector ?? null, p.limit ?? 200],
    });
    return result as ExtractResult;
  },
};

// In-page extractor. Defined as a top-level function so esbuild keeps it
// stand-alone (no closure over the SW). The function string is what
// chrome.scripting injects.
function runExtract(type: string, selector: string | undefined, limit: number): ExtractResult {
  const root: ParentNode = (selector ? document.querySelector(selector) : document) ?? document;
  const notes: string[] = [];

  const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const attr = (el: Element | null, name: string) => el?.getAttribute(name) || "";
  const allMeta = () => {
    const m: Record<string, string> = {};
    for (const tag of document.querySelectorAll<HTMLMetaElement>("meta")) {
      const k = tag.getAttribute("property") || tag.getAttribute("name");
      if (!k) continue;
      m[k] = tag.content;
    }
    return m;
  };
  const visibleHeadings = () =>
    [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map((h) => ({
      level: parseInt(h.tagName.slice(1), 10),
      text: text(h),
    }));
  const allLinks = () =>
    [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => ({
      href: a.href,
      text: text(a),
      rel: a.rel || undefined,
    }));
  const tablesOf = () =>
    [...root.querySelectorAll<HTMLTableElement>("table")].map((t) => {
      const headers = [...t.querySelectorAll<HTMLTableCellElement>("thead th, thead td")].map((c) => text(c));
      const rows = [...t.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((tr) =>
        [...tr.querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => text(c)),
      );
      if (!headers.length && !rows.length) {
        const all = [...t.querySelectorAll<HTMLTableRowElement>("tr")];
        if (all.length) {
          const head = [...all[0].querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => text(c));
          const body = all.slice(1).map((tr) => [...tr.querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => text(c)));
          return { headers: head, rows: body };
        }
      }
      return { headers, rows };
    });
  const jsonLd = () => {
    const blobs: unknown[] = [];
    for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
      try { blobs.push(JSON.parse(s.textContent || "")); } catch {}
    }
    return blobs;
  };
  const pickFromJsonLd = (typeName: string): any[] => {
    const out: any[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      const t = node["@type"];
      if (t && (t === typeName || (Array.isArray(t) && t.includes(typeName)))) out.push(node);
      for (const k of Object.keys(node)) {
        const v = (node as any)[k];
        if (v && typeof v === "object") {
          if (Array.isArray(v)) v.forEach(visit);
          else visit(v);
        }
      }
    };
    for (const blob of jsonLd()) visit(blob);
    return out;
  };

  switch (type) {
    case "page": {
      const data = {
        title: document.title,
        url: location.href,
        text: ((root as Element).textContent || document.body?.innerText || "").trim().slice(0, 200_000),
        headings: visibleHeadings().slice(0, limit),
        links: allLinks().slice(0, limit),
        meta: allMeta(),
      };
      return { type: "page", data, notes };
    }

    case "article": {
      // Prefer JSON-LD Article; fall back to <article>; fall back to og:title + main.
      const ld = pickFromJsonLd("Article").concat(pickFromJsonLd("NewsArticle")).concat(pickFromJsonLd("BlogPosting"));
      if (ld.length) {
        const a = ld[0];
        return {
          type: "article",
          data: {
            title: a.headline ?? a.name ?? document.title,
            byline: a.author?.name ?? (Array.isArray(a.author) ? a.author.map((x: any) => x.name).join(", ") : a.author) ?? "",
            date: a.datePublished ?? a.dateCreated ?? "",
            updated: a.dateModified ?? "",
            body: a.articleBody ?? "",
            heroImage: a.image?.url ?? a.image ?? "",
            url: a.url ?? location.href,
          },
          notes: ["from json-ld"],
        };
      }
      const articleEl = root.querySelector("article") as HTMLElement | null;
      const meta = allMeta();
      const body = articleEl ? text(articleEl) : "";
      return {
        type: "article",
        data: {
          title: meta["og:title"] || document.title,
          byline: meta["article:author"] || meta["author"] || "",
          date: meta["article:published_time"] || meta["date"] || "",
          updated: meta["article:modified_time"] || "",
          body: body || (root as any).textContent?.trim().slice(0, 50_000) || "",
          heroImage: meta["og:image"] || "",
          url: meta["og:url"] || location.href,
        },
        notes: articleEl ? ["from <article>"] : ["fallback to og:* + body text"],
      };
    }

    case "products": {
      const ld = pickFromJsonLd("Product");
      if (ld.length) {
        const items = ld.slice(0, limit).map((p: any) => ({
          name: p.name,
          price: p.offers?.price ?? p.offers?.lowPrice ?? "",
          currency: p.offers?.priceCurrency ?? "",
          availability: (p.offers?.availability || "").split("/").pop() || "",
          url: p.url ?? p["@id"] ?? "",
          image: p.image?.url ?? p.image ?? "",
          sku: p.sku ?? "",
        }));
        return { type: "products", items, notes: ["from json-ld"] };
      }
      // DOM heuristic — find cards that contain a price-shaped string.
      const priceRe = /(?:[$€£¥]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|CAD|AUD))/;
      const items: any[] = [];
      const seen = new Set<Element>();
      const candidates = [...(root as ParentNode).querySelectorAll<HTMLElement>("[class*=product], [class*=card], li, article")];
      for (const card of candidates) {
        if (items.length >= limit) break;
        const t = text(card);
        if (!priceRe.test(t)) continue;
        // Bubble up to the largest semantic ancestor.
        let host = card;
        while (host.parentElement && host.parentElement.children.length === 1) host = host.parentElement;
        if (seen.has(host)) continue;
        seen.add(host);
        const link = host.querySelector("a[href]") as HTMLAnchorElement | null;
        const img = host.querySelector("img") as HTMLImageElement | null;
        const priceMatch = t.match(priceRe)?.[0] ?? "";
        const name = text(host.querySelector("h1,h2,h3,h4,[class*=title],[class*=name]")) || (link ? text(link) : t.split(priceMatch)[0]).trim().slice(0, 120);
        items.push({
          name,
          price: priceMatch.replace(/[^\d.,]/g, ""),
          currency: priceMatch.replace(/[\d.,\s]/g, ""),
          url: link?.href || "",
          image: img?.src || "",
        });
      }
      return { type: "products", items, notes: ["dom heuristic"] };
    }

    case "prices": {
      const re = /([$€£¥])\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(USD|EUR|GBP|CAD|AUD|JPY)/g;
      const items: any[] = [];
      const walker = document.createTreeWalker((root as Element) ?? document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode()) && items.length < limit) {
        const txt = (n.nodeValue || "").trim();
        if (!txt) continue;
        let m: RegExpExecArray | null;
        const local = new RegExp(re.source, "g");
        while ((m = local.exec(txt))) {
          items.push({
            currency: m[1] || m[4] || "",
            amount: (m[2] || m[3] || "").replace(/,/g, ""),
            context: txt.slice(Math.max(0, m.index - 40), Math.min(txt.length, m.index + 40)),
          });
        }
      }
      return { type: "prices", items, notes: [] };
    }

    case "contacts": {
      const t = (root as any).textContent || document.body?.innerText || "";
      const emails = Array.from(new Set((t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])));
      const phones = Array.from(new Set((t.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/g) || [])
        .filter((s: string) => s.replace(/\D/g, "").length >= 7)));
      const socials = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((a) => a.href)
        .filter((h) => /(twitter|x\.com|facebook|linkedin|instagram|github|youtube|tiktok|mastodon|threads|bsky)/i.test(h));
      const addresses = [...root.querySelectorAll<HTMLElement>("address")].map((a) => text(a));
      return {
        type: "contacts",
        data: {
          emails: emails.slice(0, limit),
          phones: phones.slice(0, limit),
          socials: Array.from(new Set(socials)).slice(0, limit),
          addresses: addresses.slice(0, limit),
        },
        notes: [],
      };
    }

    case "jobs": {
      const ld = pickFromJsonLd("JobPosting");
      if (ld.length) {
        const items = ld.slice(0, limit).map((j: any) => ({
          title: j.title,
          company: j.hiringOrganization?.name ?? "",
          location: j.jobLocation?.address?.addressLocality ?? j.jobLocation?.address ?? "",
          salary: j.baseSalary?.value?.value ?? j.baseSalary?.value ?? "",
          datePosted: j.datePosted ?? "",
          url: j.url ?? "",
          description: (j.description || "").slice(0, 5_000),
        }));
        return { type: "jobs", items, notes: ["from json-ld"] };
      }
      return { type: "jobs", items: [], notes: ["no JobPosting json-ld; site-specific extractor needed"] };
    }

    case "events": {
      const ld = pickFromJsonLd("Event");
      const items = ld.slice(0, limit).map((e: any) => ({
        name: e.name,
        startDate: e.startDate,
        endDate: e.endDate,
        location: e.location?.name ?? e.location?.address ?? "",
        url: e.url ?? "",
        ticketUrl: e.offers?.url ?? "",
      }));
      return { type: "events", items, notes: ld.length ? ["from json-ld"] : ["no Event json-ld"] };
    }

    case "tables":
      return { type: "tables", items: tablesOf().slice(0, limit), notes: [] };

    case "jsonld":
      return { type: "jsonld", items: jsonLd(), notes: [] };

    case "meta": {
      const m = allMeta();
      const canonical = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || "";
      return {
        type: "meta",
        data: {
          title: document.title,
          description: m["description"] || m["og:description"] || "",
          canonical,
          openGraph: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("og:"))),
          twitter: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("twitter:"))),
          robots: m["robots"] || "",
          viewport: m["viewport"] || "",
          themeColor: m["theme-color"] || "",
          generator: m["generator"] || "",
        },
        notes: [],
      };
    }

    case "copy": {
      const sections: Array<{ heading: string; text: string }> = [];
      const headings = [...root.querySelectorAll<HTMLElement>("h1,h2,h3")];
      if (!headings.length) {
        return { type: "copy", data: { sections: [{ heading: document.title, text: ((root as any).textContent || "").trim().slice(0, 50_000) }] } };
      }
      for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const next = headings[i + 1];
        const range = document.createRange();
        range.setStartAfter(h);
        if (next) range.setEndBefore(next); else range.setEndAfter(document.body);
        sections.push({ heading: text(h), text: range.toString().replace(/\s+/g, " ").trim().slice(0, 20_000) });
      }
      return { type: "copy", data: { sections: sections.slice(0, limit) } };
    }

    case "tokens": {
      // Inspect a sample of elements; tally fonts, colors, radii, spacing.
      const sample = [...document.querySelectorAll<HTMLElement>("body *")].slice(0, 1500);
      const tally = (key: string) => {
        const m = new Map<string, number>();
        for (const el of sample) {
          const cs = getComputedStyle(el);
          const v = cs.getPropertyValue(key).trim();
          if (!v || v === "none" || v === "0px" || v === "rgba(0, 0, 0, 0)") continue;
          m.set(v, (m.get(v) || 0) + 1);
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([value, count]) => ({ value, count }));
      };
      return {
        type: "tokens",
        data: {
          colors: tally("color"),
          backgrounds: tally("background-color"),
          fontFamilies: tally("font-family"),
          fontSizes: tally("font-size"),
          fontWeights: tally("font-weight"),
          radii: tally("border-radius"),
          shadows: tally("box-shadow"),
          spacing: tally("padding"),
          margins: tally("margin"),
        },
        notes: [`sampled ${sample.length} elements`],
      };
    }
  }
  return { type: type as any, items: [], notes: [`unknown extract type: ${type}`] };
}
