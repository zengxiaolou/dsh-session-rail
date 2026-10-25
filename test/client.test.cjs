/**
 * Client-half regression test: runs the browser module against a minimal React
 * stub (hooks + effects, no DOM) and the real host payload shapes, so the tab
 * descriptor, its badge and the empty states are all checked without a browser.
 *
 *   node test/client.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- React stub
let cursor = null;
const states = new WeakMap();
let collected = [];
const React = {
  createElement(type, props, ...children) {
    const node = {
      type,
      props: { ...(props || {}), children: children.length ? (children.length === 1 ? children[0] : children) : (props || {}).children },
    };
    collected.push(node);
    return node;
  },
  useState(init) {
    const scope = cursor;
    const index = scope.slots.i++;
    if (!(index in scope.slots.v)) scope.slots.v[index] = typeof init === 'function' ? init() : init;
    return [scope.slots.v[index], (next) => {
      scope.slots.v[index] = typeof next === 'function' ? next(scope.slots.v[index]) : next;
    }];
  },
  useEffect(fn) {
    cursor.slots.effects.push(fn);
  },
};

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(render).join('');
  if (node.type === 'style') return '';
  if (typeof node.type === 'function') {
    let scope = states.get(node.type);
    if (!scope) {
      scope = { slots: { i: 0, v: [], effects: [] } };
      states.set(node.type, scope);
    }
    scope.slots.i = 0;
    scope.slots.effects = [];
    const previous = cursor;
    cursor = scope;
    const out = node.type(node.props || {});
    cursor = previous;
    return render(out);
  }
  return render(node.props?.children);
}

// -------------------------------------------------------------- fake host IO
const bodies = {};
const sandboxFetch = (url) => {
  const pathname = String(url).split('?')[0];
  const body = bodies[pathname];
  if (!body) return Promise.reject(new Error(`unexpected url ${url}`));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

const localStore = new Map();

function loadModule() {
  let loaded;
  const sandbox = {
    window: {
      localStorage: {
        getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
        setItem: (key, value) => { localStore.set(key, String(value)); },
        removeItem: (key) => { localStore.delete(key); },
      },
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          loaded = { id, mod: factory((name) => {
            if (name === 'react') return React;
            throw new Error(`unexpected require ${name}`);
          }) };
        },
      },
    },
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    fetch: sandboxFetch,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });
  loaded.sandbox = sandbox;
  return loaded;
}

async function mount(component, props) {
  collected = [];
  render(React.createElement(component, props));
  for (const effect of states.get(component).slots.effects) await effect();
  await new Promise((resolve) => setImmediate(resolve));
  collected = [];
  const text = render(React.createElement(component, props));
  return { text, nodes: collected };
}

(async () => {
  const { id, mod, sandbox } = loadModule();
  assert.equal(id, 'dsh-session-rail');

  // 1. no betterSidebar service: apply must not throw and must register nothing
  const emptyCtx = { effect: (fn) => fn(), get: () => undefined, inject: (keys, cb) => cb(emptyCtx) };
  assert.doesNotThrow(() => mod.apply(emptyCtx));

  // 2. with the service: exactly one tab (Progress), stable id and order
  const tabs = [];
  const service = { registerTab: (descriptor) => { tabs.push(descriptor); return () => {}; } };
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => (name === 'locale' ? { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      : name === 'betterSidebar' ? service : undefined),
    inject: (keys, cb) => cb(ctx),
  };
  mod.apply(ctx);
  assert.deepEqual(tabs.map((tab) => tab.id), ['session-rail:progress'], 'Changes and Sources are no longer registered');
  assert.deepEqual(tabs.map((tab) => tab.order), [90]);
  assert.deepEqual(tabs.map((tab) => tab.title()), ['进度']);
  for (const tab of tabs) {
    assert.equal(tab.single, true);
    assert.equal(typeof tab.component, 'function');
    assert.equal(typeof tab.badge, 'function');
    assert.equal(typeof tab.icon(16)?.props?.viewBox, 'string', `${tab.id} ships an icon`);
  }

  const baseProps = { ctx, store: {}, scope: { sessionId: 's1', cwd: '/repo' }, tab: {}, visible: true };

  // 3. progress: last record wins, relative time renders, badge counts running
  bodies['/api/session-rail/turn'] = { ok: true, live: true, running: true, turn: 3, elapsedMs: 90_000, toolCalls: 2, lastTool: 'bash',
    usage: { inputTokens: 100_000, outputTokens: 4_200, contextTokens: 190_000 }, contextWindow: 200_000, fillPercent: 95 };
  bodies['/api/session-rail/progress'] = {
    ok: true,
    tasks: [
      { task: 'build', state: 'running', pct: 42, msg: 'linking', at: Date.now() - 90_000 },
      { task: 'lint', state: 'done', pct: 100, msg: '', at: Date.now() - 7_200_000 },
    ],
  };
  let out = await mount(tabs[0].component, baseProps);
  assert.match(out.text, /build/);
  assert.match(out.text, /42%/);
  assert.match(out.text, /linking/);
  assert.match(out.text, /分钟前/);
  assert.match(out.text, /运行中/);
  assert.match(out.text, /第 3 轮/);
  assert.match(out.text, /1 分 30 秒/);
  assert.match(out.text, /2 次工具调用/);
  assert.match(out.text, /上下文/);
  assert.match(out.text, /95%/);
  assert.match(out.text, /190k/);
  assert.match(out.text, /200k/);
  assert.equal(tabs[0].badge(ctx, baseProps.scope, {}), 1);

  // 4. progress empty state names the reporter instead of showing a blank pane
  bodies['/api/session-rail/progress'] = { ok: true, dir: '/repo/.dsh-progress/s1', tasks: [] };
  states.delete(tabs[0].component);
  out = await mount(tabs[0].component, baseProps);
  assert.match(out.text, /还没有长任务上报进度/);
  assert.match(out.text, /dsh-progress run --task/);
  assert.equal(tabs[0].badge(ctx, baseProps.scope, {}), null);

  // 5. header counters: the read watermark decides what "unread" means
  const { internals } = mod;
  const headRows = [
    { id: 'a', at: 100, running: false },
    { id: 'b', at: 200, running: true },
    { id: 'c', at: 300, running: false },
  ];
  const baseline = internals.reconcileSeen(headRows, null, 'a', 1_000);
  // The module runs in a vm realm, so compare plain JSON, not prototypes.
  assert.equal(JSON.stringify(baseline.sessions), JSON.stringify({ a: 100, b: 200, c: 300 }), 'first run baselines every Session as read');
  assert.equal(JSON.stringify(baseline.live), JSON.stringify(['b']));
  let head = internals.readCounts(headRows, baseline, 'a');
  assert.equal(head.ready, true);
  assert.equal(head.running.length, 1);
  assert.equal(head.unread.length, 0);

  // b's turn ends while another Session (a) is on screen → b becomes unread
  const finished = headRows.map((row) => (row.id === 'b' ? { ...row, running: false, at: 400 } : row));
  const afterFinish = internals.reconcileSeen(finished, baseline, 'a', 1_000);
  assert.equal(afterFinish === baseline, false, 'a finished turn changes the store');
  head = internals.readCounts(finished, afterFinish, 'a');
  assert.equal(head.running.length, 0);
  assert.equal(JSON.stringify(head.unread.map((row) => row.id)), JSON.stringify(['b']));

  // opening b clears it, and the watermark never moves backwards
  const afterRead = internals.reconcileSeen(finished, afterFinish, 'b', 1_100);
  head = internals.readCounts(finished, afterRead, 'b');
  assert.equal(head.unread.length, 0);
  assert.equal(afterRead.finished.b, undefined);
  assert.equal(afterRead.sessions.b, 1_000, 'the watermark covers the finish that triggered it');
  assert.equal(internals.reconcileSeen(finished, afterRead, 'b', 1_200) === afterRead, true, 'no write when nothing changed');

  // subagent children and blank Sessions are not conversations of their own
  const listed = internals.readSessionRows({
    list: {
      getSnapshot: () => ({
        ids: ['root', 'child', 'blank'],
        byId: {
          root: { id: 'root', displayTitle: '主会话', updatedAt: 10, running: true },
          child: { id: 'child', displayTitle: '子代理', updatedAt: 11, running: true, origin: 'subagent' },
          blank: { id: 'blank', displayTitle: '新会话', updatedAt: 12, running: false, blank: true },
        },
      }),
    },
  });
  assert.equal(JSON.stringify(listed.rows.map((row) => row.id)), JSON.stringify(['root']));
  assert.equal(internals.HEADER_TEXT.en.unread, 'unread');

  // 6. header chip renders from the session store: idle degrades to one faint dot
  const makeCtx = (rows) => ({
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) }), subscribe: () => () => {} } }
      : undefined),
  });
  const idleRows = [{ id: 'only', displayTitle: '只有一个', updatedAt: 500, running: false }];
  localStore.clear();
  states.delete(internals.HeaderCounts);
  // The stub runs effects once per mount, so the second pass is the commit
  // React would make after the store subscription delivered its rows.
  await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(idleRows), currentId: 'only' } });
  let chip = await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(idleRows), currentId: 'only' } });
  assert.equal(chip.text, '', 'an idle chip shows a dot, not a number');
  assert.match(JSON.stringify(chip.nodes.find((node) => node.props && node.props['aria-label'])?.props || {}), /没有进行中/);

  // A turn that ends while another Session is on screen becomes unread: the
  // first pass baselines both Sessions as running, the second drops one.
  states.delete(internals.HeaderCounts);
  localStore.clear();
  const runningRows = [
    { id: 'mine', displayTitle: '当前会话', updatedAt: 900, running: true },
    { id: 'other', displayTitle: '别的会话', updatedAt: 800, running: true },
  ];
  await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(runningRows), currentId: 'mine' } });
  await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(runningRows), currentId: 'mine' } });
  let busy = await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(runningRows), currentId: 'mine' } });
  assert.match(busy.text, /2/, 'both live Sessions are counted');
  assert.doesNotMatch(busy.text, /未读/);

  const finishedRows = [
    { id: 'mine', displayTitle: '当前会话', updatedAt: 900, running: true },
    { id: 'other', displayTitle: '别的会话', updatedAt: 950, running: false },
  ];
  await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(finishedRows), currentId: 'mine' } });
  busy = await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(finishedRows), currentId: 'mine' } });
  assert.match(busy.text, /运行/);
  assert.match(busy.text, /未读/, 'the Session that finished off screen is unread');

  // 7. how a turn ended decides the colour: done / stopped / failed are separate
  const toneRows = [
    { id: 'done', at: 100, running: false },
    { id: 'stopped', at: 200, running: false },
    { id: 'failed', at: 300, running: false },
    { id: 'live', at: 400, running: true },
  ];
  // A watermark below every row: all three finished Sessions are unread.
  const toneStore = { v: 1, sessions: { done: 0, stopped: 0, failed: 0, live: 0 }, finished: {}, live: [] };
  const tones = internals.readCounts(toneRows, toneStore, '', {
    done: { state: 'done' },
    stopped: { state: 'interrupted' },
    failed: { state: 'error' },
    live: { state: 'running' },
  });
  assert.equal(JSON.stringify(tones.running.map((row) => row.id)), JSON.stringify(['live']));
  assert.equal(JSON.stringify(tones.unread.map((row) => row.id)), JSON.stringify(['done']));
  assert.equal(JSON.stringify(tones.interrupted.map((row) => row.id)), JSON.stringify(['stopped']));
  assert.equal(JSON.stringify(tones.error.map((row) => row.id)), JSON.stringify(['failed']));

  // No verdict from the host degrades to plain "unread", never to a wrong colour.
  const silent = internals.readCounts(toneRows, toneStore, '', undefined);
  assert.equal(silent.interrupted.length + silent.error.length, 0);
  assert.equal(silent.unread.length, 3);
  assert.equal(internals.HEADER_TEXT.zh.error, '出错');
  assert.equal(internals.HEADER_TEXT.zh.interrupted, '中断');

  // 8. a live turn parked on a question is 询问, not 运行 (waiting is not working)
  const questionRows = [
    { id: 'busy', at: 500, running: true },
    { id: 'asking', at: 600, running: true },
  ];
  const asked = internals.readCounts(questionRows, toneStore, '', {
    busy: { state: 'running' },
    asking: { state: 'question' },
  });
  assert.equal(JSON.stringify(asked.question.map((row) => row.id)), JSON.stringify(['asking']));
  assert.equal(JSON.stringify(asked.running.map((row) => row.id)), JSON.stringify(['busy']));
  assert.equal(internals.HEADER_TEXT.zh.question, '询问');
  assert.equal(internals.HEADER_TEXT.zh.panelQuestion, '等你回答的');

  // 9. the chip is a real button: no native title tooltip fighting the panel,
  //    and clicking pins rather than navigating away.
  states.delete(internals.HeaderCounts);
  localStore.clear();
  const pinRows = [{ id: 'mine', displayTitle: '当前会话', updatedAt: 900, running: false }];
  await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(pinRows), currentId: 'mine' } });
  const pinned = await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(pinRows), currentId: 'mine' } });
  const chipNode = pinned.nodes.find((node) => node.props && node.props.className === 'sr-hdr-chip');
  assert.ok(chipNode, 'the chip renders as a button');
  assert.equal(chipNode.props.title, undefined, 'no native title tooltip over the custom panel');
  assert.equal(typeof chipNode.props.onClick, 'function');
  const wrapNode = pinned.nodes.find((node) => node.props && node.props.className === 'sr-hdr-wrap');
  assert.ok(wrapNode, 'the wrap carries the class the outside-click handler looks up');
  assert.equal(wrapNode.props.style.position, 'relative');

  // 10. workspace rollup: membership from the registry, question is not "running"
  const wsRows = [
    { id: 'a', at: 1, running: true },
    { id: 'b', at: 2, running: true },
    { id: 'c', at: 3, running: false },
  ];
  const wsList = [
    { id: 'w1', title: '探索', sessionIds: ['a', 'b', 'c'] },
    { id: 'w2', title: '空目录', sessionIds: [] },
  ];
  let rollup = internals.rollupByWorkspace(wsRows, wsList, { b: { state: 'question' } });
  assert.equal(rollup.length, 1, 'a Workspace with nothing running is not reported');
  assert.equal(rollup[0].id, 'w1');
  assert.equal(rollup[0].running, 1, 'the parked Session is not counted as running');
  assert.equal(rollup[0].question, 1);
  // A Session missing from the store (archived / not loaded) never inflates a count.
  rollup = internals.rollupByWorkspace([], [{ id: 'w1', title: '探索', sessionIds: ['ghost'] }], { ghost: { state: 'question' } });
  assert.equal(rollup[0].question, 1, 'a question verdict alone still counts: it needs the user');
  rollup = internals.rollupByWorkspace([], [{ id: 'w1', title: '探索', sessionIds: ['ghost'] }], { ghost: { state: 'running' } });
  assert.equal(rollup.length, 0, 'a running verdict without a store row does not invent a count');
  // The DOM painter is a no-op without a document; it must not throw.
  assert.equal(internals.paintWorkspaceBadges([{ id: 'w1', title: 'x', running: 2, question: 0 }], true), 0);

  // 11. 顶部「● N 询问」只跟 /turns 的 state 走：答完之后同一会话回到「运行」，
  //     橙色那段整段消失（count 为 0 时它的 span 根本不渲染）。
  const liveRow = [{ id: 's1', displayTitle: '在跑的会话', updatedAt: 1_000, running: true }];
  const mountHeader = async (state) => {
    bodies['/api/session-rail/turns'] = {
      ok: true,
      turns: { s1: { state, kind: state === 'question' ? 'ask_user_question' : null, turn: 2 } },
    };
    states.delete(internals.HeaderCounts);
    localStore.clear();
    await mount(internals.HeaderCounts, { rail: { ctx: makeCtx(liveRow), currentId: 'elsewhere' } });
    return mount(internals.HeaderCounts, { rail: { ctx: makeCtx(liveRow), currentId: 'elsewhere' } });
  };
  const parkedChip = await mountHeader('question');
  assert.match(parkedChip.text, /询问/, 'a turn parked on a question is counted');
  assert.doesNotMatch(parkedChip.text, /运行/, 'and is not counted as running at the same time');
  const answeredChip = await mountHeader('running');
  assert.doesNotMatch(answeredChip.text, /询问/, 'answered: the segment is gone from the header');
  assert.match(answeredChip.text, /运行/, 'the same Session counts as running again');

  // 12. 左栏「● N」徽标同源：同一个 verdict 决定它是橙色「等你回答」还是蓝色「在跑」，
  //     两者都没有时把已有徽标从 DOM 里摘掉（替身 document，不需要真浏览器）。
  const paintCase = (outcomes, running = true) => {
    const node = {
      removed: false,
      innerHTML: '',
      attributes: {},
      style: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      remove() { this.removed = true; },
    };
    sandbox.document = {
      querySelectorAll: () => [{ getAttribute: () => 'workspace:w1', querySelector: () => node }],
      createElement: () => node,
    };
    const rollup = internals.rollupByWorkspace(
      [{ id: 's1', running }],
      [{ id: 'w1', title: '探索', sessionIds: ['s1'] }],
      outcomes,
    );
    const painted = internals.paintWorkspaceBadges(rollup, true);
    return { node, painted, rollup };
  };
  const askBadge = paintCase({ s1: { state: 'question' } });
  assert.equal(askBadge.painted, 1, 'a parked Session keeps a badge');
  assert.match(askBadge.node.attributes.title, /等你回答/, 'amber badge says it is waiting on you');
  assert.match(askBadge.node.innerHTML, /f59e0b/, 'and it paints in the warning tone');
  const liveBadge = paintCase({ s1: { state: 'running' } });
  assert.equal(liveBadge.painted, 1, 'answered: the badge stays, because the Session is working');
  assert.doesNotMatch(liveBadge.node.attributes.title, /等你回答/, 'the waiting wording is gone');
  assert.match(liveBadge.node.innerHTML, /4176e6/, 'repainted in the running tone');
  const idleBadge = paintCase({ s1: { state: 'done' } }, false);
  assert.equal(idleBadge.painted, 0, 'nothing running and nothing waiting: no badge is drawn');
  assert.equal(idleBadge.node.removed, true, 'the badge left over on the row is removed from the DOM');

  // 13. 官方交互状态优先于日志 verdict：宿主 /turns 还停在 question（旧判定），
  //     但 `uiSession.sessionStatus` 已经没有 pendingInteraction 时，顶部条与
  //     左栏都必须按“在跑”算 —— 这就是“答完了还挂着询问”的那个症状。
  const makeCtxWithPending = (rows, pendingIds) => ({
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) }), subscribe: () => () => {} } }
      : name === 'uiSession'
        ? {
            sessionStatus: {
              getSnapshot: () => new Map(pendingIds.map((id) => [id, { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }])),
              subscribe: () => () => {},
            },
          }
        : undefined),
  });
  const staleRow = [{ id: 's1', displayTitle: '答完还在跑', updatedAt: 2_000, running: true }];
  bodies['/api/session-rail/turns'] = { ok: true, turns: { s1: { state: 'question', kind: 'ask_user_question', turn: 2 } } };

  states.delete(internals.HeaderCounts);
  localStore.clear();
  const clearedCtx = makeCtxWithPending(staleRow, []);
  const clearedPending = internals.readPendingInteractions(clearedCtx);
  assert.equal(clearedPending.size, 0, 'the live store reports nobody waiting');
  await mount(internals.HeaderCounts, { rail: { ctx: clearedCtx, currentId: 'elsewhere' } });
  const clearedChip = await mount(internals.HeaderCounts, { rail: { ctx: clearedCtx, currentId: 'elsewhere' } });
  assert.doesNotMatch(clearedChip.text, /询问/, 'a stale verdict cannot pin 询问 once the question is answered');
  assert.match(clearedChip.text, /运行/, 'the Session counts as running again');

  states.delete(internals.HeaderCounts);
  localStore.clear();
  const waitingCtx = makeCtxWithPending(staleRow, ['s1']);
  await mount(internals.HeaderCounts, { rail: { ctx: waitingCtx, currentId: 'elsewhere' } });
  const waitingChip = await mount(internals.HeaderCounts, { rail: { ctx: waitingCtx, currentId: 'elsewhere' } });
  assert.match(waitingChip.text, /询问/, 'a real pending interaction still shows 询问');
  assert.doesNotMatch(waitingChip.text, /运行/, 'and is not counted as running');

  // 左栏徽标同一套优先级，服务缺失时退回 verdict
  const wsOne = [{ id: 'w1', title: '探索', sessionIds: ['s1'] }];
  const staleVerdict = { s1: { state: 'question' } };
  const cleared = internals.rollupByWorkspace(staleRow, wsOne, staleVerdict, new Set());
  assert.equal(cleared[0].question, 0, 'no amber badge once the live store cleared');
  assert.equal(cleared[0].running, 1, 'the badge turns blue instead');
  assert.equal(internals.rollupByWorkspace(staleRow, wsOne, staleVerdict, new Set(['s1']))[0].question, 1);
  assert.equal(internals.rollupByWorkspace(staleRow, wsOne, staleVerdict)[0].question, 1, 'no uiSession: verdict is the fallback');

  // 既不在跑也不在等：已有的徽标被摘掉
  const idleNode = { removed: false, innerHTML: '', attributes: {}, style: {}, setAttribute(n, v) { this.attributes[n] = v; }, remove() { this.removed = true; } };
  sandbox.document = {
    querySelectorAll: () => [{ getAttribute: () => 'workspace:w1', querySelector: () => idleNode }],
    createElement: () => idleNode,
  };
  const idleRollup = internals.rollupByWorkspace([{ id: 's1', running: false }], wsOne, { s1: { state: 'done' } }, new Set());
  assert.equal(idleRollup.length, 0, 'nothing running and nobody waiting: no entry at all');
  assert.equal(internals.paintWorkspaceBadges(idleRollup, true), 0);
  assert.equal(idleNode.removed, true, 'the leftover badge is removed from the DOM');

  // ctx.get 对未注入的服务是 strict 的；reflect 读法必须也能拿到同一份状态。
  const reflectCtx = {
    get: () => undefined,
    reflect: { get: (name, strict) => (name === 'uiSession' && strict === false
      ? { sessionStatus: { getSnapshot: () => new Map([['s1', { pendingInteraction: { kind: 'question' } }]]), subscribe: () => () => {} } }
      : undefined) },
  };
  const viaReflect = internals.readPendingInteractions(reflectCtx);
  assert.equal(viaReflect.has('s1'), true, 'the non-strict service read still finds the live store');

  // 14. 忽略：默认放过已完成的定时任务，显式忽略连运行中的也不算
  const seenStore = { v: 1, sessions: {}, finished: {}, live: [] };
  const auto = (id, running = false) => ({ id, at: 5_000, running, title: id });
  const autoId = `${internals.AUTOMATION_PREFIX}run-1`;
  const manualId = 'session-manual';
  const rowsMix = [auto(autoId), auto(manualId), auto(`${internals.AUTOMATION_PREFIX}boom`)];
  const verdicts = {
    [autoId]: { state: 'done' },
    [manualId]: { state: 'done' },
    [`${internals.AUTOMATION_PREFIX}boom`]: { state: 'error' },
  };
  let mix = internals.readCounts(rowsMix, seenStore, '', verdicts, null);
  assert.equal(JSON.stringify(mix.unread.map((row) => row.id)), JSON.stringify([manualId]), 'a finished scheduled run is not unread; a manual Session still is');
  assert.equal(JSON.stringify(mix.error.map((row) => row.id)), JSON.stringify([`${internals.AUTOMATION_PREFIX}boom`]), 'a failed scheduled run still counts as an error');
  const stoppedId = `${internals.AUTOMATION_PREFIX}stopped`;
  mix = internals.readCounts([auto(stoppedId)], seenStore, '', { [stoppedId]: { state: 'interrupted' } }, null);
  assert.equal(JSON.stringify(mix.interrupted.map((row) => row.id)), JSON.stringify([stoppedId]), 'a stopped scheduled run still counts as interrupted');
  mix = internals.readCounts([auto(autoId, true)], seenStore, '', { [autoId]: { state: 'running' } }, null);
  assert.equal(JSON.stringify(mix.running.map((row) => row.id)), JSON.stringify([autoId]), 'a scheduled run still running is still counted as running');
  assert.equal(internals.isQuietAutomationRun(manualId, 'done'), false, 'the default rule is only for scheduled runs');
  assert.equal(internals.isQuietAutomationRun(autoId, 'error'), false, 'a failed run is never quiet');

  // 显式忽略：所有分桶都不再算它，包括运行中的那一桶
  const ignored = new Set([manualId, autoId]);
  let ignoredCounts = internals.readCounts(rowsMix, seenStore, '', verdicts, null, ignored);
  assert.equal(ignoredCounts.unread.length, 0, 'an ignored finished Session leaves the unread bucket');
  ignoredCounts = internals.readCounts([auto(autoId, true)], seenStore, '', {}, null, ignored);
  assert.equal(ignoredCounts.running.length, 0, 'an ignored running Session leaves the running bucket too');
  const wsIgnored = internals.rollupByWorkspace([auto(autoId, true)], [{ id: 'w1', title: '探索', sessionIds: [autoId] }], {}, null, ignored);
  assert.equal(wsIgnored.length, 0, 'and it stops painting a workspace badge');
  assert.equal(
    internals.rollupByWorkspace([auto(autoId, true)], [{ id: 'w1', title: '探索', sessionIds: [autoId] }], {}, null, new Set())[0].running,
    1,
    'without the ignore set the badge is unchanged',
  );

  // 清单：写入 → 订阅回调 → 读出 → 清空
  localStore.delete(internals.IGNORE_KEY);
  let notified = 0;
  const stop = internals.subscribeIgnore(() => { notified += 1; });
  assert.equal(internals.readIgnoreStore().sessions.length, 0, 'no key means an empty list');
  internals.ignoreSession(manualId);
  internals.ignoreSession(manualId);
  assert.equal(notified, 1, 'the second write is a no-op: no duplicate id, no second notify');
  assert.equal(JSON.stringify(internals.readIgnoreStore().sessions), JSON.stringify([manualId]), 'one id, written once');
  internals.ignoreSession(autoId);
  assert.equal(internals.readIgnoreStore().sessions.length, 2);
  internals.clearIgnoredSessions();
  assert.equal(internals.readIgnoreStore().sessions.length, 0, 'clear empties the list');
  stop();
  localStore.set(internals.IGNORE_KEY, 'not json');
  assert.equal(internals.readIgnoreStore().sessions.length, 0, 'a corrupt key degrades to empty instead of throwing');

  // 设置区那一行：有 N 条时带“清空”，0 条时没有按钮
  const renderOnce = (component, props) => {
    collected = [];
    return { text: render(React.createElement(component, props)), nodes: collected };
  };
  localStore.set(internals.IGNORE_KEY, JSON.stringify({ v: 1, sessions: ['a', 'b'] }));
  const setWith = await mount(internals.SettingsSection, {});
  assert.match(setWith.text, /已忽略 2 条/, 'the settings row reports the count');
  assert.match(setWith.text, /清空/, 'and offers the way back');
  localStore.set(internals.IGNORE_KEY, JSON.stringify({ v: 1, sessions: [] }));
  states.delete(internals.SettingsSection);
  const setEmpty = await mount(internals.SettingsSection, {});
  assert.match(setEmpty.text, /已忽略 0 条/);
  assert.doesNotMatch(setEmpty.text, /清空/, 'nothing to clear: no button');

  // 注册：settings.section 拿到的是这一行，且槽位契约是 list 的 id/order/label
  const registered = [];
  const slotsStub = {
    inject: (name, cb) => cb(),
    register: (entry, component) => { registered.push({ entry, component }); return () => {}; },
  };
  const settingsCtx = {
    effect: (fn) => fn(),
    get: (name) => (name === 'slots' ? slotsStub : undefined),
    inject: (keys, cb) => cb(settingsCtx),
  };
  mod.apply(settingsCtx);
  const settingsEntry = registered.find((item) => item.entry.name === 'settings.section');
  assert.ok(settingsEntry, 'the settings section is registered when the slot exists');
  assert.equal(settingsEntry.entry.id, 'session-rail:ignored');
  assert.equal(typeof settingsEntry.entry.order, 'number');
  assert.equal(settingsEntry.component, internals.SettingsSection);
  assert.equal(typeof settingsEntry.entry.label(), 'string');

  // 浮层每行都有“忽略”动作（按钮存在于此，点击行为即上面测过的 ignoreSession）
  const sourceText = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.equal((sourceText.match(/className: 'sr-hdr-ignore'/g) || []).length, 1, 'one ignore button class in the row renderer');
  assert.equal((sourceText.match(/ignoreSession\(row\.id\)/g) || []).length, 1, 'and one place that writes the id');

  console.log('client tabs: 14/14 groups passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
