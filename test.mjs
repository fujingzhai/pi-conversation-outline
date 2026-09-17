import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.env.PI_AGENT_ROOT || path.join(execFileSync('npm', ['root', '-g'], {encoding:'utf8'}).trim(), '@earendil-works/pi-coding-agent');
const require = createRequire(path.join(root, 'package.json'));
const { createJiti } = require('jiti');
const agent = path.join(root, 'dist/index.js');
const tuiPath = require.resolve('@earendil-works/pi-tui');
const jiti = createJiti(import.meta.url, {moduleCache:false, alias:{'@earendil-works/pi-coding-agent':agent, '@earendil-works/pi-tui':tuiPath}});
const { initTheme } = await import(pathToFileURL(path.join(root,'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
const { visibleWidth } = await import(pathToFileURL(tuiPath));
const {buildTurns, matchingTurns, visibleText} = await jiti.import('./extensions/model.ts');
const {collectUserMessages, collectPromptOffsets, matchUserMessage, offsetOf, jumpToTranscript, findTranscriptScrollView} = await jiti.import('./extensions/jump.ts');
const {computeRail, chevronTarget, hitTest, viewportState, wrapPreview, MIN_TURNS, OutlineRail} = await jiti.import('./extensions/rail.ts');
const theme = (await import(pathToFileURL(path.join(root,'dist/modes/interactive/theme/theme.js')))).theme;

const user = (id, text) => ({type:'message',id,message:{role:'user',content:text}});
const assistant = text => ({type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'SECRET'},{type:'text',text},{type:'toolCall',name:'SECRET_TOOL'}]}});
const entries = [user('a','\n第一问：經學史'), assistant('# 回答\n\n正文 **加粗**\n\n'+ '长回答文字。'.repeat(400)),
 {type:'message',message:{role:'toolResult',content:'SECRET_OUTPUT'}},
 {type:'compaction',summary:'SECRET_SUMMARY'},user('b','第二问：测试'), assistant('简短回答'),
 user('c',[{type:'image',data:'SECRET_BASE64'}]), assistant('图片回答')];
const original = JSON.stringify(entries);
const turns = buildTurns(entries);
assert.equal(turns.length,3); assert.equal(turns[0].title,'第一问：經學史');
assert.equal(turns[2].title,'[图片]'); assert(!JSON.stringify(turns).includes('SECRET'));
assert.equal(matchingTurns(turns,'經學').length,1);
assert.equal(visibleText('\x1b[31mhello\x1b[0m'),'hello');
assert.equal(JSON.stringify(entries),original);

assert.equal(computeRail(20, 1, {atBottom:false}), undefined);
const small = computeRail(20, 4, {active:1, upTarget:0, downTarget:2, atBottom:false});
assert.equal(small.windowStart, 0);
assert.equal(small.windowEnd, 4);
assert.equal(small.upY, 7);
assert.equal(small.ticksY, 8);
assert.equal(small.downY, 12);
assert.deepEqual(hitTest(small, 1, small.upY), {kind:'up'});
assert.deepEqual(hitTest(small, 1, small.ticksY + 3), {kind:'tick', turn:3});
assert.equal(hitTest(small, 2, small.ticksY), undefined);
assert.equal(chevronTarget(small, {kind:'up'}), 0);
assert.equal(chevronTarget(small, {kind:'down'}), 2);
const afterScroll = computeRail(20, 4, {active:3, upTarget:2, atBottom:true});
assert.equal(afterScroll.upY, small.upY);
assert.equal(afterScroll.ticksY, small.ticksY);
assert.equal(afterScroll.downY, small.downY);
// 底栏临时多占一行（cc 的 Back to bottom），视口 34→33：不带 refHeight 会跳一行
assert.equal(computeRail(34, 14, {active:13, atBottom:true}).upY - computeRail(33, 14, {active:12, atBottom:false}).upY, 1);
// 带贴底高度 34：贴底与滚离后位置一致
const tall = computeRail(34, 14, {active:13, atBottom:true}, 34);
const squeezed = computeRail(33, 14, {active:12, atBottom:false}, 34);
assert.deepEqual([squeezed.upY, squeezed.downY, squeezed.height], [tall.upY, tall.downY, 33]);
assert.equal(tall.height, 34);
// 轨几乎占满视口（矮终端或提问多）也不跳：贴底时就给按钮留出一行
const full = computeRail(13, 14, {active:13, atBottom:true}, 13);
const fullScrolled = computeRail(12, 14, {active:12, atBottom:false}, 13);
assert.deepEqual([fullScrolled.upY, fullScrolled.downY, fullScrolled.windowEnd - fullScrolled.windowStart], [full.upY, full.downY, full.windowEnd - full.windowStart]);
assert.ok(full.downY < 12);
// 放不下才按当前视口重排
const cramped = computeRail(10, 14, {active:12, atBottom:false}, 34);
assert.equal(cramped.height, 10);
assert.ok(cramped.downY < 10);

