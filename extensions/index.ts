import { ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { findTranscriptScrollView } from "./jump.ts";
import { buildTurns, type Turn } from "./model.ts";
import {
  HoverPopup, MIN_TERMINAL_WIDTH, MIN_TURNS, OutlineRail, RAIL_WIDTH,
  jumpTurn, unpatchGutter, wrapPreview, type TimelineHit,
} from "./rail.ts";

const MOTION = "\x1b[?1003h";
const WATCH = Symbol.for("pi-outline.mouse-watch");
const MOTION_ON = Symbol.for("pi-outline.motion-on");
const HAS_OVERLAY = Symbol.for("pi-outline.hasOverlay");
const NATIVE_CLICK = Symbol.for("pi-outline.suppress-native-tool-click");
const CC_TOOL_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");

let enabled = true;
let closeRail: (() => void) | undefined;
let opening = false;
let unwatch: (() => void) | undefined;
let unpatchOverlay: (() => void) | undefined;
let unpatchNativeClick: (() => void) | undefined;
let railHandle: OverlayHandle | undefined;
let popupHandle: OverlayHandle | undefined;
let popupOpts: OverlayOptions | undefined;
let popup: HoverPopup | undefined;
let popupWanted = false;
let railRef: OutlineRail | undefined;
let generation = 0;

function parseMove(data: string): { x: number; y: number } | undefined {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
  if (!m) return undefined;
  return { x: Number(m[2]) - 1, y: Number(m[3]) - 1 };
}

/** cc 用 hasOverlay() 决定要不要处理 click-to-show-more；Pi 把 nonCapturing overlay 也算进去。大纲轨必须是 nonCapturing，否则会让 cc 整段鼠标失效。这里改成与 getTopmostVisibleOverlay 相同的“是否有抢输入的 overlay”。 */
export function capturingOverlayVisible(tui: any): boolean {
  if (typeof tui?.getTopmostVisibleOverlay === "function") {
    return tui.getTopmostVisibleOverlay() != null;
  }
  const stack = tui?.overlayStack;
  if (!Array.isArray(stack)) return false;
  return stack.some((entry: any) => {
    if (entry?.options?.nonCapturing) return false;
    if (typeof tui.isOverlayVisible === "function") return !!tui.isOverlayVisible(entry);
    return !entry?.hidden;
  });
}

function patchHasOverlay(tui: any): () => void {
  if (!tui || tui[HAS_OVERLAY]) return () => {};
  const proto = Object.getPrototypeOf(tui);
  tui.hasOverlay = function (this: any) {
    return capturingOverlayVisible(this);
  };
  const dispose = () => {
    if (tui[HAS_OVERLAY]?.dispose !== dispose) return;
    if (typeof proto?.hasOverlay === "function") tui.hasOverlay = proto.hasOverlay;
    else delete tui.hasOverlay;
    tui[HAS_OVERLAY] = undefined;
  };
  tui[HAS_OVERLAY] = { dispose };
  return dispose;
}

/** cc mode=on 折叠卡用 self shell；Pi 原生 MouseRegion 单击会自行 toggle，与 cc 自己的“单击展开/折叠”重复触发。挡住这条原生切换，统一由 cc 处理。 */
function patchNativeToolClick(): () => void {
  const proto = ToolExecutionComponent.prototype as any;
  if (proto[NATIVE_CLICK]) return proto[NATIVE_CLICK].dispose ?? (() => {});
  const original = proto.handleMouse;
  if (typeof original !== "function") return () => {};
  proto.handleMouse = function (this: any, event: any) {
    if (event?.type === "click" && event?.button === "left") {
      let shell: unknown;
      try { shell = this.getRenderShell?.(); } catch { /* ignore */ }
      if (shell === "self" && this[CC_TOOL_MODE] === true) return undefined;
    }
    return original.call(this, event);
  };
  const dispose = () => {
    if (proto[NATIVE_CLICK]?.dispose !== dispose) return;
    proto.handleMouse = original;
    proto[NATIVE_CLICK] = undefined;
  };
  proto[NATIVE_CLICK] = { dispose };
  return dispose;
}

function installMouseWatch(tui: any, onData: (data: string) => void): () => void {
  (tui[WATCH] as { dispose?: () => void } | undefined)?.dispose?.();
  const proto = Object.getPrototypeOf(tui);
  const patched: string[] = [];
  for (const name of ["parseSgrMouseEvent", "parseWheelEvent"] as const) {
    const original = proto?.[name];
    if (typeof original !== "function") continue;
    tui[name] = function (this: any, data: string) {
      try { onData(data); } catch { /* ignore */ }
      return original.call(this, data);
    };
    patched.push(name);
  }
  const dispose = () => {
    if (tui[WATCH]?.dispose !== dispose) return;
    for (const name of patched) delete tui[name];
    tui[WATCH] = undefined;
  };
  tui[WATCH] = { dispose };
  return dispose;
}

function hidePopup(tui?: TUI) {
  if (!popupWanted) return;
  popupWanted = false;
  tui?.requestRender?.();
}

function placePopup(tui: TUI, hit: TimelineHit | undefined, title?: string) {
  if (hit?.kind !== "tick" || !title || !railRef?.geometry) {
    hidePopup(tui);
    return;
  }
  const bounds = railHandle?.getBounds?.();
  if (!bounds) return;
  const maxText = Math.max(16, Math.min(32, Math.floor((tui.terminal.columns - RAIL_WIDTH) / 2)));
  const lines = wrapPreview(title, maxText);
  const textW = Math.max(1, ...lines.map(visibleWidth));
  const cardW = Math.min(Math.max(8, tui.terminal.columns - RAIL_WIDTH - 1), textW + 4);
  const cardH = (lines.length || 1) + 2;
  const tickY = bounds.row + railRef.geometry.ticksY + (hit.turn - railRef.geometry.windowStart);
  if (!popup || !popupOpts) return;
  popup.preview = title;
  popupOpts.width = cardW;
  popupOpts.col = Math.max(0, bounds.col - cardW - 1);
  popupOpts.row = Math.max(bounds.row, Math.min(tickY - Math.floor(cardH / 2), bounds.row + bounds.height - cardH));
  popupWanted = true;
}

function onGlobalMouse(tui: TUI, data: string) {
  const pos = parseMove(data);
  if (!pos || !railRef) return;
  const bounds = railHandle?.getBounds?.();
  if (!bounds) return;
  const onRail = pos.x >= bounds.col && pos.x < bounds.col + bounds.width
    && pos.y >= bounds.row && pos.y < bounds.row + bounds.height;
  if (onRail) return;
  if (!popupWanted && !railRef.hovered) return;
  railRef.clearHover();
  hidePopup(tui);
}

function teardown(tui?: TUI) {
  unwatch?.();
  unwatch = undefined;
  unpatchOverlay?.();
  unpatchOverlay = undefined;
  unpatchNativeClick?.();
  unpatchNativeClick = undefined;
  popupWanted = false;
  // 一律按 handle 摘除：hideOverlay() 只会弹栈顶，栈顶若是别的插件的弹窗就会误关它、自己却留在屏上
  try { popupHandle?.hide(); } catch { /* gone */ }
  try { railHandle?.hide(); } catch { /* gone */ }
  popupHandle = undefined;
  railHandle = undefined;
  popupOpts = undefined;
  popup = undefined;
  railRef = undefined;
  if (tui) unpatchGutter(findTranscriptScrollView(tui));
}

/** 借 ctx.ui.custom 拿到 TUI 与主题，占位 overlay 当场关掉。
 *  onHandle 与 showOverlay 同步相连，此刻占位必在栈顶，done() 内部的 hideOverlay() 只会弹掉它自己。 */
async function grabTui(ctx: ExtensionContext): Promise<{ tui: TUI; theme: Theme } | undefined> {
  let got: { tui: TUI; theme: Theme } | undefined;
  let finish: (() => void) | undefined;
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    got = { tui, theme };
    finish = () => done();
    return { render: () => [], invalidate() {} };
  }, {
    overlay: true,
    overlayOptions: { nonCapturing: true, visible: () => false },
    onHandle: () => finish?.(),
  });
  return got;
}

