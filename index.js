/**
 * Session Rail — host half.
 *
 * One prefix route, three read-only endpoints used by the client tabs:
 *   GET /api/session-rail/changes?cwd=<path>       git status of the repo containing cwd
 *   GET /api/session-rail/progress?cwd=&sessionId= .dsh-progress JSONL tasks of one session
 *   GET /api/session-rail/sources?cwd=             gh auth state + connected MCP servers
 *
 * Nothing here writes to the workspace, the repo, or the session log: every
 * endpoint only reads (git plumbing, a progress directory, `gh auth status`).
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const ROUTE_PREFIX = '/api/session-rail';
/** Upper bound on files listed per response, so one dirty monorepo cannot flood the panel. */
const MAX_FILES = 60;
/** The progress protocol caps one directory at 64 task files. */
const MAX_PROGRESS_FILES = 64;
const MAX_PROGRESS_BYTES = 512 * 1024;
export const PLUGIN_ID = 'dsh-session-rail';
const PLUGIN_VERSION = '0.1.10';
/** How many appended session events one turn scan reads back from the tail. */
const TURN_SCAN_EVENTS = 400;

/**
 * Bounded, in-memory record of the client half's boot reports. The Web page
 * cannot be inspected from the Host, so the client half announces itself here:
 * that is the only way to tell "the module never loaded" apart from "it loaded
 * and registered nothing".
 */
const clientReports = [];
const MAX_CLIENT_REPORTS = 20;

function run(command, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: error && typeof error.code === 'number' ? error.code : 0,
        });
      },
    );
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function gitRoot(cwd) {
  if (!cwd) return null;
  const r = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** `git diff --numstat` → { path: { added, deleted } }; binary rows ("-") count as 0/0. */
function parseNumstat(text) {
  const counts = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    const toNumber = (value) => (value === '-' ? 0 : Number.parseInt(value, 10) || 0);
    const entry = counts[path] ?? { added: 0, deleted: 0 };
    entry.added += toNumber(added);
    entry.deleted += toNumber(deleted);
    counts[path] = entry;
  }
  return counts;
}

/** `git status --porcelain=v1 -z` → staged / unstaged / untracked buckets plus the file list. */
async function readChanges(cwd) {
  // Never fall back to the Host process directory: a rail that silently reports
  // the wrong repo's changes is worse than one that says it does not know yet.
  if (!cwd) return { ok: false, reason: 'no-working-directory' };
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, reason: 'not-a-git-repo', cwd };

  const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
  if (!status.ok) return { ok: false, reason: status.stderr.trim() || 'git status failed', root };

  const parts = status.stdout.split('\0');
  const files = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    // A rename/copy entry is followed by its original path in the same -z stream.
    if (x === 'R' || x === 'C') i += 1;
    if (x === '?' && y === '?') untracked += 1;
    else {
      if (x !== ' ') staged += 1;
      if (y !== ' ') unstaged += 1;
    }
    if (files.length < MAX_FILES) files.push({ path: file, index: x, worktree: y });
  }

  // Staged first, then modified, then untracked; stable by path inside a bucket,
  // so the list does not reshuffle between polls while git reports new files.
  const bucket = (file) => (file.index === '?' ? 2 : file.index !== ' ' ? 0 : 1);
  files.sort((a, b) => bucket(a) - bucket(b) || a.path.localeCompare(b.path));

  // Line counts: the working-tree side plus the staged side. Cheap enough for
  // the 8s poll and it is what "+12 -3" in the panel is made of.
  const [unstagedNumstat, stagedNumstat] = await Promise.all([
    run('git', ['diff', '--numstat'], root),
    run('git', ['diff', '--cached', '--numstat'], root),
  ]);
  const unstagedCounts = parseNumstat(unstagedNumstat.stdout);
  const stagedCounts = parseNumstat(stagedNumstat.stdout);
  // Totals cover every changed path (not just the first MAX_FILES rows); a file
  // that is both staged and unstaged contributes both hunks, which is correct.
  let added = 0;
  let deleted = 0;
  for (const counts of [unstagedCounts, stagedCounts]) {
    for (const entry of Object.values(counts)) {
      added += entry.added;
      deleted += entry.deleted;
    }
  }
  for (const file of files) {
    for (const counts of [unstagedCounts, stagedCounts]) {
      const entry = counts[file.path];
      if (!entry) continue;
      file.added = (file.added ?? 0) + entry.added;
      file.deleted = (file.deleted ?? 0) + entry.deleted;
    }
  }

  const branchRun = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = branchRun.ok ? branchRun.stdout.trim() : null;
  const counts = await run('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], root);
  let ahead = null;
  let behind = null;
  if (counts.ok) {
    const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      behind = a;
      ahead = b;
    }
  }

  return {
    ok: true,
    root,
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    total: staged + unstaged + untracked,
    added,
    deleted,
    files,
    truncated: staged + unstaged + untracked > files.length,
  };
}

