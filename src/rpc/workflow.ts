import type {
  WorkflowParams,
  WorkflowResult,
  WorkflowStep,
} from "../shared/protocol";
import { sleep } from "./runtime";

/**
 * workflow — record / replay user-action workflows.
 *
 * Recording installs in-page listeners that push normalized {kind, selector,
 * value, ts} steps into a buffer keyed by tab. Stop pulls them out, names
 * them, and persists in the SW (in-memory; survives RPC calls until
 * extension reload). Replay drives the recorded steps via existing
 * RPC primitives so playback is deterministic.
 *
 * Note: this is a normal user-action recorder, not a captcha-defeating
 * mouse-coord recorder. It uses CSS selectors (via a pathFor heuristic),
 * `element.click()`, and standard input events.
 */

type RecordedSteps = WorkflowStep[];
const recordings = new Map<string, RecordedSteps>(); // name → steps
const activeRecorders = new Map<number, string>();   // tabId → recording-name

export const workflowHandlers: Record<string, (p: any) => Promise<unknown>> = {
  workflow: async (p: WorkflowParams): Promise<WorkflowResult> => {
    if (p.action === "list") return { action: "list", names: [...recordings.keys()] };
    if (p.action === "delete") {
      if (!p.name) throw new Error("workflow.delete: name required");
      recordings.delete(p.name);
      return { action: "delete", name: p.name, ok: true };
    }
    if (p.action === "record_start") {
      if (!p.name) throw new Error("workflow.record_start: name required");
      if (activeRecorders.has(p.tabId)) throw new Error("a recording is already active on this tab");
      activeRecorders.set(p.tabId, p.name);
      recordings.set(p.name, []);
      // Install in-page listeners.
      await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        world: "MAIN",
        func: installRecorderInPage as any,
        args: [p.name],
      });
      return { action: "record_start", name: p.name, ok: true };
    }
    if (p.action === "record_stop") {
      const name = p.name ?? activeRecorders.get(p.tabId);
      if (!name) throw new Error("workflow.record_stop: no active recording");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        world: "MAIN",
        func: stopRecorderInPage as any,
        args: [name],
      });
      const steps = (result as WorkflowStep[]) || [];
      recordings.set(name, steps);
      activeRecorders.delete(p.tabId);
      return { action: "record_stop", name, steps };
    }
    if (p.action === "replay") {
      if (!p.name) throw new Error("workflow.replay: name required");
      const steps = recordings.get(p.name);
      if (!steps) throw new Error(`workflow.replay: no recording "${p.name}"`);
      const startTs = steps[0]?.ts ?? Date.now();
      let prevTs = startTs;
      for (const step of steps) {
        const wait = p.stepDelayMs !== undefined ? p.stepDelayMs : Math.max(50, Math.min(2000, step.ts - prevTs));
        await sleep(wait);
        prevTs = step.ts;
        await replayStep(p.tabId, step);
      }
      return { action: "replay", name: p.name, steps };
    }
    return { action: p.action } as any;
  },
};

async function replayStep(tabId: number, step: WorkflowStep) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (step: WorkflowStep) => {
      const el = step.selector ? document.querySelector(step.selector) as HTMLElement | null : null;
      switch (step.kind) {
        case "click": el?.click(); break;
        case "type": {
          if (!el) return;
          (el as HTMLElement).focus();
          const setter = Object.getOwnPropertyDescriptor(
            el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(el, step.value || "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        case "press": {
          const target = el || document.activeElement || document.body;
          const ev = new KeyboardEvent("keydown", { key: step.value, bubbles: true });
          target.dispatchEvent(ev);
          target.dispatchEvent(new KeyboardEvent("keyup", { key: step.value, bubbles: true }));
          break;
        }
        case "scroll":
          if (el) el.scrollIntoView({ behavior: "auto", block: "center" });
          else if (step.value) {
            const [x, y] = step.value.split(",").map((n) => parseInt(n, 10));
            window.scrollTo(x || 0, y || 0);
          }
          break;
        case "navigate":
          if (step.url) location.href = step.url;
          break;
      }
    },
    args: [step],
  });
}

// ─── in-page recorder helpers (top-level for esbuild) ───

function installRecorderInPage(name: string) {
  const w: any = window as any;
  if (!w.__bmcpRecorders) w.__bmcpRecorders = {};
  if (w.__bmcpRecorders[name]) return; // already
  const buf: any[] = [];
  const path = (el: Element): string => {
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
  };
  const onClick = (ev: MouseEvent) => {
    const t = ev.target as Element | null;
    if (!t) return;
    buf.push({ kind: "click", selector: path(t), ts: Date.now() });
  };
  const onInput = (ev: Event) => {
    const t = ev.target as HTMLInputElement | null;
    if (!t || !("value" in t)) return;
    buf.push({ kind: "type", selector: path(t), value: t.value, ts: Date.now() });
  };
  const onKey = (ev: KeyboardEvent) => {
    if (["Enter", "Escape", "Tab"].includes(ev.key)) {
      buf.push({ kind: "press", selector: path((ev.target as Element) || document.body), value: ev.key, ts: Date.now() });
    }
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKey, true);
  w.__bmcpRecorders[name] = { buf, off: () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("keydown", onKey, true);
  }};
}

function stopRecorderInPage(name: string): WorkflowStep[] {
  const w: any = window as any;
  const r = w.__bmcpRecorders?.[name];
  if (!r) return [];
  r.off();
  delete w.__bmcpRecorders[name];
  return r.buf;
}
