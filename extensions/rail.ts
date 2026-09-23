import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { collectPromptOffsets, findTranscriptScrollView, jumpToTranscript } from "./jump.ts";
import type { Turn } from "./model.ts";

export const RAIL_WIDTH = 2;
export const MIN_TERMINAL_WIDTH = 60;
export const MIN_TURNS = 1;

export type TimelineHit = { kind: "tick"; turn: number } | { kind: "up" } | { kind: "down" };

export interface RailViewport {
  /** 高亮区间 activeFrom..active：屏幕上看得到的提问；一条都看不到时只有所在那条 */
  activeFrom?: number;
  active?: number;
  upTarget?: number;
  downTarget?: number;
  atBottom: boolean;
}

export interface TimelineRail {
  height: number;
  windowStart: number;
  windowEnd: number;
  ticksY: number;
  activeFrom?: number;
  active?: number;
  upTarget?: number;
  downTarget?: number;
  upY: number;
  downY: number;
}

const hitKey = (h?: TimelineHit) => !h ? "" : h.kind === "tick" ? `t${h.turn}` : h.kind;

const pad2 = (s: string) => {
  const w = visibleWidth(s);
  if (w >= RAIL_WIDTH) return truncateToWidth(s, RAIL_WIDTH, "");
  return " ".repeat(RAIL_WIDTH - w) + s;
};

export function promptsAboveTop(promptYs: number[], top: number, strict: boolean): number {
  let n = 0;
  for (const y of promptYs) {
    if (strict ? y < top : y <= top) n++;
    else break;
  }
  return n;
}

export function viewportState(scrollTop: number, contentHeight: number, viewportHeight: number, promptYs: number[], turnCount: number, promptHeights?: number[]): RailViewport {
  if (turnCount <= 0) return { atBottom: true };
  const above = promptsAboveTop(promptYs, scrollTop, false);
  const aboveStrict = promptsAboveTop(promptYs, scrollTop, true);
  // 当前提问＝屏幕上已出现的最后一条：下一条一露头就算进入它，不必等它顶到屏幕上沿；▲▼ 仍按屏幕上沿找前后条
  const shown = promptsAboveTop(promptYs, scrollTop + Math.max(1, viewportHeight) - 1, false);
  const active = Math.max(0, shown - 1);
  // 往前数仍有一行留在屏幕里的提问（长提问首行滚出上沿也算），它们与 active 一起高亮
  let from = shown;
  while (from > 0 && promptYs[from - 1]! + (promptHeights?.[from - 1] ?? 1) - 1 >= scrollTop) from--;
  const activeFrom = from < shown ? from : active;
  const upTarget = aboveStrict > 0 ? aboveStrict - 1 : undefined;
  const down = above < turnCount ? above : undefined;
  const atBottom = contentHeight <= viewportHeight || scrollTop >= contentHeight - viewportHeight;
  return { activeFrom, active, upTarget, downTarget: down, atBottom };
}

/** 滚离底部时底栏会多占的行数：cc 的 Back to bottom 按钮占一行，对话区视口随之变矮 */
export const DOCK_SLACK = 1;

/** Tick position encodes conversation order, not scroll proportion. Ported from Grok Build's compute_rail.
 *  refHeight：贴底时的视口高度。给了就按 refHeight 少 DOCK_SLACK 行来排，当前视口放得下就用这个位置，
 *  滚动时轨不动；放不下才按当前视口重排。不给则按当前视口居中。 */