/** Last well-formed JSON object of one append-only JSONL progress file. */
async function readProgressFile(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const length = Math.min(stat.size, MAX_PROGRESS_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        return JSON.parse(line);
      } catch {
        // A half-written trailing line is normal for append-only producers.
      }
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readProgress(cwd, sessionId) {
  if (!cwd) return { ok: false, reason: 'no-working-directory' };
  const dir = sessionId
    ? path.join(cwd, '.dsh-progress', sessionId)
    : path.join(cwd, '.dsh-progress');
  const names = await fsp.readdir(dir).catch(() => null);
  if (!names) return { ok: true, dir, tasks: [], empty: true };

  const files = names.filter((name) => name.endsWith('.jsonl')).slice(0, MAX_PROGRESS_FILES);
  const tasks = [];
  await Promise.all(
    files.map(async (name) => {
      const record = await readProgressFile(path.join(dir, name));
      if (!record || typeof record !== 'object') return;
      const id = String(record.task ?? name.replace(/\.jsonl$/, ''));
      tasks.push({
        task: id,
        state: typeof record.state === 'string' ? record.state : 'running',
        pct: Number.isFinite(record.pct) ? record.pct : null,
        msg: typeof record.msg === 'string' ? record.msg : '',
        // Producers write either epoch millis or an ISO string; keep both.
        at: typeof record.at === 'number' || typeof record.at === 'string' ? record.at : null,
      });
    }),
  );
  const sortKey = (task) =>
    typeof task.at === 'number' ? task.at : Number.parseInt(Date.parse(String(task.at ?? '')) || '0', 10);
  tasks.sort((a, b) => sortKey(b) - sortKey(a));
  return { ok: true, dir, tasks, empty: tasks.length === 0 };
}

/**
 * The current turn of one live session, read from its own event log: the rail
 * shows "running · 4m34s" even when nothing writes .dsh-progress files.
 */
function readTurn(ctx, sessionId) {
  if (!sessionId) return { ok: false, reason: 'no-session' };
  let session;
  try {
    session = ctx.get('sessions')?.get?.(sessionId);
  } catch {
    session = undefined;
  }
  if (!session) return { ok: true, live: false, running: false, usage: null, contextWindow: null, fillPercent: null };

  const lastSeq = Number(session.seq ?? 0);
  const from = Math.max(0, lastSeq - TURN_SCAN_EVENTS);
  let events = [];
  try {
    events = session.snapshotEvents(from, lastSeq + 1) ?? [];
  } catch {
    return { ok: true, live: true, running: false, reason: 'log-unreadable' };
  }

  let start = null;
  let end = null;
  let toolCalls = 0;
  let lastTool = null;
  let lastEvent = null;
  for (const event of events) {
    lastEvent = event;
    if (event?.type === 'turn/start') {
      start = event;
      end = null;
      toolCalls = 0;
      lastTool = null;
    } else if (event?.type === 'turn/end') {
      end = event;
    } else if (start && event?.type === 'tool/call') {
      toolCalls += 1;
      lastTool = event.data?.name ?? null;
    }
  }

  // Context occupancy: the newest assistant usage in the scanned window against
  // the window the session itself reports. Absent numbers stay absent.
  let usage = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'assistant/message' && event.data?.usage) {
      usage = event.data.usage;
      break;
    }
  }
  let contextWindow = null;
  try {
    contextWindow = session.requestContext()?.contextWindow ?? null;
  } catch {
    contextWindow = null;
  }
  // Provider usage splits the prompt: inputTokens is only the UNCACHED part, the
  // cached prefix arrives as cacheReadTokens/cacheWriteTokens. Occupancy is their
  // sum — using inputTokens alone reports ~0% on a long cached session.
  const contextTokens = usage
    ? (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
    : null;
  const fillPercent = contextTokens !== null && contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : null;

  const running = Boolean(start) && (!end || Number(end.seq) < Number(start.seq));
  const startedAt = start?.time ?? null;
  const elapsedMs = running
    ? Date.now() - startedAt
    : start && end ? Math.max(0, Number(end.time) - Number(startedAt)) : null;

  return {
    ok: true,
    live: true,
    running,
    turn: start?.data?.turn ?? null,
    startedAt,
    elapsedMs,
    toolCalls,
    lastTool,
    lastEventType: lastEvent?.type ?? null,
    lastEventAt: lastEvent?.time ?? null,
    seq: lastSeq,
    usage: usage
      ? {
          inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
          outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
          cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
          contextTokens,
        }
      : null,
    contextWindow,
    fillPercent,
  };
}

