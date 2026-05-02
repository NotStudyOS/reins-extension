// JSON path DSL for read_network_extract. CSP-safe: no eval.
//
// Grammar (loose):
//   path   := segment ( "." segment | "[" index "]" )*
//   index  := "*" | /-?\d+/
//   segment:= /[A-Za-z_$][A-Za-z0-9_$]*/ | "{" projection "}"
//   projection := path ("," path)*      - pick named sub-paths into an object
//
// Examples:
//   "markets[*].marketType.name"
//   "events[*].{id,name,startTime}"
//   "markets[*].{name,type:marketType.name,sid:subscriptionKey}"
export function walkPath(root: unknown, expr: string): unknown {
  const s = expr.trim();
  if (!s) return root;
  return walkExpr(root, s);
}

function walkExpr(v: unknown, expr: string): unknown {
  let i = 0;
  let cur: unknown = v;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const end = expr.indexOf("]", i);
      if (end < 0) throw new Error("unclosed [");
      const idx = expr.slice(i + 1, end).trim();
      i = end + 1;
      if (idx === "*") {
        if (!Array.isArray(cur)) return [];
        const rest = expr.slice(i);
        const out: unknown[] = [];
        for (const item of cur) {
          const got = rest ? walkExpr(item, rest) : item;
          if (got === undefined) continue;
          if (Array.isArray(got)) out.push(...got);
          else out.push(got);
        }
        return out;
      }
      const n = Number(idx);
      if (!Array.isArray(cur) || !Number.isFinite(n)) return undefined;
      cur = cur[n < 0 ? cur.length + n : n];
      continue;
    }
    if (c === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "{") depth++;
        else if (expr[j] === "}") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth !== 0) throw new Error("unclosed {");
      const inner = expr.slice(i + 1, j);
      i = j + 1;
      const fields = splitTopLevel(inner, ",");
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        const colonIdx = indexOfTopLevel(f, ":");
        let key: string;
        let path: string;
        if (colonIdx >= 0) {
          key = f.slice(0, colonIdx).trim();
          path = f.slice(colonIdx + 1).trim();
        } else {
          path = f.trim();
          const lastDot = path.lastIndexOf(".");
          const lastBracket = path.lastIndexOf("]");
          const segStart = Math.max(lastDot, lastBracket) + 1;
          key = path.slice(segStart) || path;
        }
        obj[key] = walkExpr(cur, path);
      }
      cur = obj;
      continue;
    }

    let j = i;
    while (j < expr.length && /[A-Za-z0-9_$]/.test(expr[j])) j++;
    if (j === i) throw new Error(`unexpected char '${c}' at ${i}`);
    const name = expr.slice(i, j);
    i = j;
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[name];
  }
  return cur;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function indexOfTopLevel(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}