export function computeRail(height: number, turnCount: number, vp: RailViewport, refHeight?: number): TimelineRail | undefined {
  if (refHeight !== undefined) {
    const stable = computeRail(refHeight - DOCK_SLACK, turnCount, vp);
    if (stable && stable.downY < height) return { ...stable, height };
  }
  if (turnCount < MIN_TURNS) return undefined;
  const maxTicks = height - 2;
  if (maxTicks <= 0) return undefined;
  let start: number;
  if (turnCount <= maxTicks) start = 0;
  else {
    const tailStart = turnCount - maxTicks;
    if (vp.atBottom) start = Math.min(vp.active ?? tailStart, tailStart);
    else start = Math.min(tailStart, Math.max(0, (vp.active ?? turnCount - 1) - Math.floor(maxTicks / 2)));
  }
  const windowEnd = Math.min(turnCount, start + (turnCount <= maxTicks ? turnCount : maxTicks));
  const totalRows = (windowEnd - start) + 2;
  const top = Math.floor((height - totalRows) / 2);
  const ticksY = top + 1;
  return {
    height, windowStart: start, windowEnd, ticksY,
    activeFrom: vp.activeFrom, active: vp.active, upTarget: vp.upTarget, downTarget: vp.downTarget,
    upY: top, downY: ticksY + (windowEnd - start),
  };
}

export function hitTest(rail: TimelineRail, x: number, y: number): TimelineHit | undefined {
  if (x < 0 || x >= RAIL_WIDTH || y < 0 || y >= rail.height) return undefined;
  if (y === rail.upY) return { kind: "up" };
  if (y === rail.downY) return { kind: "down" };
  if (y >= rail.ticksY) {
    const rel = y - rail.ticksY;
    const len = rail.windowEnd - rail.windowStart;
    if (rel < len) return { kind: "tick", turn: rail.windowStart + rel };
  }
  return undefined;
}

export function chevronTarget(rail: TimelineRail, hit?: TimelineHit): number | undefined {
  if (!hit) return undefined;
  if (hit.kind === "tick") return hit.turn;
  if (hit.kind === "up") return rail.upTarget;
  return rail.downTarget;
}

export function wrapPreview(text: string, width: number): string[] {
  const src = text.trim();
  if (!src) return [];
  const w = Math.max(1, width);
  if (visibleWidth(src) <= w) return [src];
  const chars = [...src];
  const line1: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = Math.max(1, visibleWidth(chars[i]!));
    if (used + cw > w && line1.length) break;
    line1.push(chars[i]!);
    used += cw;
  }
  const rest = chars.slice(i).join("").trim();
  return rest ? [line1.join(""), truncateToWidth(rest, w, "…")] : [line1.join("")];
}

export class HoverPopup {
  preview = "";
  constructor(private theme: Theme) {}
  invalidate() {}
  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(4, width - 2);
    const textW = inner - 2;
    const body = wrapPreview(this.preview, textW);
    const lines = body.length ? body : [" "];
    const edge = (s: string) => th.fg("border", s);
    const fit = (s: string) => {
      const clipped = truncateToWidth(s, textW, "");
      return clipped + " ".repeat(Math.max(0, textW - visibleWidth(clipped)));
    };
    return [
      edge(`╭${"─".repeat(inner)}╮`),
      ...lines.map(line => edge("│") + " " + th.fg("text", fit(line)) + " " + edge("│")),
      edge(`╰${"─".repeat(inner)}╯`),
    ];
  }
}

