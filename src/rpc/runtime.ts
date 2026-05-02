import browser from "webextension-polyfill";

export async function activeTabId(): Promise<number> {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!t?.id) throw new Error("no active tab");
  return t.id;
}

// Resolves when chrome.tabs.onUpdated fires status "complete" for tabId, or
// rejects on timeout. Used to pace navigation sequences without blind sleeps.
export function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`tab ${tabId} did not reach status=complete within ${timeoutMs}ms`));
    }, timeoutMs);
    const onUpdated = (changedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (changedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function runInPage<Args extends unknown[]>(
  tabId: number,
  func: (...args: Args) => unknown,
  args: Args,
) {
  await runInMainWorld(tabId, func, args);
}

export async function runInMainWorld<Result, Args extends unknown[]>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: func as any,
    args: args as any,
  });
  return result as Awaited<Result>;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
