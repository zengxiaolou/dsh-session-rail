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

function loadModule() {
  let loaded;
  const sandbox = {
    window: {
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

  console.log('client tabs: 4/4 groups passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