/**
 * Tone of a finished turn, keyed by the reason kinds the session log defines:
 * `completed` / `max-tokens` ran to an end, `aborted` / `interrupted` stopped
 * early, `blocked` / `error` broke. `forked` only exists in constructor seed
 * history, so it reads as finished rather than as a live outcome.
 */
const TURN_TONE = {
  completed: 'done',
  'max-tokens': 'done',
  aborted: 'interrupted',
  interrupted: 'interrupted',
  blocked: 'error',
  error: 'error',
  forked: 'done',
};

/** Upper bound on Sessions one /turns round may classify. */
const MAX_TURN_IDS = 24;

/** The tool that parks a turn until the user answers. */
const ASK_TOOL = 'ask_user_question';

/**
 * Last turn's outcome for one Session, read from the tail of its own log.
 *
 * `unknown` is a real answer: a Session that left memory cannot be judged, and
 * guessing "done" would paint a Session that is still working green.
 */
function readTurnState(ctx, sessionId) {
  let session;
  try {
    session = ctx.get('sessions')?.get?.(sessionId);
  } catch {
    session = undefined;
  }
  if (!session) return { state: 'unknown', kind: null };
  const lastSeq = Number(session.seq ?? 0);
  let events = [];
  try {
    events = session.snapshotEvents(Math.max(0, lastSeq - TURN_SCAN_EVENTS), lastSeq + 1) ?? [];
  } catch {
    return { state: 'unknown', kind: null };
  }
  let start = null;
  let end = null;
  for (const event of events) {
    if (event?.type === 'turn/start') {
      start = event;
      end = null;
    } else if (event?.type === 'turn/end') {
      end = event;
    }
  }
  if (!start) return { state: 'unknown', kind: null };
  if (!end || Number(end.seq) < Number(start.seq)) {
    // An open turn is not always working: ask_user_question parks it until the
    // user answers. Telling the two apart is what lets the header say "询问"
    // instead of claiming a Session is busy while it is actually waiting.
    let pendingCall = null;
    const answered = new Set();
    for (const event of events) {
      if (event?.type === 'tool/call' && event.data?.name === ASK_TOOL) {
        pendingCall = event.data?.callId ?? `seq:${event.seq}`;
      } else if (event?.type === 'tool/result') {
        const callId = event.data?.callId;
        if (callId !== undefined) answered.add(callId);
      }
    }
    const asking = pendingCall !== null && !answered.has(pendingCall);
    return {
      state: asking ? 'question' : 'running',
      kind: asking ? ASK_TOOL : null,
      turn: start.data?.turn ?? null,
    };
  }
  const kind = typeof end.data?.reason?.kind === 'string' ? end.data.reason.kind : null;
  return {
    state: TURN_TONE[kind] ?? 'done',
    kind,
    turn: start.data?.turn ?? null,
    at: end.time ?? null,
  };
}

/** `gh auth status` + the MCP namespaces the host currently exposes to tools. *//**
 * A cwd that no longer exists makes `execFile` fail with ENOENT — the same code
 * a missing binary raises. Resolve a usable directory first so "gh is missing"
 * is only ever reported when gh really is missing.
 */
