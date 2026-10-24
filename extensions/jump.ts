import { clean, type Turn } from "./model.ts";

export type JumpResult = "ok" | "need-fullscreen" | "miss";

const norm = (s: string) => clean(s).trim().replace(/\s+/g, " ");

export function isUserMessageComponent(c: any): boolean {
  return !!c && typeof c.text === "string" && typeof c.rebuild === "function"
    && typeof c.outputPad === "number" && !("lastMessage" in c);
}

export function collectUserMessages(root: any): any[] {
  const out: any[] = [];
  const walk = (c: any) => {
    if (!c) return;
    if (isUserMessageComponent(c)) { out.push(c); return; }
    for (const k of c.children ?? []) walk(k);
    if (c.child && c.child !== c) walk(c.child);
  };
  walk(root);
  return out;
}

/** 预先规范化全部提问，返回按 turn 取组件的函数；每帧都要跑，避免 O(轮数²) 次正则清洗 */
function userMatcher(users: any[], turns: Turn[]): (turn: Turn) => any | undefined {
  const key = (s: string) => norm(s === "[空消息]" ? "" : s);
  const userKeys = users.map(u => norm(u.text));
  const userKeysNoSpace = userKeys.map(k => k.replace(/ /g, ""));
  const turnKeys = turns.map(t => key(t.prompt));
  return (turn) => {
    const prompt = key(turn.prompt);
    const promptNoSpace = prompt.replace(/ /g, "");
    const hits: any[] = [];
    for (let i = 0; i < users.length; i++) {
      if (userKeys[i] === prompt || userKeysNoSpace[i] === promptNoSpace) hits.push(users[i]);
    }
    if (hits.length) {
      let prev = 0;
      for (let i = 0; i < Math.min(turn.ordinal - 1, turnKeys.length); i++) if (turnKeys[i] === prompt) prev++;
      return hits[Math.min(prev, hits.length - 1)];
    }
    return users[turn.ordinal - 1];
  };
}

export function matchUserMessage(users: any[], turn: Turn, turns: Turn[]): any | undefined {
  return userMatcher(users, turns)(turn);
}

/** 一次遍历算出各组件的布局行偏移，供文本锚点失效时兜底；避免每条提问各走一遍组件树。 */
function layoutOffsets(root: any, width: number): Map<any, number> {
  const offsets = new Map<any, number>();
  const heights = new Map<any, number>();
  const visited = new Set<any>();
  const height = (c: any): number => {
    if (!heights.has(c)) {
      try { heights.set(c, (c?.render?.(width) ?? []).length); }
      catch { heights.set(c, 0); }
    }
    return heights.get(c)!;
  };
  const walk = (node: any, base: number) => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    offsets.set(node, base);
    const children = node.children ?? [];
    let y = base;
    for (const child of children) {
      walk(child, y);
      y += height(child);
    }
    // ScrollView 等组件可能用 child 而非 children 暴露内容；两者都有时避免重复遍历。
    if (node.child && node.child !== node && !children.includes(node.child)) walk(node.child, base);
  };
  walk(root, 0);
  return offsets;
}

/** heights 若给出，按 turn 填入提问框的行数（顺带取自已渲染的结果，不额外渲染） */
export function collectPromptOffsets(doc: any, turns: Turn[], width: number, heights?: number[]): number[] {
  const users = collectUserMessages(doc);
  const lines: string[] = doc.render(width);
  const rendered: string[][] = users.map(u => u.render(width));
  const needles: (string | undefined)[] = rendered.map(r => r[0]);
  const wanted = new Set(needles.filter(Boolean));
  const rows = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!wanted.has(line)) continue;
    const list = rows.get(line);
    if (list) list.push(i);
    else rows.set(line, [i]);
  }
  const match = userMatcher(users, turns);
  let byLayout: Map<any, number> | undefined;
  return turns.map((turn, t) => {
    const target = match(turn);
    const idx = users.indexOf(target);
    if (heights) heights[t] = Math.max(1, idx < 0 ? 1 : rendered[idx]!.length);
    const needle = idx < 0 ? undefined : needles[idx];
    if (needle) {
      let skip = 0;
      for (let i = 0; i < idx; i++) if (needles[i] === needle) skip++;
      const byText = rows.get(needle)?.[skip];
      if (byText !== undefined) return byText;
    }
    byLayout ??= layoutOffsets(doc, width);
    return (target ? byLayout.get(target) : undefined) ?? 0;
  });
}

export function offsetOf(root: any, target: any, width: number): number | undefined {
  const lines: string[] = root.render(width);
  const needle: string | undefined = target.render(width)[0];
  if (!needle) return undefined;
  const users = collectUserMessages(root);
  const idx = users.indexOf(target);
  let skip = 0;
  for (let i = 0; i < idx; i++) {
    if (users[i].render(width)[0] === needle) skip++;
  }
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === needle) {
      if (seen === skip) return i;
      seen++;
    }
  }
  return undefined;
}

/** 文本锚点失效（如 Pi 1.4.0 的顶部空 padding 行）时，按组件树中的实际渲染高度定位。 */
export function offsetByLayout(root: any, target: any, width: number): number | undefined {
  return layoutOffsets(root, width).get(target);
}

function isScrollView(c: any): boolean {
  return !!c && typeof c.scrollTo === "function" && typeof c.getContentWidth === "function" && c.child;
}

function walkScroll(c: any, acc: any[] = []): any[] {
  if (!c) return acc;
  if (isScrollView(c)) acc.push(c);
  for (const k of c.children ?? []) walkScroll(k, acc);
  if (c.child && c.child !== c) walkScroll(c.child, acc);
  return acc;
}

export function findTranscriptScrollView(tui: any): any | undefined {
  // 快路径：上一帧布局记下的主滚动区就是对话区；每帧都要找，避免整棵组件树（含全部消息）遍历两遍
  const last = tui?.currentLayout?.primaryScrollView;
  if (tui?.layoutRoot && isScrollView(last) && last.primary) return last;
  const found = walkScroll(tui?.layoutRoot);
  for (const root of tui?.getMountedRoots?.() ?? []) walkScroll(root, found);
  const primary = found.find((s: any) => s.primary);
  if (primary) return primary;
  if (found.length) return found[0];
  const fromLayout = tui?.getPrimaryScrollView?.();
  if (isScrollView(fromLayout) && (fromLayout.viewportHeight ?? 0) > 0) return fromLayout;
  return undefined;
}

export function jumpToTranscript(tui: any, turn: Turn, turns: Turn[]): JumpResult {
  if (tui?.mode !== "fullscreen") return "need-fullscreen";
  const sv = findTranscriptScrollView(tui);
  const doc = sv?.child;
  if (!sv || !doc) return "miss";
  const width = Math.max(1, sv.getContentWidth(tui.terminal?.columns ?? 80));
  const target = matchUserMessage(collectUserMessages(doc), turn, turns);
  if (!target) return "miss";
  const y = offsetOf(doc, target, width) ?? offsetByLayout(doc, target, width);
  if (y === undefined) return "miss";
  sv.scrollTo(y, { disableFollow: true });
  tui.requestRender?.();
  return "ok";
}
