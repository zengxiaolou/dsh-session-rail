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
        }
      },
    };
  },
});
