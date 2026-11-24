/**
 * Browser half of dsh-rt-translation: the control bar inside the DSH window.
 *
 * The WPF overlay keeps drawing subtitles on the desktop; this bundle replaces
 * the old standalone WPF control bar by rendering the same controls in the
 * frame-wide `shell.overlay` slot and driving the Host through the authenticated
 * Connection RPC channel `/rt-translation`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rt-translation',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STATE_URL = '/plugins/dsh-rt-translation/state'
    const ACTION_URL = '/plugins/dsh-rt-translation/action'
    const POLL_MS = 1500

    const PHASE_LABEL = {
      idle: '已停止',
      preparing: '准备模型…',
      listening: '收听中',
      paused: '已暂停',
      error: '出错',
    }
    const PHASE_COLOR = {
      idle: 'var(--dsw-alias-state-idle-primary)',
      preparing: 'var(--dsw-alias-state-warn-primary)',
      listening: 'var(--dsw-alias-state-success-primary)',
      paused: 'var(--dsw-alias-state-business-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    const SOURCES = [['自动', 'auto'], ['中文', 'zh'], ['English', 'en'], ['日本語', 'ja'], ['한국어', 'ko'], ['粤语', 'yue']]
    const TARGETS = [['中文', 'zh'], ['English', 'en'], ['日本語', 'ja'], ['한국어', 'ko'], ['粤语', 'yue']]
    const READ_OPTIONS = [['0.8 秒', '800'], ['1.2 秒', '1200'], ['1.8 秒', '1800'], ['2.5 秒', '2500'], ['3.5 秒', '3500']]
    const AUTO_PAUSE_OPTIONS = [['关闭', '0'], ['1 分钟', '60000'], ['2 分钟', '120000'], ['5 分钟', '300000'], ['10 分钟', '600000']]

    const S = {
      root: {
        position: 'absolute',
        right: 16,
        bottom: 16,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
        pointerEvents: 'none',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-primary)',
      },
      pill: {
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 9px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
        userSelect: 'none',
      },
      dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto' },
      title: { fontWeight: 600, whiteSpace: 'nowrap' },
      muted: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      panel: {
        pointerEvents: 'auto',
        width: 348,
        padding: 12,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.32)',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 6 },
      wrapRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, minWidth: 30, flex: '0 0 auto' },
      arrow: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      select: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '2px 4px',
        fontSize: 12,
        fontFamily: 'inherit',
        minWidth: 0,
        maxWidth: 128,
      },
      button: {
        background: 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2))',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      activeButton: {
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-on-color)',
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      iconButton: {
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        border: 'none',
        borderRadius: 6,
        padding: '2px 4px',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      smallButton: {
        background: 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2))',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        width: 22,
        height: 22,
        fontSize: 12,
        lineHeight: '16px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        padding: 0,
      },
      number: { minWidth: 30, textAlign: 'center', color: 'var(--dsw-alias-label-primary)' },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '2px 0' },
      footer: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, wordBreak: 'break-all' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, wordBreak: 'break-all' },
    }

    function labelOf(pairs, value) {
      for (const pair of pairs) if (pair[1] === value) return pair[0]
      return String(value)
    }

    /** Map transport/auth failures to a short message for the panel footer. */
    function apiFailure(error) {
      const status = error && error.status
      if (status === 401 || status === 403) return 'DSH 会话未授权，请刷新页面'
      if (status === 503) return 'DSH Host 尚未就绪'
      return error && error.message ? error.message : String(error)
    }

    async function requestJson(url, init) {
      const response = await fetch(url, { cache: 'no-store', ...init })
      if (!response.ok) {
        const failure = new Error(`HTTP ${response.status} ${url}`)
        failure.status = response.status
        throw failure
      }
      return response.json()
    }

    async function fetchState() {
      return requestJson(STATE_URL, { headers: { accept: 'application/json' } })
    }

    async function postAction(payload) {
      return requestJson(ACTION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    function select(pairs, value, onChange, style) {
      return h('select', {
        value: String(value),
        style: style || S.select,
        onChange: event => onChange(event.target.value),
      }, pairs.map(([label, key]) => h('option', { key, value: key }, label)))
    }

    function stepper(label, value, min, max, step, onChange, format) {
      const numberStyle = format === undefined
        ? S.number
        : { ...S.number, minWidth: 58, whiteSpace: 'nowrap' }
      return h('div', { style: { ...S.row, gap: 4 } },
        h('span', { style: S.label }, label),
        h('button', { style: S.smallButton, title: '减少', onClick: () => onChange(Math.max(min, value - step)) }, '−'),
        h('span', { style: numberStyle }, format === undefined ? String(value) : format(value)),
        h('button', { style: S.smallButton, title: '增加', onClick: () => onChange(Math.min(max, value + step)) }, '+'),
      )
    }

    function ControlBar() {
      const [snap, setSnap] = useState(null)
      const [open, setOpen] = useState(false)
      const [error, setError] = useState('')
      const alive = useRef(true)

      const apply = useCallback(result => {
        if (result && result.ok && result.value) {
          setSnap(result.value)
          setError('')
          return
        }
        if (result && result.error) setError(result.error.message)
        else setError('控制面板不可用')
      }, [])

      const refresh = useCallback(async () => {
        try {
          apply(await fetchState())
        } catch (failure) {
          setError(apiFailure(failure))
        }
      }, [apply])

      useEffect(() => {
        alive.current = true
        let timer = 0
        const loop = async () => {
          if (!alive.current) return
          await refresh()
          if (alive.current) timer = window.setTimeout(() => { void loop() }, POLL_MS)
        }
        void loop()
        return () => { alive.current = false; window.clearTimeout(timer) }
      }, [refresh])

      const act = useCallback(async (action, value) => {
        try {
          const payload = { action }
          if (value !== undefined) payload.value = value
          apply(await postAction(payload))
        } catch (failure) {
          setError(apiFailure(failure))
        }
      }, [apply])

      if (snap === null) {
        return h('div', { style: S.root },
          h('div', { style: S.pill },
            h('span', { style: { ...S.dot, background: error ? PHASE_COLOR.error : PHASE_COLOR.idle } }),
            h('span', { style: S.title }, '实时翻译'),
            h('span', { style: S.muted }, error ? '未连接' : '连接中…'),
            h('button', { style: S.iconButton, title: '重试', onClick: () => { void refresh() } }, '↻'),
          ),
          error ? h('div', { style: { ...S.error, pointerEvents: 'auto' } }, error) : null,
        )
      }

      const state = snap.state
      const subtitle = snap.subtitle
      const segment = snap.segment || { silenceMs: 280, maxSegmentMs: 5000 }
      const autoPause = typeof snap.autoPauseAfterMs === 'number' ? snap.autoPauseAfterMs : 120000
      const running = state.phase === 'listening' || state.phase === 'preparing'
      const phaseLabel = PHASE_LABEL[state.phase] || state.phase
      const dotColor = PHASE_COLOR[state.phase] || PHASE_COLOR.idle
      const languageLabel = state.source === 'auto'
        ? `自动 → ${labelOf(TARGETS, state.target)}`
        : `${labelOf(SOURCES, state.source)} → ${labelOf(TARGETS, state.target)}`

      const pill = h('div', { style: S.pill, title: '实时语音翻译字幕' },
        h('span', { style: { ...S.dot, background: dotColor } }),
        h('span', { style: S.title }, '实时翻译'),
        h('span', { style: S.muted }, languageLabel),
        h('span', { style: { color: dotColor, whiteSpace: 'nowrap' } }, phaseLabel),
        h('button', {
          style: S.iconButton,
          title: running ? '停止（Ctrl+Alt+S）' : '开始（Ctrl+Alt+S）',
          onClick: () => { void act('toggle') },
        }, running ? '⏸' : '▶'),
        h('button', {
          style: S.iconButton,
          title: open ? '收起' : '展开设置',
          onClick: () => setOpen(value => !value),
        }, open ? '▾' : '▴'),
      )

      const panel = open ? h('div', { style: S.panel },
        h('div', { style: S.row },
          h('span', { style: S.label }, '语言'),
          select(SOURCES, state.source, value => { void act('setSource', value) }),
          h('span', { style: S.arrow }, '→'),
          select(TARGETS, state.target, value => { void act('setTarget', value) }),
        ),
        h('div', { style: S.wrapRow },
          stepper('静音', segment.silenceMs, 100, 3000, 50, value => { void act('setSegment', { silenceMs: value }) }, value => `${value} ms`),
          h('span', { style: { width: 10, flex: '0 0 auto' } }),
          stepper('单句', segment.maxSegmentMs, 1000, 15000, 500, value => { void act('setSegment', { maxSegmentMs: value }) }, value => `${(value / 1000).toFixed(1)} s`),
        ),
        h('div', { style: S.wrapRow },
          h('span', { style: S.label }, '暂停'),
          select(AUTO_PAUSE_OPTIONS, String(autoPause), value => { void act('setAutoPause', Number(value)) }),
          h('span', { style: S.muted }, '静音后自动暂停'),
        ),
        h('div', { style: S.divider }),
        h('div', { style: S.wrapRow },
          stepper('字号', subtitle.fontSize, 12, 96, 2, value => { void act('setFontSize', value) }),
          h('span', { style: { width: 10, flex: '0 0 auto' } }),
          stepper('行数', subtitle.maxLines, 2, 5, 1, value => { void act('setSubtitle', { maxLines: value }) }),
        ),
        h('div', { style: S.wrapRow },
          h('span', { style: S.label }, '透明度'),
          h('input', {
            type: 'range',
            min: 0.2,
            max: 1,
            step: 0.01,
            value: subtitle.opacity,
            style: { width: 88, accentColor: 'var(--dsw-alias-brand-primary)' },
            onChange: event => { void act('setSubtitle', { opacity: Number(event.target.value) }) },
          }),
          h('span', { style: S.muted }, `${Math.round(subtitle.opacity * 100)}%`),
          h('label', { style: { ...S.row, marginLeft: 8 } },
            h('input', {
              type: 'checkbox',
              checked: subtitle.bilingual === true,
              onChange: event => { void act('setSubtitle', { bilingual: event.target.checked }) },
            }),
            h('span', { style: S.muted }, '显示原文'),
          ),
        ),
        h('div', { style: S.wrapRow },
          h('span', { style: S.label }, '阅读'),
          select(READ_OPTIONS, subtitle.minReadMs, value => { void act('setSubtitle', { minReadMs: Number(value) }) }),
        ),
        h('div', { style: S.divider }),
        h('div', { style: S.wrapRow },
          h('button', { style: S.button, onClick: () => { void act('clear') } }, '清屏'),
          h('button', { style: S.button, onClick: () => { void act('restart') } }, '重连音频'),
          h('button', { style: S.button, onClick: () => { void act('prepare') } }, '准备模型'),
        ),
        h('div', { style: S.footer },
          `识别: ${snap.stt}`,
          h('br'),
          `翻译: ${snap.translate.provider || '跟随默认'} / ${snap.translate.model || '自动'}`,
          snap.persistence ? null : h('span', null, h('br'), '设置未写入 profile（仅内存）'),
        ),
        state.error || error ? h('div', { style: S.error }, state.error || error) : null,
      ) : null

      return h('div', { style: S.root }, panel, pill)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'rt-translation-control',
          order: 120,
        }, ControlBar))
      },
    }
  },
})