/** 提问列表按叶子节点缓存：visible() 与 render() 每帧都要，分支不变就不重扫整条会话 */
function turnsReader(ctx: ExtensionContext): () => Turn[] {
  let leaf: string | null | undefined;
  let cached: Turn[] = [];
  let primed = false;
  return () => {
    const id = ctx.sessionManager.getLeafId();
    if (!primed || id !== leaf) {
      cached = buildTurns(ctx.sessionManager.getBranch());
      leaf = id;
      primed = true;
    }
    return cached;
  };
}

async function openRail(ctx: ExtensionContext) {
  if (ctx.mode !== "tui" || !enabled || opening || closeRail) return;
  opening = true;
  const gen = generation;
  try {
    const got = await grabTui(ctx);
    if (!got || !enabled || closeRail || gen !== generation) return;
    const { tui, theme } = got;
    const turns = turnsReader(ctx);
    popup = new HoverPopup(theme);
    const rail = new OutlineRail(tui, theme, turns, (hit, turn) => {
      placePopup(tui, hit, turn?.title);
    }, (turn, all) => {
      hidePopup(tui);
      const result = jumpTurn(tui, turn, all);
      if (result === "need-fullscreen") ctx.ui.notify("跳转需要 fullscreen。", "warning");
      else if (result === "miss") ctx.ui.notify("未能定位该条提问。", "warning");
    });
    railRef = rail;
    unpatchOverlay = patchHasOverlay(tui);
    unpatchNativeClick = patchNativeToolClick();
    if (!(tui as any)[MOTION_ON]) {
      tui.terminal?.write?.(MOTION);
      (tui as any)[MOTION_ON] = true;
    }
    railHandle = tui.showOverlay(rail, {
      nonCapturing: true,
      anchor: "top-right",
      width: RAIL_WIDTH,
      margin: { top: 0, right: 0 },
      visible: (w) => {
        let show = false;
        try {
          show = w >= MIN_TERMINAL_WIDTH && turns().length >= MIN_TURNS;
        } catch { /* 会话已替换，ctx 失效 */ }
        if (!show) {
          popupWanted = false;
          unpatchGutter(findTranscriptScrollView(tui));
        }
        return show;
      },
    });
    // 悬停卡与轨同时入栈：若等首次悬停才建，可能压在别的弹窗之上，那个弹窗关闭时弹栈顶会误弹悬停卡、自己卡在屏上
    popupOpts = { nonCapturing: true, width: 8, row: 0, col: 0, visible: () => popupWanted };
    popupHandle = tui.showOverlay(popup, popupOpts);
    unwatch = installMouseWatch(tui, (data) => onGlobalMouse(tui, data));
    closeRail = () => {
      teardown(tui);
      closeRail = undefined;
    };
  } catch (err) {
    ctx.ui.notify(`大纲轨打开失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    opening = false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+alt+o", {
    description: "显示/隐藏对话大纲轨",
    handler: (ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("大纲轨需要终端交互模式", "warning");
        return;
      }
      if (closeRail) {
        enabled = false;
        closeRail();
        ctx.ui.notify("大纲轨已隐藏", "info");
        return;
      }
      enabled = true;
      void openRail(ctx);
      ctx.ui.notify("大纲轨已显示", "info");
    },
  });
  pi.on("session_start", (_e, ctx) => {
    enabled = true;
    void openRail(ctx);
  });
  pi.on("session_shutdown", () => {
    generation++;
    closeRail?.();
  });
}
