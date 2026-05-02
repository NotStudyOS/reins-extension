import browser from "webextension-polyfill";
import type { HistoryParams, NavigateParams, TabsListResult } from "../../../src/shared/protocol";
import { activeTabId, runInMainWorld } from "./runtime";

export const tabHandlers: Record<string, (params: any) => Promise<unknown>> = {
  "tabs.list": async (): Promise<TabsListResult> => {
    const tabs = await browser.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        id: t.id!,
        url: t.url ?? "",
        title: t.title ?? "",
        active: !!t.active,
        windowId: t.windowId!,
      })),
    };
  },

  "tabs.create": async ({ url }: { url?: string }) => {
    const tab = await browser.tabs.create({ url });
    return { id: tab.id, url: tab.url };
  },

  "tabs.close": async ({ tabId }: { tabId: number }) => {
    await browser.tabs.remove(tabId);
    return { ok: true };
  },

  "tabs.activate": async ({ tabId }: { tabId: number }) => {
    await browser.tabs.update(tabId, { active: true });
    return { ok: true };
  },

  navigate: async (p: NavigateParams) => {
    const tabId = p.tabId ?? (await activeTabId());
    await browser.tabs.update(tabId, { url: p.url });
    const tab = await browser.tabs.get(tabId);
    return { tabId, url: tab.url ?? p.url };
  },

  back: async (p: HistoryParams) => {
    await runInMainWorld(p.tabId, () => history.back(), []);
    return { ok: true };
  },

  forward: async (p: HistoryParams) => {
    await runInMainWorld(p.tabId, () => history.forward(), []);
    return { ok: true };
  },

  reload: async (p: HistoryParams) => {
    await browser.tabs.reload(p.tabId, { bypassCache: !!p.bypassCache });
    return { ok: true };
  },
};
