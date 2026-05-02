import browser from "webextension-polyfill";
import type {
  ClearStorageParams,
  ClearStorageResult,
  CookiesClearParams,
  CookiesClearResult,
  CookiesGetParams,
  CookiesSetParams,
  StorageGetParams,
  StorageGetResult,
  StorageSetParams,
} from "../../../src/shared/protocol";
import { cookieUrl } from "./cookies";
import { runInMainWorld } from "./runtime";

export const storageHandlers: Record<string, (params: any) => Promise<unknown>> = {
  "cookies.get": async (p: CookiesGetParams) => {
    if (!p.url && !p.domain) {
      throw new Error("cookies.get: pass url or domain");
    }
    let cookies: any[];
    if (p.name && p.url) {
      const c = await browser.cookies.get({ url: p.url, name: p.name });
      cookies = c ? [c] : [];
    } else {
      cookies = await browser.cookies.getAll(
        p.url ? { url: p.url } : { domain: p.domain! },
      );
      if (p.name) cookies = cookies.filter((c) => c.name === p.name);
    }
    if (p.nameRegex) {
      const re = new RegExp(p.nameRegex, p.nameFlags ?? "");
      cookies = cookies.filter((c) => re.test(c.name));
    }
    return { cookies };
  },

  "cookies.set": async (p: CookiesSetParams) => {
    const details: any = {
      url: p.url,
      name: p.name,
      value: p.value,
      path: p.path,
      secure: p.secure,
      httpOnly: p.httpOnly,
      sameSite: p.sameSite,
      expirationDate: p.expirationDate,
    };
    if (p.domain) details.domain = p.domain;
    return { cookie: await browser.cookies.set(details) };
  },

  "cookies.clear": async (p: CookiesClearParams): Promise<CookiesClearResult> => {
    const list = p.url
      ? await browser.cookies.getAll({ url: p.url })
      : p.domain
        ? await browser.cookies.getAll({ domain: p.domain })
        : [];
    let removed = 0;
    for (const c of list) {
      try {
        await browser.cookies.remove({ url: cookieUrl(c), name: c.name });
        removed++;
      } catch {}
    }
    return { removed };
  },

  "storage.get": async (p: StorageGetParams): Promise<StorageGetResult> => {
    const kinds = p.kinds && p.kinds.length ? p.kinds : ["local", "session"] as const;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: (kinds: Array<"local" | "session">, keys: string[] | null) => {
        const out: Record<string, Record<string, string | null>> = {};
        for (const kind of kinds) {
          const s = kind === "local" ? localStorage : sessionStorage;
          const names = keys ?? Array.from({ length: s.length }, (_, i) => s.key(i)!).filter(Boolean);
          const slot: Record<string, string | null> = {};
          for (const k of names) slot[k] = s.getItem(k);
          out[kind] = slot;
        }
        return out;
      },
      args: [kinds as any, p.keys ?? null],
    });
    return { values: result as StorageGetResult["values"] };
  },

  "storage.set": async (p: StorageSetParams) => {
    await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: (entries: Partial<Record<"local" | "session", Record<string, string>>>) => {
        for (const [kind, values] of Object.entries(entries)) {
          if (!values) continue;
          const s = kind === "local" ? localStorage : sessionStorage;
          for (const [k, v] of Object.entries(values)) s.setItem(k, v);
        }
      },
      args: [p.entries],
    });
    return { ok: true };
  },

  clear_storage: async (p: ClearStorageParams): Promise<ClearStorageResult> => {
    const kinds = p.kinds ?? ["localStorage", "sessionStorage", "indexedDB", "caches"];
    const cleared: string[] = [];

    const pageKinds = kinds.filter((k) => k !== "cookies");
    if (pageKinds.length) {
      const result = await runInMainWorld(
        p.tabId,
        async (kinds: string[]) => {
          const done: string[] = [];
          if (kinds.includes("localStorage")) {
            try { localStorage.clear(); done.push("localStorage"); } catch {}
          }
          if (kinds.includes("sessionStorage")) {
            try { sessionStorage.clear(); done.push("sessionStorage"); } catch {}
          }
          if (kinds.includes("indexedDB")) {
            try {
              const dbs = (await (indexedDB as any).databases?.()) ?? [];
              await Promise.all(dbs.map((d: any) => new Promise<void>((res) => {
                const req = indexedDB.deleteDatabase(d.name);
                req.onsuccess = () => res();
                req.onerror = () => res();
                req.onblocked = () => res();
              })));
              done.push("indexedDB");
            } catch {}
          }
          if (kinds.includes("caches")) {
            try {
              const ks = await caches.keys();
              await Promise.all(ks.map((k) => caches.delete(k)));
              done.push("caches");
            } catch {}
          }
          return done;
        },
        [pageKinds],
      );
      cleared.push(...result);
    }

    if (kinds.includes("cookies")) {
      const tab = await browser.tabs.get(p.tabId);
      if (tab.url) {
        const list = await browser.cookies.getAll({ url: tab.url });
        for (const c of list) {
          try { await browser.cookies.remove({ url: cookieUrl(c), name: c.name }); } catch {}
        }
        cleared.push("cookies");
      }
    }
    return { cleared };
  },
};
