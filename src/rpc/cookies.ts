export function cookieUrl(cookie: { secure?: boolean; domain: string; path?: string }): string {
  return `${cookie.secure ? "https" : "http"}://${(cookie.domain || "").replace(/^\./, "")}${cookie.path || "/"}`;
}