async function usableCwd(cwd) {
  if (!cwd) return process.cwd();
  try {
    const stat = await fsp.stat(cwd);
    return stat.isDirectory() ? cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

async function readSources(ctx, cwd) {
  const commandCwd = await usableCwd(cwd);
  const gh = await run('gh', ['auth', 'status'], commandCwd, 6000);
  let github = { available: false, account: null, host: null, detail: '' };
  if (gh.ok) {
    const account = /account (\S+)/.exec(gh.stdout) || /as (\S+)/.exec(gh.stdout);
    const host = /Logged in to (\S+)/.exec(gh.stdout);
    github = {
      available: true,
      account: account ? account[1] : null,
      host: host ? host[1] : 'github.com',
      detail: '',
    };
  } else {
    const text = `${gh.stdout}\n${gh.stderr}`.trim();
    github = {
      available: false,
      account: null,
      host: null,
      detail: gh.code === 'ENOENT' ? 'gh CLI not found' : text.split('\n')[0] || 'not authenticated',
    };
  }

  let mcp = [];
  const mcpTools = {};
  try {
    const tools = ctx.get('tools');
    const schemas = typeof tools?.schemas === 'function' ? tools.schemas() : [];
    const names = schemas
      .map((schema) => String(schema?.name ?? ''))
      .filter((name) => name.startsWith('mcp__'));
    for (const name of names) {
      const server = name.split('__')[1];
      if (!server) continue;
      mcpTools[server] = (mcpTools[server] ?? 0) + 1;
    }
    mcp = Object.keys(mcpTools).sort();
  } catch {
    mcp = [];
  }

  // The repo this directory really pushes to — the useful half of "来源".
  let remote = null;
  if (cwd) {
    const origin = await run('git', ['remote', 'get-url', 'origin'], commandCwd, 4000);
    if (origin.ok) remote = origin.stdout.trim() || null;
  }

  return { ok: true, github, mcp, mcpTools, remote, cwd: cwd || null };
}

/** Same-origin guard: a browser page on another site must not read this route. */
function sameOriginOnly(req) {
  const host = req.headers?.host;
  if (!host) return false;
  for (const header of ['origin', 'referer']) {
    const value = req.headers[header];
    if (!value) continue;
    try {
      if (new URL(value).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether this plugin's client half is in the Host's boot graph. The Host owns
 * the answer (`clientModules.graph()`), so "the page never loaded it" and
 * "it was never scanned in" are distinguishable without a browser.
 */
function readClientGraph(ctx) {
  let service;
  try {
    service = ctx.get('clientModules');
  } catch {
    service = undefined;
  }
  if (!service || typeof service.graph !== 'function') {
    return { available: false, reason: 'client-modules-service-unavailable' };
  }
  try {
    const graph = service.graph();
    const folders = [];
    const ids = new Set();
    const collect = (value) => {
      for (const row of Array.isArray(value) ? value : []) {
        const id = typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.moduleId;
        if (typeof id === 'string') ids.add(id);
      }
    };
    for (const [key, value] of Object.entries(graph ?? {})) {
      if (Array.isArray(value)) {
        folders.push({ key, count: value.length });
        collect(value);
      } else if (value && typeof value === 'object') {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (Array.isArray(nestedValue)) {
            folders.push({ key: `${key}.${nestedKey}`, count: nestedValue.length });
            collect(nestedValue);
          }
        }
      }
    }
    const path = typeof service.clientPath === 'function' ? service.clientPath(PLUGIN_ID) : undefined;
    return {
      available: true,
      moduleCount: ids.size,
      folders,
      ours: ids.has(PLUGIN_ID),
      clientPath: path ?? null,
      device: (graph && typeof graph === 'object' ? Object.keys(graph) : []).slice(0, 12),
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function handleRequest(ctx, req, res) {
  if (!sameOriginOnly(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin-request-rejected' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  const cwd = url.searchParams.get('cwd') || undefined;
  const sessionId = url.searchParams.get('sessionId') || undefined;
  try {
    if (url.pathname === `${ROUTE_PREFIX}/changes`) {
      sendJson(res, 200, await readChanges(cwd));
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/progress`) {
      sendJson(res, 200, await readProgress(cwd ?? process.cwd(), sessionId));
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/turn`) {
      sendJson(res, 200, readTurn(ctx, sessionId));
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/workspaces`) {
      // The left rail's badges need the same membership the sidebar uses, so the
      // host answers with the registry's own projection: `sessionIds` is already
      // filtered by the canonical-cwd header index, which the client cannot
      // reproduce from `cwd` strings alone (symlinks, monorepos, moved folders).
      let workspaces = [];
      try {
        workspaces = ctx.get('workspaceRegistry')?.list?.() ?? [];
      } catch {
        workspaces = [];
      }
      sendJson(res, 200, {
        ok: true,
        workspaces: workspaces.map((workspace) => ({
          id: String(workspace.id),
          title: String(workspace.title ?? ''),
          path: String(workspace.path ?? ''),
          sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
        })),
      });
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/turns`) {
      // Batch form for the header counters: one round trip for every finished
      // Session the chip can colour, instead of one request per Session.
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, MAX_TURN_IDS);
      const turns = {};
      for (const id of ids) turns[id] = readTurnState(ctx, id);
      sendJson(res, 200, { ok: true, turns });
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/report`) {
      // The client half's boot beacon. It is a GET only because the payload is
      // four short fields; the side effect is one in-memory row, never state.
      clientReports.push({
        at: Date.now(),
        boot: url.searchParams.get('boot') || null,
        stage: url.searchParams.get('stage') || null,
        service: url.searchParams.get('service') === '1',
        tabs: (url.searchParams.get('tabs') || '').split(',').filter(Boolean).slice(0, 10),
      });
      while (clientReports.length > MAX_CLIENT_REPORTS) clientReports.shift();
      sendJson(res, 200, { ok: true, accepted: true });
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/state`) {
      sendJson(res, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        clientReports,
        clientGraph: readClientGraph(ctx),
      });
      return;
    }
    if (url.pathname === `${ROUTE_PREFIX}/sources`) {
      sendJson(res, 200, await readSources(ctx, cwd));
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handleRequest(ctx, req, res),
    }),
  );
}
