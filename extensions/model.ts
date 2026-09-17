// Original implementation, inspired by Grok Build's per-prompt timeline.
// No tool results, reasoning blocks, API calls, or session mutations.
export interface Turn { id: string; ordinal: number; title: string; prompt: string; answers: string[] }

export function clean(text: string): string {
  // Strip terminal control sequences from untrusted conversation text.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function visibleText(content: unknown): string {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  return content.flatMap(b => b?.type === "text" && typeof b.text === "string" ? [clean(b.text)]
    : b?.type === "image" ? ["[图片]"] : []).join("\n\n");
}
export function buildTurns(entries: readonly any[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m?.role === "user") {
      const prompt = visibleText(m.content) || "[空消息]";
      const first = prompt.split("\n").find(s => s.trim())?.trim() || "[空消息]";
      const chars = Array.from(first);
      turns.push({ id: e.id, ordinal: turns.length + 1,
        title: chars.slice(0, 120).join("") + (chars.length > 120 ? "…" : ""), prompt, answers: [] });
    } else if (m?.role === "assistant" && turns.length) {
      const text = visibleText(m.content);
      if (text.trim()) turns[turns.length - 1].answers.push(text);
    }
  }
  return turns;
}
export function matchingTurns(turns: Turn[], query: string): Turn[] {
  const q = query.trim().normalize("NFKC").toLocaleLowerCase();
  return q ? turns.filter(t => t.prompt.normalize("NFKC").toLocaleLowerCase().includes(q)) : turns;
}
