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
  const { id, mod } = loadModule();
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

  console.log('client tabs: 10/10 groups passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
