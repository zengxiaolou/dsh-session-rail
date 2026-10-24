/**
 * Host-route regression test. Hermetic: builds its own throwaway git repo and
 * progress directory under the OS temp dir, so it needs no network and no
 * access to the user's real workspaces.
 *
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { apply, PLUGIN_ID } = await import('../index.js');

// A live session stub: turn 3 started 90s ago, two tool calls, no closer yet.
const now = Date.now();
const liveEvents = [
  { type: 'turn/start', seq: 1, time: now - 90_000, data: { turn: 3 } },
  { type: 'tool/call', seq: 2, time: now - 80_000, data: { name: 'bash' } },
  { type: 'assistant/message', seq: 3, time: now - 75_000, data: { usage: { inputTokens: 100_000, outputTokens: 4_200, cacheReadTokens: 90_000 } } },
  { type: 'tool/call', seq: 4, time: now - 70_000, data: { name: 'read' } },
];
const closedEvents = [
  ...liveEvents,
  { type: 'turn/end', seq: 5, time: now - 60_000, data: { turn: 3, reason: { kind: 'completed' } } },
];
const makeSession = (events) => ({
  seq: events[events.length - 1].seq,
  snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && e.seq < to),
  requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 200_000 }),
});
const sessionsService = {
  get: (id) => (id === 's-live' ? makeSession(liveEvents) : id === 's-closed' ? makeSession(closedEvents) : undefined),
};
const clientModulesService = {
  graph: () => ({ rev: 'r1', release: 'x', entries: [{ id: 'dsh-pr-panel' }, { id: 'dsh-session-rail' }], batches: [[]] }),
  clientPath: (id) => (id === 'dsh-session-rail' ? '/tmp/rail/client.js' : undefined),
};
const routes = [];
const ctx = {
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  effect: (fn) => fn(),
  get: (name) =>
    name === 'tools'
      ? { schemas: () => [{ name: 'mcp__alpha__one' }, { name: 'mcp__alpha__two' }, { name: 'bash' }] }
      : name === 'sessions' ? sessionsService
      : name === 'clientModules' ? clientModulesService
      : undefined,
};

apply(ctx);
assert.equal(routes.length, 1, 'exactly one route is registered');
assert.equal(routes[0].kind, 'prefix');
assert.equal(routes[0].path, '/api/session-rail');

function call(url, { method = 'GET', headers = { host: '127.0.0.1:60606' } } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    routes[0].handler({ url, method, headers }, res);
  });
}

const repo = mkdtempSync(path.join(tmpdir(), 'rail-test-'));
const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: repo, encoding: 'utf8' });

try {
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('commit', '-q', '-m', 'init');

  // 1. clean tree
  let res = await call(`/api/session-rail/changes?cwd=${encodeURIComponent(repo)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.branch, 'main');
  assert.equal(res.body.total, 0, 'clean tree reports zero changes');
  assert.equal(res.body.files.length, 0);
  assert.equal(res.body.added, 0);
  assert.equal(res.body.deleted, 0);

  // 2. modified + untracked, and the untracked bucket sorts last
  writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
  writeFileSync(path.join(repo, 'fresh.txt'), 'new\n');
  res = await call(`/api/session-rail/changes?cwd=${encodeURIComponent(repo)}`);
  assert.equal(res.body.unstaged, 1);
  assert.equal(res.body.untracked, 1);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.files.map((f) => f.path), ['tracked.txt', 'fresh.txt'], 'unstaged before untracked');
  assert.equal(res.body.added, 1, 'one inserted line');
  assert.equal(res.body.deleted, 1, 'one deleted line');
  assert.equal(res.body.files[0].added, 1);
  assert.equal(res.body.files[0].deleted, 1);

  // 3. no cwd is honest, not a guess at the host process directory
  res = await call('/api/session-rail/changes');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'no-working-directory');

  // 4. a directory that is not a repo says so
  const plain = mkdtempSync(path.join(tmpdir(), 'rail-plain-'));
  res = await call(`/api/session-rail/changes?cwd=${encodeURIComponent(plain)}`);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'not-a-git-repo');
  rmSync(plain, { recursive: true, force: true });

  // 5. progress: last line wins, counters and timestamps survive
  const progressDir = path.join(repo, '.dsh-progress', 'session-1');
  mkdirSync(progressDir, { recursive: true });
  writeFileSync(
    path.join(progressDir, 'build.jsonl'),
    `${JSON.stringify({ v: 1, task: 'build', state: 'running', pct: 10, msg: 'start' })}\n` +
      `${JSON.stringify({ v: 1, task: 'build', state: 'running', pct: 55, msg: 'linking', at: 1700000000000 })}\n`,
  );
  res = await call(`/api/session-rail/progress?cwd=${encodeURIComponent(repo)}&sessionId=session-1`);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tasks.length, 1);
  assert.equal(res.body.tasks[0].pct, 55);
  assert.equal(res.body.tasks[0].msg, 'linking');
  assert.equal(res.body.tasks[0].at, 1700000000000);

  // 6. unknown session id is empty, not an error
  res = await call(`/api/session-rail/progress?cwd=${encodeURIComponent(repo)}&sessionId=nope`);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tasks.length, 0);

  // 7. sources: MCP namespaces are grouped and counted, remote is reported
  res = await call(`/api/session-rail/sources?cwd=${encodeURIComponent(repo)}`);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.mcp, ['alpha']);
  assert.equal(res.body.mcpTools.alpha, 2, 'two tools on the alpha server');
  assert.ok('github' in res.body);
  assert.equal(res.body.remote, null, 'no origin configured yet');

  // 7b. a cwd that no longer exists must not be reported as a missing gh binary
  res = await call('/api/session-rail/sources?cwd=/definitely/not/here');
  assert.equal(res.body.ok, true);
  let ghInstalled = true;
  try {
    execFileSync('which', ['gh']);
  } catch {
    ghInstalled = false;
  }
  if (ghInstalled) {
    assert.notEqual(res.body.github.detail, 'gh CLI not found', 'stale cwd is not a missing binary');
  }

  // 8. transport guards
  res = await call('/api/session-rail/sources', { headers: { host: '127.0.0.1:60606', origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
  res = await call('/api/session-rail/sources', { headers: { host: '127.0.0.1:60606', referer: 'http://127.0.0.1:60606/' } });
  assert.equal(res.status, 200);
  res = await call('/api/session-rail/sources', { headers: {} });
  assert.equal(res.status, 403, 'a request with no Host header is refused');
  res = await call('/api/session-rail/sources', { method: 'POST' });
  assert.equal(res.status, 405);
  res = await call('/api/session-rail/unknown');
  assert.equal(res.status, 404);

  // 9. turn: running turn, its elapsed time and tool calls
  res = await call('/api/session-rail/turn?sessionId=s-live');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.live, true);
  assert.equal(res.body.running, true);
  assert.equal(res.body.turn, 3);
  assert.equal(res.body.toolCalls, 2);
  assert.equal(res.body.lastTool, 'read');
  assert.ok(res.body.elapsedMs >= 90_000 && res.body.elapsedMs < 120_000, `elapsed ${res.body.elapsedMs}`);
  assert.equal(res.body.contextWindow, 200_000);
  assert.equal(res.body.fillPercent, 95, 'input + cached prefix = 190k of a 200k window');
  assert.deepEqual(res.body.usage, { inputTokens: 100_000, outputTokens: 4_200, cacheReadTokens: 90_000, contextTokens: 190_000 });

  // 10. a closed turn is not reported as running
  res = await call('/api/session-rail/turn?sessionId=s-closed');
  assert.equal(res.body.running, false);
  assert.equal(res.body.elapsedMs, 30_000, 'closed turn lasts start->end, not start->now');

  // 11. unknown / missing session are honest, not fabricated
  res = await call('/api/session-rail/turn?sessionId=nope');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.live, false);
  assert.equal(res.body.usage, null, 'a non-live session still returns a stable shape');
  assert.equal(res.body.fillPercent, null);
  res = await call('/api/session-rail/turn');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'no-session');

  // 12. the client boot beacon is recorded and bounded
  await call('/api/session-rail/report?boot=b1&stage=registered&service=1&tabs=session-rail:progress,session-rail:changes');
  res = await call('/api/session-rail/state');
  assert.equal(res.body.ok, true);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(res.body.version, manifest.version, 'host reports the package version, not a stale constant');
  assert.equal(res.body.clientReports.length, 1);
  assert.deepEqual(res.body.clientReports[0].tabs, ['session-rail:progress', 'session-rail:changes']);
  assert.equal(res.body.clientReports[0].service, true);
  assert.equal(res.body.clientGraph.available, true);
  assert.equal(res.body.clientGraph.ours, true, 'boot graph lists our module');
  assert.equal(res.body.clientGraph.clientPath, '/tmp/rail/client.js');
  assert.equal(res.body.clientGraph.moduleCount, 2);

  // 13. the plugin id must stay the package name, or the boot graph lookup breaks
  assert.equal(manifest.name, PLUGIN_ID);

  console.log('host routes: 13/13 groups passed');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