const overflow = computeRail(20, 50, {active:25, upTarget:24, downTarget:26, atBottom:false});
assert.equal(overflow.windowEnd - overflow.windowStart, 18);
assert.equal(overflow.windowStart, 16);
assert.ok(overflow.windowStart <= 25 && 25 < overflow.windowEnd);

const tail = computeRail(20, 50, {active:25, upTarget:24, downTarget:26, atBottom:true});
assert.equal(tail.windowStart, 25);
assert.equal(tail.windowEnd, 43);

const vp = viewportState(0, 200, 20, [0, 80, 160], 3);
assert.equal(vp.active, 0);
assert.equal(vp.upTarget, undefined);
assert.equal(vp.downTarget, 1);
const mid = viewportState(80, 200, 20, [0, 80, 160], 3);
assert.equal(mid.active, 1);
assert.equal(mid.upTarget, 0);
assert.equal(mid.downTarget, 2);

assert.deepEqual(wrapPreview('短标题', 16), ['短标题']);
assert.equal(wrapPreview('x'.repeat(80), 16)[0].length <= 16 + 1, true);
assert.ok(visibleWidth(wrapPreview('第一问：經學史'.repeat(8), 16)[0]) <= 16);

const fakeUser = (text, line) => ({text, rebuild(){}, outputPad:1, render:()=>[line]});
const u1 = fakeUser('第一问：經學史','U1');
const u2 = fakeUser('第二问：测试','U2');
const doc = {
  children: [{render:()=>['hdr']}, u1, {lastMessage:{}, render:()=>['A1']}, u2],
  render(){ return ['hdr', 'U1', 'A1', 'U2']; },
};
assert.equal(collectUserMessages(doc).length, 2);
assert.equal(matchUserMessage(collectUserMessages(doc), turns[1], turns), u2);
assert.equal(offsetOf(doc, u1, 80), 1);
assert.equal(offsetOf(doc, u2, 80), 3);
assert.deepEqual(collectPromptOffsets(doc, turns, 80), [1, 3, 0]);
let scrolled;
const sv = { primary:true, child:doc, getContentWidth:w=>w, viewportHeight:20, scrollTop:0, contentHeight:4, scrollTo(y,opts){ scrolled={y,opts}; } };
assert.equal(jumpToTranscript({mode:'regular'}, turns[0], turns), 'need-fullscreen');
assert.equal(jumpToTranscript({mode:'fullscreen', layoutRoot:{children:[]}, terminal:{columns:80}}, turns[0], turns), 'miss');
assert.equal(findTranscriptScrollView({layoutRoot:{children:[sv]}}), sv);
assert.equal(findTranscriptScrollView({
  layoutRoot:{children:[sv]},
  getPrimaryScrollView: () => ({scrollTo(){}, getContentWidth:w=>w, child:{}, viewportHeight:0}),
}), sv);
assert.equal(jumpToTranscript({mode:'fullscreen', layoutRoot:{children:[sv]}, terminal:{columns:80}, requestRender(){}}, turns[0], turns), 'ok');
assert.deepEqual(scrolled, {y:1, opts:{disableFollow:true}});

