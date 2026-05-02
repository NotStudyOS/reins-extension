import type {
  DetectFrameworkParams,
  DetectFrameworkResult,
} from "../shared/protocol";

/**
 * detect_framework — heuristics over `window` globals + script URLs +
 * data attributes. Non-destructive read.
 */
export const frameworkHandlers: Record<string, (p: any) => Promise<unknown>> = {
  detect_framework: async (p: DetectFrameworkParams): Promise<DetectFrameworkResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runDetect as any,
    });
    return result as DetectFrameworkResult;
  },
};

function runDetect(): DetectFrameworkResult {
  const w: any = window as any;
  const html = document.documentElement.outerHTML;
  const scripts = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => s.src);
  const has = (re: RegExp) => scripts.some((s) => re.test(s)) || re.test(html);

  const frameworks: Array<{ name: string; version?: string; signals: string[] }> = [];
  const signal = (name: string, version: string | undefined, sig: string) => {
    let f = frameworks.find((x) => x.name === name);
    if (!f) { f = { name, version, signals: [] }; frameworks.push(f); }
    if (version && !f.version) f.version = version;
    if (!f.signals.includes(sig)) f.signals.push(sig);
  };

  // React
  if (w.React) signal("React", w.React.version, "window.React");
  if (document.querySelector("[data-reactroot]")) signal("React", undefined, "data-reactroot");
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) signal("React", undefined, "devtools hook");
  // Next.js
  if (w.__NEXT_DATA__) signal("Next.js", w.__NEXT_DATA__.buildId ? `build:${w.__NEXT_DATA__.buildId}` : undefined, "__NEXT_DATA__");
  if (document.querySelector("#__next")) signal("Next.js", undefined, "#__next root");
  // Vue
  if (w.Vue) signal("Vue", w.Vue.version, "window.Vue");
  if (w.__VUE__) signal("Vue", undefined, "window.__VUE__");
  if (w.__VUE_DEVTOOLS_GLOBAL_HOOK__) signal("Vue", undefined, "devtools hook");
  if (document.querySelector("[data-v-app]")) signal("Vue", undefined, "data-v-app");
  // Nuxt
  if (w.__NUXT__) signal("Nuxt", undefined, "window.__NUXT__");
  if (document.querySelector("#__nuxt")) signal("Nuxt", undefined, "#__nuxt root");
  // Svelte / SvelteKit
  if (w.__SVELTEKIT_DATA__) signal("SvelteKit", undefined, "__SVELTEKIT_DATA__");
  if (has(/\/_app\/immutable\//)) signal("SvelteKit", undefined, "_app/immutable bundle");
  // Angular
  if (w.ng || w.getAllAngularRootElements) signal("Angular", undefined, "global angular");
  if (document.querySelector("[ng-version]")) signal("Angular", document.querySelector("[ng-version]")?.getAttribute("ng-version") || undefined, "ng-version");
  // Solid / Qwik / Astro / Remix
  if (w._$HY) signal("Solid", undefined, "_$HY");
  if (has(/qwik/i) || w.qwikevents) signal("Qwik", undefined, "qwik markers");
  if (document.querySelector("astro-island")) signal("Astro", undefined, "astro-island");
  if (w.__remixContext) signal("Remix", undefined, "__remixContext");
  // Gatsby
  if (w.___gatsby || document.querySelector("#___gatsby")) signal("Gatsby", undefined, "gatsby root");
  // jQuery (still common)
  if (w.jQuery) signal("jQuery", w.jQuery.fn?.jquery, "window.jQuery");
  // HTMX / Alpine
  if (w.htmx) signal("HTMX", w.htmx.version, "window.htmx");
  if (w.Alpine) signal("Alpine.js", w.Alpine.version, "window.Alpine");
  // Stimulus
  if (w.Stimulus) signal("Stimulus", undefined, "window.Stimulus");

  const buildTools: string[] = [];
  if (has(/\/_next\/static\//)) buildTools.push("Next.js bundler");
  if (has(/\/_nuxt\//)) buildTools.push("Nuxt bundler");
  if (has(/\/assets\/.*\.js$/) && has(/vite/i)) buildTools.push("Vite");
  if (has(/webpack/i)) buildTools.push("Webpack");
  if (has(/parcel/i)) buildTools.push("Parcel");
  if (has(/turbo(pack)?/i)) buildTools.push("Turbopack");

  const routers: string[] = [];
  if (w.__REACT_ROUTER__ || has(/react-router/i)) routers.push("React Router");
  if (has(/@tanstack\/react-router/)) routers.push("TanStack Router");

  const state: string[] = [];
  if (w.__REDUX_DEVTOOLS_EXTENSION__ || w.__REDUX_STORE__) state.push("Redux");
  if (w.__zustand_store) state.push("Zustand");
  if (has(/recoil/i)) state.push("Recoil");
  if (has(/jotai/i)) state.push("Jotai");

  const cms: string[] = [];
  if (has(/wp-content|wp-includes/)) cms.push("WordPress");
  if (has(/cdn\.shopify\.com|myshopify\.com/)) cms.push("Shopify");
  if (has(/squarespace/i)) cms.push("Squarespace");
  if (has(/cdn\.webflow\.com|webflow\.com\/uploads/)) cms.push("Webflow");
  if (has(/wix\.com/)) cms.push("Wix");
  if (has(/contentful/i)) cms.push("Contentful");
  if (has(/sanity\.io/)) cms.push("Sanity");

  const hydrationErrors: string[] = [];
  // Recent React surfaces hydration errors via console; we can't read those
  // from the page world, so we only flag the presence of known overlays.
  if (w.__REACT_ERROR_OVERLAY__) hydrationErrors.push("React error overlay active");

  return {
    frameworks,
    buildTools,
    routers,
    state,
    cms,
    hasReactDevHook: !!w.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    hasVueDevHook: !!w.__VUE_DEVTOOLS_GLOBAL_HOOK__,
    hydrationErrors: hydrationErrors.length ? hydrationErrors : undefined,
  };
}