export class OutlineRail {
  geometry?: TimelineRail;
  hovered?: TimelineHit;
  /** 最近一次贴底时的视口高度；滚离底部后沿用，换终端尺寸才作废 */
  private refHeight = 0;
  private refKey = "";
  constructor(
    private tui: TUI,
    private theme: Theme,
    private getTurns: () => Turn[],
    private onHover: (hit: TimelineHit | undefined, turn?: Turn) => void,
    private onJump: (turn: Turn, turns: Turn[]) => void,
  ) {}
  invalidate() {}
  clearHover() {
    if (!this.hovered) return false;
    this.hovered = undefined;
    this.onHover(undefined);
    return true;
  }
  handleMouse(e: TuiMouseEvent) {
    if (e.type === "wheel") return undefined;
    const hit = this.geometry ? hitTest(this.geometry, e.x, e.y) : undefined;
    if (e.type === "move") {
      if (hitKey(hit) === hitKey(this.hovered)) return undefined;
      this.hovered = hit;
      const turns = this.getTurns();
      const turn = hit?.kind === "tick" ? turns[hit.turn] : undefined;
      this.onHover(hit, turn);
      return { handled: true, render: true };
    }
    if (e.type === "click" && e.button === "left") {
      const target = this.geometry ? chevronTarget(this.geometry, hit) : undefined;
      const turns = this.getTurns();
      if (target === undefined || !turns[target]) return undefined;
      this.onJump(turns[target], turns);
      return { handled: true, render: true };
    }
    return undefined;
  }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, RAIL_WIDTH));
    const sv = findTranscriptScrollView(this.tui);
    const turns = this.getTurns();
    // 只占对话区（transcript 视口）的高度：overlay 行数就是覆盖范围，按终端行数画会盖住输入框和 footer 最右两列
    const height = Math.max(0, sv?.viewportHeight ?? 0);
    if (!sv || turns.length < MIN_TURNS || height < 3) {
      this.geometry = undefined;
      if (sv) unpatchGutter(sv);
      return [];
    }
    patchGutter(sv);
    const th = this.theme;
    const lines = Array.from({ length: height }, () => " ".repeat(w));
    const termW = this.tui.terminal?.columns ?? 80;
    const contentWidth = Math.max(1, sv.getContentWidth?.(termW) ?? termW);
    const promptHeights: number[] = [];
    const promptYs = sv.child ? collectPromptOffsets(sv.child, turns, contentWidth, promptHeights) : turns.map(() => 0);
    const vp = viewportState(sv.scrollTop ?? 0, sv.contentHeight ?? 0, height, promptYs, turns.length, promptHeights);
    const key = `${termW}x${this.tui.terminal?.rows ?? 0}`;
    // 贴底判据与 cc 显示按钮的判据一致（isFollowingEnd），贴底时按钮不在，此刻的视口就是基准
    if (key !== this.refKey || !this.refHeight || (sv.isFollowingEnd ?? vp.atBottom)) {
      this.refKey = key;
      this.refHeight = height;
    }
    const rail = computeRail(height, turns.length, vp, this.refHeight);
    this.geometry = rail;
    if (!rail) return lines;
    const paint = (y: number, text: string, color: "dim" | "muted" | "accent") => {
      if (y < 0 || y >= height) return;
      lines[y] = th.fg(color, pad2(text));
    };
    const upOn = rail.upTarget !== undefined;
    const downOn = rail.downTarget !== undefined;
    paint(rail.upY, "▲", this.hovered?.kind === "up" && upOn ? "accent" : upOn ? "muted" : "dim");
    paint(rail.downY, "▼", this.hovered?.kind === "down" && downOn ? "accent" : downOn ? "muted" : "dim");
    for (let i = 0; i < rail.windowEnd - rail.windowStart; i++) {
      const turn = rail.windowStart + i;
      const active = rail.active !== undefined && turn >= (rail.activeFrom ?? rail.active) && turn <= rail.active;
      const hovered = this.hovered?.kind === "tick" && this.hovered.turn === turn;
      paint(rail.ticksY + i, active || hovered ? "━━" : "─", active || hovered ? "accent" : "dim");
    }
    return lines;
  }
}

const GUTTER = Symbol.for("pi-outline.gutter");

export function patchGutter(sv: any) {
  if (!sv || sv[GUTTER]) {
    if (sv?.[GUTTER] && sv.scrollbar !== "hidden") sv.setScrollbar?.("hidden");
    return;
  }
  sv[GUTTER] = { getContentWidth: sv.getContentWidth.bind(sv), scrollbar: sv.scrollbar };
  sv.getContentWidth = (width: number) => Math.max(1, width - RAIL_WIDTH);
  sv.setScrollbar?.("hidden");
}

export function unpatchGutter(sv: any) {
  const orig = sv?.[GUTTER];
  if (!orig) return;
  sv.getContentWidth = orig.getContentWidth;
  if (orig.scrollbar !== undefined) sv.setScrollbar?.(orig.scrollbar);
  delete sv[GUTTER];
}

export function jumpTurn(tui: TUI, turn: Turn, turns: Turn[]) {
  return jumpToTranscript(tui, turn, turns);
}