const tui = {mode:'fullscreen', terminal:{rows:24, columns:80}, layoutRoot:{children:[sv]}, requestRender(){}};
const jumped = [];
const rail = new OutlineRail(tui, theme, () => turns, () => {}, (turn) => jumped.push(turn.id));
const lines = rail.render(2);
// 轨只占对话区：终端 24 行、视口 20 行时只画 20 行，不盖输入框和 footer
assert.equal(lines.length, 20);
assert.deepEqual([rail.geometry.upY, rail.geometry.downY], [7, 11]); // 在 20 行里居中（按 24 行算会是 9、13）
sv.isFollowingEnd = false; sv.viewportHeight = 19; // 滚离底部，底栏多出一行按钮
assert.equal(rail.render(2).length, 19);
assert.deepEqual([rail.geometry.upY, rail.geometry.downY], [7, 11]);
sv.viewportHeight = 20;
rail.render(2);
assert.deepEqual([rail.geometry.upY, rail.geometry.downY], [7, 11]);
tui.terminal.rows = 30; sv.viewportHeight = 26; // 终端尺寸变了才重新排
rail.render(2);
assert.deepEqual([rail.geometry.upY, rail.geometry.downY], [10, 14]);
delete sv.isFollowingEnd; tui.terminal.rows = 24; sv.viewportHeight = 20;
rail.render(2);
assert.deepEqual(new OutlineRail({...tui, layoutRoot:{children:[]}}, theme, () => turns, () => {}, () => {}).render(2), []);
assert.ok(lines.every(s => visibleWidth(s) <= 2));
rail.handleMouse({type:'click', button:'left', x:1, y:rail.geometry.ticksY});
assert.equal(jumped[0], 'a');
assert.equal(rail.handleMouse({type:'click', button:'left', x:1, y:0}), undefined);
const missRail = new OutlineRail(tui, theme, () => turns, () => {}, () => {});
assert.equal(missRail.handleMouse({type:'click', button:'left', x:1, y:1}), undefined);
const hovers = [];
const rail2 = new OutlineRail(tui, theme, () => turns, (hit) => hovers.push(hit?.kind ?? 'none'), () => {});
rail2.render(2);
rail2.handleMouse({type:'move', x:1, y:rail2.geometry.ticksY});
assert.equal(hovers.at(-1), 'tick');
rail2.handleMouse({type:'move', x:1, y:0});
assert.equal(hovers.at(-1), 'none');
assert.equal(rail2.hovered, undefined);

const commands = new Map();
const shortcuts = new Map();
const indexMod = await jiti.import('./extensions/index.ts');
const factory = indexMod.default;
factory({registerCommand:(n,v)=>commands.set(n,v),registerShortcut:(n,v)=>shortcuts.set(n,v),on(){}});
assert.equal(commands.has('outline'), false);
assert.ok(shortcuts.has('ctrl+alt+o'));
assert.ok(MIN_TURNS >= 2);
assert.equal(indexMod.capturingOverlayVisible({ getTopmostVisibleOverlay: () => undefined }), false);
assert.equal(indexMod.capturingOverlayVisible({ getTopmostVisibleOverlay: () => ({}) }), true);
assert.equal(indexMod.capturingOverlayVisible({
  overlayStack: [{ options: { nonCapturing: true }, hidden: false }],
}), false);
assert.equal(indexMod.capturingOverlayVisible({
  overlayStack: [{ options: {}, hidden: false }],
  isOverlayVisible: (o) => !o.hidden,
}), true);
console.log('PASS: rail geometry, hover wrap, jump-to-transcript, no /outline, cc overlay compat');
