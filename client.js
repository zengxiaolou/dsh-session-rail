/**
 * Session Rail — client half.
 *
 * Registers the Progress tab on the Host's native right sidebar through
 * dsh-better-sidebar's registry (`ctx.betterSidebar.registerTab`), so they sit
 * in the same column and tab strip as the existing PR tab. The tab is a pure
 * reader of the host route defined in index.js; this half writes nothing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-rail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const API = '/api/session-rail';
    /** One id per page load, so repeated boots are distinguishable in /state. */
    const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    /**
     * Tell the Host that this half actually booted. The Web page cannot be
     * inspected from the Host, so without this beacon "never loaded" and
     * "loaded but registered nothing" look identical from /state.
     */
    function report(stage, extra) {
      try {
        const query = new URLSearchParams({ boot: BOOT_ID, stage });
        for (const [key, value] of Object.entries(extra || {})) query.set(key, String(value));
        fetch(`${API}/report?${query.toString()}`, { cache: 'no-store' }).catch(() => {});
      } catch {
        // A beacon that fails must never break the panel.
      }
    }

    /** How long to wait for dsh-better-sidebar before reporting the missing service. */
    const SERVICE_DIAGNOSTIC_MS = 8000;

    /** How often the header re-asks the host how finished Sessions ended. */
    const OUTCOME_POLL_MS = 15_000;

    /** One /turns round classifies at most this many Sessions (host caps it too). */
    const MAX_OUTCOME_IDS = 24;

    /** Latest locale, refreshed from the Client locale service; only affects our own labels. */
    let activeLocale = 'zh';
    const t = (zh, en) => (String(activeLocale).toLowerCase().startsWith('en') ? en : zh);

    /** Tab-strip badge cache: badge() runs on every strip render, so it must stay synchronous. */
    const badges = new Map();
    /** Badges are per session, so two open conversations never show each other's counts. */
    const badgeKey = (kind, scope) => `${kind}:${scope?.sessionId ?? ''}`;

    function readLocale(locale) {
      try {
        const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.();
        const active = snapshot?.active ?? snapshot?.locale ?? snapshot?.id;
        if (typeof active === 'string' && active) activeLocale = active;
      } catch {
        // A locale service that cannot answer keeps the previous value.
      }
    }

    function relativeTime(at) {
      if (at === null || at === undefined) return '';
      const ms = typeof at === 'number' ? at : Date.parse(String(at));
      if (!Number.isFinite(ms)) return '';
      const seconds = Math.floor((Date.now() - ms) / 1000);
      if (seconds < 5) return t('刚刚', 'just now');
      if (seconds < 60) return t(`${seconds} 秒前`, `${seconds}s ago`);
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t(`${minutes} 分钟前`, `${minutes}m ago`);
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t(`${hours} 小时前`, `${hours}h ago`);
      return t(`${Math.floor(hours / 24)} 天前`, `${Math.floor(hours / 24)}d ago`);
    }

    function formatTokens(value) {
      if (value === null || value === undefined) return '—';
      if (value < 1000) return String(value);
      if (value < 1000 * 1000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
      return `${(value / 1_000_000).toFixed(1)}M`;
    }

    function formatDuration(ms) {
      if (ms === null || ms === undefined) return '';
      const seconds = Math.max(0, Math.round(ms / 1000));
      if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`);
      const minutes = Math.floor(seconds / 60);
      const restSeconds = seconds % 60;
      if (minutes < 60) {
        return restSeconds ? t(`${minutes} 分 ${restSeconds} 秒`, `${minutes}m ${restSeconds}s`) : t(`${minutes} 分钟`, `${minutes}m`);
      }
      const hours = Math.floor(minutes / 60);
      return t(`${hours} 小时 ${minutes % 60} 分`, `${hours}h ${minutes % 60}m`);
    }

    async function getJson(pathname, params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      }
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const response = await fetch(`${API}${pathname}${suffix}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => null);
      // Transport failures throw; a 200 body carrying `ok: false` is a real
      // answer ("not a git repo", "no working directory") and the tab decides
      // how to say it. Throwing here would turn that answer into a blank pane.
      if (!response.ok) throw new Error(body?.error || body?.reason || `HTTP ${response.status}`);
      if (!body) throw new Error(t('响应为空', 'Empty response'));
      return body;
    }

    /**
     * One polling endpoint. `intervalMs` of 0 loads once; the timer only fires
     * while the tab is visible, so a parked tab costs nothing. `reload()` is the
     * manual refresh the card headers expose.
     */
    function useFeed(pathname, params, intervalMs, visible) {
      const key = JSON.stringify(params || {});
      const [tick, setTick] = useState(0);
      const [state, setState] = useState({ loading: true, data: null, error: null });
      useEffect(() => {
        let cancelled = false;
        let inFlight = false;
        const load = async () => {
          if (inFlight) return;
          inFlight = true;
          try {
            const data = await getJson(pathname, JSON.parse(key));
            if (!cancelled) setState({ loading: false, data, error: null });
          } catch (error) {
            if (!cancelled) {
              setState((prev) => ({
                loading: false,
                data: prev.data,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          } finally {
            inFlight = false;
          }
        };
        load();
        if (!intervalMs) return () => { cancelled = true; };
        const timer = setInterval(() => { if (visible) load(); }, intervalMs);
        return () => { cancelled = true; clearInterval(timer); };
      }, [key, intervalMs, visible, tick]);
      return { ...state, reload: () => setTick((value) => value + 1) };
    }

    const ui = {
      page: {
        height: '100%', overflowY: 'auto', boxSizing: 'border-box',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px',
        fontSize: '12px', lineHeight: 1.5, color: 'inherit',
      },
      card: {
        border: '1px solid rgba(128,128,128,.28)', borderRadius: '8px',
        padding: '10px', background: 'rgba(128,128,128,.06)',
        display: 'flex', flexDirection: 'column', gap: '8px',
      },
      cardHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        fontSize: '11px', letterSpacing: '.02em', textTransform: 'uppercase', opacity: 0.72,
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
      muted: { opacity: 0.68 },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        border: '1px solid rgba(128,128,128,.35)', borderRadius: '999px',
        padding: '1px 7px', fontSize: '11px', whiteSpace: 'nowrap',
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', borderRadius: '6px',
        padding: '2px 7px', fontSize: '11px',
        border: '1px solid rgba(128,128,128,.3)', background: 'rgba(128,128,128,.08)',
      },
      meter: { height: '4px', borderRadius: '999px', background: 'rgba(128,128,128,.25)', overflow: 'hidden' },
      meterFill: { height: '100%', borderRadius: '999px', background: '#4b8bf5' },
      ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      notice: {
        border: '1px dashed rgba(128,128,128,.35)', borderRadius: '8px',
        padding: '12px', fontSize: '11px', lineHeight: 1.6, opacity: 0.78,
      },
      ghostButton: {
        appearance: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.35)', borderRadius: '6px',
        padding: '1px 7px', fontSize: '11px', opacity: 0.8, font: 'inherit',
      },
      input: {
        boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: '11px',
        color: 'inherit', background: 'transparent', padding: '3px 7px',
        border: '1px solid rgba(128,128,128,.35)', borderRadius: '6px', outline: 'none',
      },
      styleText: `
        .sr-row { border-radius: 5px; }
        .sr-row[data-clickable="true"] { cursor: pointer; }
        .sr-row[data-clickable="true"]:hover { background: rgba(128,128,128,.16); }
        .sr-row[data-clickable="true"]:focus-visible { outline: 1px solid #4b8bf5; outline-offset: 1px; }
      `,
    };

    const STATE_TONE = {
      running: '#4b8bf5', done: '#3fae6a', succeeded: '#3fae6a', failed: '#e05a4f',
      error: '#e05a4f', cancelled: '#b08a2e', queued: '#8a8a8a', skipped: '#8a8a8a',
    };

    function Page({ children }) {
      return h('div', { style: ui.page }, h('style', null, ui.styleText), children);
    }

    function Notice({ children }) {
      return h('div', { style: ui.notice }, children);
    }

    function ErrorLine({ error, onRetry }) {
      if (!error) return null;
      return h('div', { style: { ...ui.notice, borderColor: 'rgba(224,90,79,.55)', opacity: 1 } },
        h('div', { style: ui.row },
          h('span', { style: { ...ui.ellipsis, flex: 1 } }, error),
          onRetry ? h('button', { type: 'button', style: ui.ghostButton, onClick: onRetry }, t('重试', 'Retry')) : null,
        ),
      );
    }

    function CardHead({ label, meta, onReload }) {
      return h('div', { style: ui.cardHead },
        h('span', null, label),
        h('div', { style: { ...ui.row, gap: '6px' } },
          meta === undefined || meta === null ? null : h('span', { style: { ...ui.pill, textTransform: 'none' } }, meta),
          onReload
            ? h('button', { type: 'button', style: ui.ghostButton, onClick: onReload, title: t('刷新', 'Refresh') }, '↻')
            : null,
        ),
      );
    }

    function ProgressTab({ scope, visible }) {
      const turn = useFeed('/turn', { sessionId: scope?.sessionId }, 4000, visible);
      const { loading, data, error, reload } = useFeed(
        '/progress',
        { cwd: scope?.cwd, sessionId: scope?.sessionId },
        3000,
        visible,
      );
      const tasks = data?.tasks ?? [];
      badges.set(badgeKey('progress', scope), tasks.filter((task) => task.state === 'running').length);

      const turnData = turn.data;
      const turnCard = h('div', { style: ui.card },
        h(CardHead, {
          label: t('本会话', 'This session'),
          meta: turnData?.running ? t('运行中', 'running') : t('空闲', 'idle'),
          onReload: turn.reload,
        }),
        turnData?.live === false
          ? h('div', { style: { ...ui.muted } }, t('会话未在运行（可能已归档）', 'Session is not live (maybe archived)'))
          : h('div', { style: { ...ui.row, gap: '10px', flexWrap: 'wrap' } },
              turnData?.running
                ? h('span', { style: { ...ui.pill, color: '#4b8bf5', borderColor: 'rgba(75,139,245,.55)' } }, t('运行中', 'running'))
                : h('span', { style: ui.pill }, t('空闲', 'idle')),
              turnData?.turn !== null && turnData?.turn !== undefined
                ? h('span', null, t(`第 ${turnData.turn} 轮`, `turn ${turnData.turn}`))
                : null,
              turnData?.elapsedMs !== null && turnData?.elapsedMs !== undefined
                ? h('span', { style: { ...ui.mono } },
                    (turnData.running ? '' : t('上次 ', 'last ')) + formatDuration(turnData.elapsedMs))
                : null,
              turnData?.toolCalls
                ? h('span', { style: { ...ui.muted } }, t(`${turnData.toolCalls} 次工具调用`, `${turnData.toolCalls} tool calls`))
                : null,
              turnData?.lastTool
                ? h('span', { style: { ...ui.mono, ...ui.muted } }, turnData.lastTool)
                : null,
            ),
        turnData?.fillPercent !== null && turnData?.fillPercent !== undefined
          ? h('div', { style: { ...ui.row, gap: '8px' } },
              h('span', { style: { ...ui.muted } }, t('上下文', 'context')),
              h('div', { style: { ...ui.meter, width: '72px', flex: 'none' } },
                h('div', {
                  style: {
                    ...ui.meterFill,
                    width: `${turnData.fillPercent}%`,
                    background: turnData.fillPercent >= 85 ? '#e05a4f' : turnData.fillPercent >= 65 ? '#b08a2e' : '#4b8bf5',
                  },
                }),
              ),
              h('span', { style: { ...ui.mono } }, `${turnData.fillPercent}%`),
              h('span', { style: { ...ui.muted, ...ui.mono }, title: t('已用上下文 / 窗口', 'used / window') },
                `${formatTokens(turnData.usage?.contextTokens)} / ${formatTokens(turnData.contextWindow)}`),
            )
          : null,
      );

      if (loading && !data) return h(Page, null, turnCard, h(Notice, null, t('正在读取进度…', 'Reading progress…')));
      if (!tasks.length) {
        return h(Page, null,
          turnCard,
          h(ErrorLine, { error, onRetry: reload }),
          h(Notice, null,
            h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('还没有长任务上报进度', 'No long task has reported progress yet')),
            h('div', null, t(
              '用 dsh-progress 包住耗时命令，就会出现在这里：',
              'Wrap a slow command with dsh-progress and it shows up here:',
            )),
            h('div', { style: { ...ui.mono, marginTop: 6, opacity: 0.8 } },
              'dsh-progress run --task build -- <命令>'),
            h('div', { style: { ...ui.mono, marginTop: 4, opacity: 0.6 } }, data?.dir || ''),
          ),
        );
      }

      return h(Page, null,
        turnCard,
        h(ErrorLine, { error, onRetry: reload }),
        h('div', { style: ui.card },
          h(CardHead, {
            label: t('长任务', 'Long tasks'),
            meta: `${tasks.filter((x) => x.state === 'running').length}/${tasks.length}`,
            onReload: reload,
          }),
          tasks.map((task) =>
            h('div', { key: task.task, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('div', { style: ui.row },
                h('span', {
                  style: {
                    ...ui.pill,
                    borderColor: STATE_TONE[task.state] || 'rgba(128,128,128,.35)',
                    color: STATE_TONE[task.state] || 'inherit',
                  },
                }, task.state),
                h('span', { style: { ...ui.ellipsis, fontWeight: 600 } }, task.task),
                h('span', { style: { ...ui.muted, marginLeft: 'auto', ...ui.mono, whiteSpace: 'nowrap' } },
                  task.pct === null ? '' : `${task.pct}%`),
              ),
              task.pct === null
                ? null
                : h('div', { style: ui.meter },
                    h('div', {
                      style: { ...ui.meterFill, width: `${Math.max(0, Math.min(100, task.pct))}%` },
                    }),
                  ),
              task.msg || task.at
                ? h('div', { style: { ...ui.row, gap: '8px' } },
                    task.msg ? h('span', { style: { ...ui.muted, ...ui.ellipsis, flex: 1 } }, task.msg) : h('span', { style: { flex: 1 } }),
                    task.at ? h('span', { style: { ...ui.muted, ...ui.mono, whiteSpace: 'nowrap' } }, relativeTime(task.at)) : null,
                  )
                : null,
            ),
          ),
        ),
      );
    }

    /* ── header counters ─────────────────────────────────────────────────
     * The DSH header leaves the band between the Session title and the right
     * icon cluster empty. Two numbers sit there so they stay visible on every
     * conversation page, instead of waiting inside a sidebar tab:
     *   running — Sessions with a live turn right now;
     *   unread  — finished Sessions this browser has not looked at yet.
     * DSH keeps no per-Session read marker, so this half owns one in
     * localStorage; the Client session store stays the live source for both.
     */
    const HEADER_NS = 'session-rail';
    const HEADER_TEXT = {
      zh: {
        running: '运行',
        unread: '未读',
        interrupted: '中断',
        error: '出错',
        question: '询问',
        idle: '没有进行中的会话，也没有未读完成',
        panelRunning: '正在运行的会话',
        panelUnread: '已完成、尚未查看',
        panelInterrupted: '没做完就中断的',
        panelError: '出问题的',
        panelQuestion: '等你回答的',
        panelEmpty: '所有会话都已读，也没有进行中的回合',
        openHint: '点击会话即可跳转',
        summary: '{running} 个进行中，{question} 个等你回答，{unread} 个未读，{interrupted} 个中断，{error} 个出错',
      },
      en: {
        running: 'live',
        unread: 'unread',
        interrupted: 'stopped',
        error: 'failed',
        question: 'asking',
        idle: 'No live turns and nothing unread',
        panelRunning: 'Running now',
        panelUnread: 'Finished, not read',
        panelInterrupted: 'Stopped mid-turn',
        panelError: 'Errored',
        panelQuestion: 'Waiting on you',
        panelEmpty: 'Every Session is read and nothing is running',
        openHint: 'Click a Session to open it',
        summary: '{running} live, {question} asking, {unread} unread, {interrupted} stopped, {error} failed',
      },
    };

    /** Bound locale translator for HEADER_NS; null keeps the inline dictionary. */
    let headerTranslate = null;

    function headerT(key, params) {
      if (headerTranslate !== null) {
        try {
          return headerTranslate(key, params);
        } catch {
          headerTranslate = null;
        }
      }
      const dict = /^en/i.test(String(activeLocale)) ? HEADER_TEXT.en : HEADER_TEXT.zh;
      const template = dict[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** Read watermark: `sessions` is the highest activity the user has read per Session. */
    const SEEN_KEY = 'dsh-session-rail:seen:v1';

    function readSeenStore() {
      try {
        const raw = window?.localStorage?.getItem?.(SEEN_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) return null;
        return {
          v: 1,
          sessions: parsed.sessions,
          finished: parsed.finished && typeof parsed.finished === 'object' ? parsed.finished : {},
          live: Array.isArray(parsed.live) ? parsed.live.filter((id) => typeof id === 'string') : [],
        };
      } catch {
        return null;
      }
    }

    function writeSeenStore(store) {
      try {
        window?.localStorage?.setItem?.(SEEN_KEY, JSON.stringify(store));
      } catch {
        // A browser that refuses storage keeps counting for this page only.
      }
    }

    /**
     * Reconcile the watermark with the current Session rows.
     * @param rows - `{ id, at, running }` for every root Session the list knows.
     * @param store - previous watermark; null on the first run in this browser.
     * @param currentId - Session on screen; having it open counts as reading it.
     * @param now - clock in milliseconds, injectable for tests.
     * @returns the store to persist (the same object when nothing changed).
     */
    function reconcileSeen(rows, store, currentId, now) {
      const stamp = Number.isFinite(now) ? now : Date.now();
      const live = [];
      for (const row of rows) if (row.running) live.push(row.id);
      if (!store) {
        const sessions = {};
        for (const row of rows) sessions[row.id] = Math.max(sessions[row.id] ?? 0, row.at);
        return { v: 1, sessions, finished: {}, live };
      }
      const sessions = { ...(store.sessions ?? {}) };
      const finished = { ...(store.finished ?? {}) };
      const wasLive = Array.isArray(store.live) ? store.live : [];
      let changed = false;
      // A Session that stopped running has just finished a turn. Unless it is
      // the one on screen, that result is unread until the user opens it.
      for (const id of wasLive) {
        if (live.includes(id) || id === currentId) continue;
        finished[id] = Math.max(finished[id] ?? 0, stamp);
        changed = true;
      }
      if (currentId) {
        const row = rows.find((entry) => entry.id === currentId);
        const at = Math.max(row ? row.at : 0, finished[currentId] ?? 0);
        if ((sessions[currentId] ?? 0) < at) {
          sessions[currentId] = at;
          changed = true;
        }
        if (finished[currentId] !== undefined) {
          delete finished[currentId];
          changed = true;
        }
      }
      const liveChanged = live.length !== wasLive.length || live.some((id, index) => id !== wasLive[index]);
      if (!changed && !liveChanged) return store;
      return { v: 1, sessions, finished, live };
    }

    /**
     * @param rows - root Sessions from the Client session store.
     * @param store - persisted watermark, or null while the baseline is pending.
     * @param currentId - Session on screen; it is being read, so it is not unread.
     * @param outcomes - host verdict per Session id: running / question / done / interrupted / error.
     * @returns the counts the header shows, split by how the turn is going or ended.
     */
    function readCounts(rows, store, currentId, outcomes) {
      const marks = store?.sessions ?? {};
      const finished = store?.finished ?? {};
      const running = [];
      const question = [];
      const unread = [];
      const interrupted = [];
      const error = [];
      for (const row of rows) {
        const tone = outcomes?.[row.id]?.state;
        if (row.running) {
          // A turn parked on ask_user_question is open but not working: it is
          // waiting for the user, so it must not be counted as busy.
          if (tone === 'question') question.push(row);
          else running.push(row);
          continue;
        }
        if (row.id === currentId) continue;
        const seenAt = marks[row.id] ?? 0;
        const finishedAt = finished[row.id] ?? 0;
        if (row.at > seenAt || finishedAt > seenAt) {
          const entry = { ...row, at: Math.max(row.at, finishedAt) };
          if (tone === 'interrupted') interrupted.push(entry);
          else if (tone === 'error') error.push(entry);
          else unread.push(entry);
        }
      }
      const byNewest = (left, right) => right.at - left.at;
      unread.sort(byNewest);
      interrupted.sort(byNewest);
      error.sort(byNewest);
      return { running, question, unread, interrupted, error, ready: store !== null };
    }

    /**
     * Root Sessions from the Client session store; subagent children and blank
     * Sessions are not conversations of their own, so they never count.
     */
    function readSessionRows(sessions) {
      const list = sessions?.list;
      const state = typeof list?.getSnapshot === 'function' ? list.getSnapshot() : null;
      const rows = [];
      for (const id of Array.isArray(state?.ids) ? state.ids : []) {
        const row = state?.byId?.[id];
        if (!row || row.origin === 'subagent' || row.blank === true) continue;
        rows.push({
          id: String(row.id ?? id),
          at: Number(row.updatedAt) || 0,
          running: row.running === true,
          title: String(row.displayTitle || row.title || id),
          // Workspace rollup groups by directory, so the raw cwd has to survive.
          cwd: typeof row.cwd === 'string' && row.cwd ? row.cwd : null,
        });
      }
      return { list, rows };
    }

    function useLocaleRevision(ctx) {
      const [, setRevision] = useState(0);
      useEffect(() => {
        let locale;
        try {
          locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        } catch {
          locale = undefined;
        }
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        const dispose = locale.subscribe(() => {
          readLocale(locale);
          setRevision((value) => value + 1);
        });
        return typeof dispose === 'function' ? dispose : undefined;
      }, [ctx]);
    }

    /**
     * Host verdict for every finished Session the chip can colour: whether its
     * last turn completed, was interrupted, failed, or is parked on a question.
     * Running Sessions are asked about too: an open turn may be waiting on the
     * user rather than working, and only the log can tell those apart.
     */
    function useTurnOutcomes(rows) {
      const [outcomes, setOutcomes] = useState({});
      const ids = rows
        .slice()
        .sort((left, right) => right.at - left.at)
        .slice(0, MAX_OUTCOME_IDS)
        .map((row) => row.id)
        .sort();
      const key = ids.join(',');

      useEffect(() => {
        if (!key) return undefined;
        let cancelled = false;
        let inFlight = false;
        const load = async () => {
          if (inFlight) return;
          inFlight = true;
          try {
            const data = await getJson('/turns', { ids: key });
            if (!cancelled && data?.turns) setOutcomes(data.turns);
          } catch {
            // No verdict only costs the colour: everything falls back to "unread".
          } finally {
            inFlight = false;
          }
        };
        load();
        const timer = setInterval(load, OUTCOME_POLL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [key]);

      return outcomes;
    }

    /** Live counts, driven by the session store's own subscription: no polling. */
    function useHeaderCounts(ctx, currentId) {
      const [rows, setRows] = useState([]);
      const [store, setStore] = useState(() => readSeenStore());

      useEffect(() => {
        let sessions;
        try {
          sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        } catch {
          sessions = undefined;
        }
        const { list, rows: initial } = readSessionRows(sessions);
        setRows(initial);
        if (!list || typeof list.subscribe !== 'function') return undefined;
        const read = () => setRows(readSessionRows(sessions).rows);
        const dispose = list.subscribe(read);
        return () => {
          try {
            if (typeof dispose === 'function') dispose();
          } catch {
            // Disposal is best effort; a dead store simply stops calling back.
          }
        };
      }, [ctx]);

      useEffect(() => {
        if (!rows.length) return;
        const next = reconcileSeen(rows, store, currentId, Date.now());
        if (next !== store) {
          writeSeenStore(next);
          setStore(next);
        }
      }, [rows, store, currentId]);

      return readCounts(rows, store, currentId, useTurnOutcomes(rows));
    }

    /** Inline styles for the header chip and its hover panel (theme alias tokens only). */
    const HDR = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', WebkitAppRegion: 'no-drag' },
      chip: {
        appearance: 'none', WebkitAppearance: 'none', margin: 0, padding: '0 6px', height: '22px',
        display: 'inline-flex', alignItems: 'center', gap: '9px',
        background: 'transparent', border: '1px solid transparent', borderRadius: '7px',
        color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
        font: 'var(--dsw-font-xxxs-11, 11px/14px inherit)',
      },
      segment: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      dot: { width: '6px', height: '6px', borderRadius: '999px', flex: 'none', display: 'inline-block' },
      number: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'var(--dsw-font-xxs-strong-12, 500 11px/14px inherit)',
        fontVariantNumeric: 'tabular-nums',
      },
      label: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      panelWrap: { position: 'fixed', zIndex: 60, paddingTop: '6px' },
      panel: {
        width: '268px', maxWidth: '72vw', boxSizing: 'border-box',
        padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px',
        // Floating menu over a live transcript: opaque, never glass. `bg-overlay`
        // renders translucent here (measured #394762 on a #222731 header), which is
        // what made the panel look washed out; `bg-layer-3` is a solid surface —
        // #353638 in the dark theme, #ffffff in light — one step above the page
        // (#252527) and level with the shell's own menu fill (#303136).
        background: 'var(--dsw-alias-bg-layer-3, #353638)',
        border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16))',
        borderRadius: '10px', boxShadow: '0 16px 40px rgba(0,0,0,.45)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'var(--dsw-font-xxxs-11, 11px/15px inherit)',
      },
      panelSection: { display: 'flex', flexDirection: 'column', gap: '1px' },
      panelHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '2px 4px', fontSize: '10px', letterSpacing: '.04em',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      },
      panelCount: { fontVariantNumeric: 'tabular-nums' },
      row: {
        appearance: 'none', margin: 0, padding: '3px 4px', width: '100%', boxSizing: 'border-box',
        display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0,
        background: 'transparent', border: 'none', borderRadius: '6px',
        color: 'inherit', cursor: 'pointer', textAlign: 'left',
        font: 'var(--dsw-font-xxxs-11, 11px/15px inherit)',
      },
      rowTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { flex: 'none', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontVariantNumeric: 'tabular-nums' },
      panelFoot: { padding: '2px 4px 0', fontSize: '10px', color: 'var(--dsw-alias-label-caption, #8a8a8a)' },
    };

    const HEADER_CSS = `
      .sr-hdr-chip {
        transition: background-color .12s ease, border-color .12s ease, opacity .12s ease, transform .12s ease;
      }
      .sr-hdr-chip:hover, .sr-hdr-chip:focus-visible {
        background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
        border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.3));
      }
      .sr-hdr-chip:active { transform: scale(.985); }
      .sr-hdr-chip[data-pinned="true"] {
        background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.24));
        border-color: var(--dsw-alias-border-l3, rgba(255,255,255,.16));
      }
      .sr-hdr-chip:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: 1px; }
      .sr-hdr-chip[data-idle="true"] { opacity: .45; }
      .sr-hdr-chip[data-idle="true"]:hover, .sr-hdr-chip[data-idle="true"]:focus-visible { opacity: .95; }
      .sr-hdr-live { animation: sr-hdr-pulse 2.4s ease-in-out infinite; }
      @keyframes sr-hdr-pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
      @media (prefers-reduced-motion: reduce) { .sr-hdr-live { animation: none; opacity: .85 } }
      .sr-hdr-row { border-radius: 6px; }
      .sr-hdr-row:hover, .sr-hdr-row:focus-visible {
        background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
      }
      .sr-hdr-row:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: -1px; }
    `;

    /**
     * Two live counts in the header band: turns in flight, and finished
     * Sessions this browser has not read. Idle degrades to a single faint dot;
     * hover or keyboard focus reveals the per-Session detail.
     */
    function HeaderCounts(props) {
      const rail = props?.rail ?? {};
      const ctx = rail.ctx ?? null;
      const currentId = String(rail.currentId || props?.sessionId || props?.scope?.sessionId || '');
      useLocaleRevision(ctx);
      const counts = useHeaderCounts(ctx, currentId);
      const [open, setOpen] = useState(false);
      // Peek (hover/focus) closes on leave; pinned (click) stays until the user
      // closes it — leaving a menu that vanishes on the way to it is unusable.
      const [pinned, setPinned] = useState(false);
      const [anchor, setAnchor] = useState(null);

      // A pinned panel has to close on a click outside itself, not only on Esc.
      useEffect(() => {
        if (!pinned) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onPointerDown = (event) => {
          const root = typeof document.querySelector === 'function' ? document.querySelector('.sr-hdr-wrap') : null;
          const target = event?.target;
          if (root && target && typeof root.contains === 'function' && root.contains(target)) return;
          setPinned(false);
          setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => {
          if (typeof document.removeEventListener === 'function') document.removeEventListener('mousedown', onPointerDown);
        };
      }, [pinned]);

      if (!counts.ready) return null;

      const questionCount = counts.question.length;
      const runningCount = counts.running.length;
      const unreadCount = counts.unread.length;
      const interruptedCount = counts.interrupted.length;
      const errorCount = counts.error.length;
      const idle = runningCount + questionCount + unreadCount + interruptedCount + errorCount === 0;
      const summary = idle
        ? headerT('idle')
        : headerT('summary', {
            running: runningCount,
            question: questionCount,
            unread: unreadCount,
            interrupted: interruptedCount,
            error: errorCount,
          });

      const place = (event) => {
        const rect = event?.currentTarget?.getBoundingClientRect?.();
        if (!rect) {
          setAnchor({ top: 56, right: 24 });
          return;
        }
        setAnchor({
          top: Math.round(rect.bottom + 6),
          right: Math.max(8, Math.round(window.innerWidth - rect.right)),
        });
      };

      const openSession = (id) => {
        try {
          const workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(id);
            setOpen(false);
          }
        } catch {
          // Navigation is optional; the counts stay readable without it.
        }
      };

      /**
       * One dot + number + label per state, all on the shell's own tokens:
       * blue = work in flight, amber (warning) = waiting on your answer — the
       * same colour the shipped sidebar uses for "等待回答" — red broke, green is
       * finished and unread, and "stopped short" is neutral grey because the
       * theme has no fifth state colour and amber now belongs to the question.
       */
      const TONES = [
        { key: 'error', count: errorCount, label: 'error', tone: 'var(--dsw-alias-state-error-primary, #e05a4f)' },
        { key: 'question', count: questionCount, label: 'question', pulse: true, tone: 'var(--dsw-alias-state-warn-primary, #f59e0b)' },
        { key: 'interrupted', count: interruptedCount, label: 'interrupted', tone: 'var(--dsw-alias-label-dimmed, #8a8a8a)' },
        { key: 'running', count: runningCount, label: 'running', pulse: true, tone: 'var(--dsw-alias-state-business-primary, #4176e6)' },
        { key: 'unread', count: unreadCount, label: 'unread', tone: 'var(--dsw-alias-state-success-primary, #22c55e)' },
      ];

      const segments = [];
      for (const item of TONES) {
        if (item.count === 0) continue;
        segments.push(h('span', { key: item.key, style: HDR.segment },
          h('span', {
            key: 'dot',
            className: item.pulse ? 'sr-hdr-live' : undefined,
            style: { ...HDR.dot, background: item.tone },
          }),
          h('span', { key: 'num', style: HDR.number }, String(item.count)),
          h('span', { key: 'label', style: HDR.label }, headerT(item.label)),
        ));
      }
      if (segments.length === 0) {
        segments.push(h('span', {
          key: 'idle',
          style: { ...HDR.dot, background: 'var(--dsw-alias-label-dimmed, #8a8a8a)' },
        }));
      }

      const SECTIONS = [
        { key: 'error', list: counts.error, label: 'panelError' },
        { key: 'question', list: counts.question, label: 'panelQuestion' },
        { key: 'interrupted', list: counts.interrupted, label: 'panelInterrupted' },
        { key: 'running', list: counts.running, label: 'panelRunning' },
        { key: 'unread', list: counts.unread, label: 'panelUnread' },
      ];

      const section = ({ key, list, label }) => {
        const rows = list.slice(0, 6).map((row) => h('button', {
          key: row.id,
          type: 'button',
          className: 'sr-hdr-row',
          style: HDR.row,
          title: row.title,
          onClick: () => openSession(row.id),
        },
          h('span', { key: 'title', style: HDR.rowTitle }, row.title),
          key === 'running' ? null : h('span', { key: 'meta', style: HDR.rowMeta }, relativeTime(row.at)),
        ));
        return h('div', { key, style: HDR.panelSection },
          h('div', { style: HDR.panelHead },
            h('span', null, headerT(label)),
            h('span', { style: HDR.panelCount }, String(list.length)),
          ),
          ...rows,
          list.length > 6
            ? h('div', { key: 'more', style: { ...HDR.rowMeta, padding: '0 4px' } }, `+${String(list.length - 6)}`)
            : null,
        );
      };

      return h('span', {
        style: HDR.wrap,
        className: 'sr-hdr-wrap',
        onMouseEnter: (event) => {
          place(event);
          setOpen(true);
        },
        // Peek closes on leave; a pinned panel survives the trip to it.
        onMouseLeave: () => {
          if (!pinned) setOpen(false);
        },
        onFocus: (event) => {
          place(event);
          setOpen(true);
        },
        onBlur: (event) => {
          if (pinned) return;
          if (!event.currentTarget.contains?.(event.relatedTarget)) setOpen(false);
        },
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            setPinned(false);
            setOpen(false);
          }
        },
      },
        h('style', null, HEADER_CSS),
        h('button', {
          type: 'button',
          className: 'sr-hdr-chip',
          'data-idle': idle ? 'true' : 'false',
          'data-pinned': pinned ? 'true' : 'false',
          style: HDR.chip,
          'aria-label': summary,
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-controls': 'session-rail-header-panel',
          onClick: (event) => {
            // Click pins the menu open instead of jumping somewhere: the rows
            // inside are the navigation, and a click-to-navigate chip would make
            // "open the list" impossible with a mouse.
            place(event);
            setPinned(!pinned);
            setOpen(true);
          },
        }, ...segments),
        open && anchor
          ? h('div', {
            id: 'session-rail-header-panel',
            style: { ...HDR.panelWrap, top: `${anchor.top}px`, right: `${anchor.right}px` },
            role: 'dialog',
            'aria-label': summary,
          },
            h('div', { style: HDR.panel },
              SECTIONS.filter((entry) => entry.list.length > 0).map(section),
              idle ? h('div', { style: HDR.panelFoot }, headerT('panelEmpty')) : null,
              idle ? null : h('div', { style: HDR.panelFoot }, headerT('openHint')),
            ))
          : null,
      );
    }

    /* ── left-rail workspace badges ───────────────────────────────────────
     * A workspace row is the shell's closed `ProjectRowItem` with no slot of its
     * own, so the count is drawn as a native DOM node on
     * `[data-row-key^="workspace:"]` and re-applied on a timer: React replaces
     * row children, and this half must never hold a React tree it does not own.
     */
    const BADGE_ATTR = 'data-sr-badge';
    const BADGE_TOGGLE_KEY = 'dsh-session-rail:workspace-badge:v1';
    const BADGE_PAINT_MS = 1500;
    const WORKSPACE_POLL_MS = 60_000;

    function workspaceBadgeEnabled() {
      try {
        return window?.localStorage?.getItem?.(BADGE_TOGGLE_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    /**
     * @param rows - root Sessions, already filtered of blank and subagent rows.
     * @param workspaces - registry projection: `{ id, title, sessionIds }`.
     * @param outcomes - host verdict per Session id.
     * @returns one entry per Workspace that has work right now; Workspaces with
     *          nothing running are dropped here, so the DOM never has to decide.
     */
    function rollupByWorkspace(rows, workspaces, outcomes) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const out = [];
      for (const workspace of workspaces ?? []) {
        let running = 0;
        let question = 0;
        for (const sessionId of workspace?.sessionIds ?? []) {
          const id = String(sessionId);
          const verdict = outcomes?.[id]?.state;
          if (verdict === 'question') {
            question += 1;
            continue;
          }
          if (byId.get(id)?.running) running += 1;
        }
        if (running + question > 0) {
          out.push({ id: String(workspace.id), title: String(workspace.title ?? ''), running, question });
        }
      }
      return out;
    }

    /**
     * Draw (or clear) one badge per workspace row.
     * @returns how many rows ended up with a badge, so a failure is visible as 0.
     */
    function paintWorkspaceBadges(rollup, enabled) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return 0;
      const rows = document.querySelectorAll('[data-row-key^="workspace:"]');
      const byId = new Map((rollup ?? []).map((entry) => [entry.id, entry]));
      let painted = 0;
      for (const row of rows) {
        const key = typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') ?? '' : '';
        const id = key.startsWith('workspace:') ? key.slice('workspace:'.length) : '';
        const entry = enabled ? byId.get(id) : undefined;
        const existing = typeof row.querySelector === 'function' ? row.querySelector(`[${BADGE_ATTR}]`) : null;
        const total = entry ? entry.running + entry.question : 0;
        if (total === 0) {
          if (existing && typeof existing.remove === 'function') existing.remove();
          continue;
        }
        let badge = existing;
        if (!badge) {
          badge = document.createElement('span');
          badge.setAttribute(BADGE_ATTR, '');
          badge.style.cssText = [
            'margin-left:auto', 'display:inline-flex', 'align-items:center', 'gap:4px',
            'font:var(--dsw-font-xxxs-11, 11px/14px inherit)',
            'color:var(--dsw-alias-label-tertiary, #8a8a8a)',
            'pointer-events:none',
          ].join(';');
          row.appendChild(badge);
        }
        const tone = entry.question > 0
          ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
          : 'var(--dsw-alias-state-business-primary, #4176e6)';
        badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:${tone}"></span>${total > 9 ? '9+' : total}`;
        badge.setAttribute('title', entry.question > 0
          ? `${entry.title}：${entry.question} 个等你回答，${entry.running} 个在跑`
          : `${entry.title}：${entry.running} 个在跑`);
        painted += 1;
      }
      return painted;
    }

    /**
     * Null-rendering occupant: it exists only to keep the rail badges in sync
     * while the sidebar is on screen, whichever conversation page is open.
     */
    function WorkspaceBadges(props) {
      const rail = props?.rail ?? {};
      const ctx = rail.ctx ?? null;
      const [rows, setRows] = useState([]);
      const [workspaces, setWorkspaces] = useState([]);

      useEffect(() => {
        let sessions;
        try {
          sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        } catch {
          sessions = undefined;
        }
        const { list, rows: initial } = readSessionRows(sessions);
        setRows(initial);
        if (!list || typeof list.subscribe !== 'function') return undefined;
        const read = () => setRows(readSessionRows(sessions).rows);
        const dispose = list.subscribe(read);
        return () => {
          try {
            if (typeof dispose === 'function') dispose();
          } catch {
            // A dead store simply stops calling back.
          }
        };
      }, [ctx]);

      useEffect(() => {
        let cancelled = false;
        let inFlight = false;
        const load = async () => {
          if (inFlight) return;
          inFlight = true;
          try {
            const data = await getJson('/workspaces', {});
            if (!cancelled && Array.isArray(data?.workspaces)) setWorkspaces(data.workspaces);
          } catch {
            // No membership only costs the badges; the header keeps working.
          } finally {
            inFlight = false;
          }
        };
        load();
        const timer = setInterval(load, WORKSPACE_POLL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      const outcomes = useTurnOutcomes(rows);

      useEffect(() => {
        const rollup = rollupByWorkspace(rows, workspaces, outcomes);
        const enabled = workspaceBadgeEnabled();
        const paint = () => {
          try {
            paintWorkspaceBadges(rollup, enabled);
          } catch {
            // A paint failure must not break the sidebar it decorates.
          }
        };
        paint();
        const timer = setInterval(paint, BADGE_PAINT_MS);
        return () => clearInterval(timer);
      }, [rows, workspaces, outcomes]);

      return null;
    }

    function icon(paths) {
      return (size) => h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    const progressIcon = icon(['M4 18h4V9H4z', 'M10 18h4V5h-4z', 'M16 18h4v-6h-4z']);

    const descriptors = [
      {
        id: 'session-rail:progress',
        title: () => t('进度', 'Progress'),
        description: () => t('本会话长任务的实时进度（.dsh-progress）', 'Live progress of this session’s long-running tasks'),
        icon: progressIcon,
        order: 90,
        single: true,
        badge: (_ctx, scope) => badges.get(badgeKey('progress', scope)) || null,
        component: ProgressTab,
      },
    ];

    return {
      /** Pure helpers exposed for the offline client test; the loader only reads `apply`. */
      internals: { reconcileSeen, readCounts, readSessionRows, HeaderCounts, HEADER_TEXT, SEEN_KEY, rollupByWorkspace, paintWorkspaceBadges, WorkspaceBadges, BADGE_ATTR, BADGE_TOGGLE_KEY },
      apply(ctx) {
        let locale;
        try {
          locale = ctx.get('locale');
        } catch {
          locale = undefined;
        }
        readLocale(locale);
        if (locale && typeof locale.subscribe === 'function') {
          ctx.effect(() => locale.subscribe(() => readLocale(locale)));
        }
        // Header copy lives in the plugin's own locale namespace, so the GUI's
        // language switch reaches it without a reload.
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(HEADER_NS, HEADER_TEXT));
        }
        if (locale && typeof locale.bind === 'function') {
          headerTranslate = locale.bind(HEADER_NS);
        }

        /**
         * Header counters: `conversation.session.header.utilities` is the band
         * the empty space belongs to — the right-aligned controls sit after it,
         * the Session title before it, and the shell re-renders it on every
         * conversation page (all view tabs share this header).
         */
        const registerHeader = (scoped) => {
          let slots;
          try {
            slots = typeof scoped.get === 'function' ? scoped.get('slots') : scoped.slots;
          } catch {
            slots = undefined;
          }
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            report('header', {});
            console.warn('[session-rail] slots 服务未出现，顶部会话计数未注册。');
            return;
          }
          scoped.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register({
            name: 'conversation.session.header.utilities',
            id: 'session-rail:header-counts',
            order: -10,
            inject: (sessionId) => ({
              rail: {
                ctx: scoped,
                currentId: sessionId === undefined || sessionId === null ? '' : String(sessionId),
              },
            }),
          }, HeaderCounts)));
          report('header', { tabs: 'header-counts' });
        };

        /**
         * The rail badges ride on a slot the sidebar always renders, so they keep
         * working while a settings page or another panel owns the main area.
         */
        const registerBadges = (scoped) => {
          let slots;
          try {
            slots = typeof scoped.get === 'function' ? scoped.get('slots') : scoped.slots;
          } catch {
            slots = undefined;
          }
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            report('badges', {});
            return;
          }
          try {
            scoped.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
              name: 'sidebar.footer.action',
              id: 'session-rail:workspace-badges',
              order: 900,
              inject: () => ({ rail: { ctx: scoped } }),
            }, WorkspaceBadges)));
            report('badges', { tabs: 'workspace-badges' });
          } catch (error) {
            // An unknown slot key must not take the whole plugin down.
            console.warn('[session-rail] 左栏工作区徽标未挂载：', error instanceof Error ? error.message : String(error));
            report('badges', { service: 0 });
          }
        };

        const registerAll = (scoped) => {
          const service = typeof scoped.get === 'function' ? scoped.get('betterSidebar') : scoped.betterSidebar;
          report('apply', { service: service ? 1 : 0 });
          if (!service || typeof service.registerTab !== 'function') return;
          const registered = [];
          for (const descriptor of descriptors) {
            scoped.effect(() => service.registerTab(descriptor));
            registered.push(descriptor.id);
          }
          report('registered', { service: 1, tabs: registered.join(',') });
        };

        if (typeof ctx.inject === 'function') {
          // Non-blocking: the tab types appear as soon as dsh-better-sidebar's
          // client half publishes its service, which may be later than this apply.
          ctx.inject(['betterSidebar'], registerAll);
          // The header seat needs the slot registry and the session list; both
          // belong to core client packages, but neither is guaranteed at apply time.
          ctx.inject(['slots', 'sessions'], registerHeader);
          ctx.inject(['slots', 'sessions'], registerBadges);
          setTimeout(() => {
            try {
              if (!ctx.get('betterSidebar')) {
                console.warn('[session-rail] betterSidebar 服务未出现，进度标签未注册（是否停用了 dsh-better-sidebar？）');
              }
            } catch {
              // ctx.get can throw while the plugin is being disposed; nothing to report then.
            }
          }, SERVICE_DIAGNOSTIC_MS);
        } else {
          registerAll(ctx);
          registerHeader(ctx);
        }
      },
    };
  },
});
