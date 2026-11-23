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

    const CHANNEL = '/rt-translation'
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
    const HOLD_OPTIONS = [['3 秒', '3000'], ['4 秒', '4000'], ['5 秒', '5000'], ['6 秒', '6000'], ['8 秒', '8000'], ['12 秒', '12000']]
    const READ_OPTIONS = [['0.8 秒', '800'], ['1.2 秒', '1200'], ['1.8 秒', '1800'], ['2.5 秒', '2500'], ['3.5 秒', '3500']]

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
        width: 318,
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
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
    }

    function labelOf(pairs, value) {
      for (const pair of pairs) if (pair[1] === value) return pair[0]
      return String(value)
    }

    function select(pairs, value, onChange, style) {
      return h('select', {
        value: String(value),
        style: style || S.select,
        onChange: event => onChange(event.target.value),
      }, pairs.map(([label, key]) => h('option', { key, value: key }, label)))
    }

    function stepper(label, value, min, max, step, onChange) {
      return h('div', { style: { ...S.row, gap: 4 } },
        h('span', { style: S.label }, label),
        h('button', { style: S.smallButton, title: '减少', onClick: () => onChange(Math.max(min, value - step)) }, '−'),
        h('span', { style: S.number }, String(value)),
        h('button', { style: S.smallButton, title: '增加', onClick: () => onChange(Math.min(max, value + step)) }, '+'),
      )
    }

    function ControlBar(props) {
      const call = props.call
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
        if (typeof call !== 'function') { setError('未连接到 DSH Host'); return }
        try {
          apply(await call('state', {}))
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [call, apply])

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
        if (typeof call !== 'function') return
        try {
          const payload = { action }
          if (value !== undefined) payload.value = value
          apply(await call('action', payload))
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [call, apply])

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
          h('span', { style: S.label }, '模式'),
          h('button', {
            style: state.preset === 'meeting' ? S.activeButton : S.button,
            onClick: () => { void act('setMode', 'meeting') },
          }, '会议'),
          h('button', {
            style: state.preset === 'media' ? S.activeButton : S.button,
            onClick: () => { void act('setMode', 'media') },
          }, '影视'),
        ),
        h('div', { style: S.divider }),
        h('div', { style: S.wrapRow },
          stepper('字号', subtitle.fontSize, 12, 96, 2, value => { void act('setFontSize', value) }),
          stepper('行数', subtitle.maxLines, 1, 6, 1, value => { void act('setSubtitle', { maxLines: value }) }),
        ),
        h('div', { style: S.wrapRow },
          h('span', { style: S.label }, '位置'),
          h('button', {
            style: subtitle.position === 'bottom' ? S.activeButton : S.button,
            onClick: () => { void act('setSubtitle', { position: 'bottom' }) },
          }, '底部'),
          h('button', {
            style: subtitle.position === 'top' ? S.activeButton : S.button,
            onClick: () => { void act('setSubtitle', { position: 'top' }) },
          }, '顶部'),
          h('label', { style: { ...S.row, marginLeft: 6 } },
            h('input', {
              type: 'checkbox',
              checked: subtitle.bilingual === true,
              onChange: event => { void act('setSubtitle', { bilingual: event.target.checked }) },
            }),
            h('span', { style: S.muted }, '显示原文'),
          ),
        ),
        h('div', { style: S.wrapRow },
          h('span', { style: S.label }, '停留'),
          select(HOLD_OPTIONS, subtitle.holdMs, value => { void act('setSubtitle', { holdMs: Number(value) }) }),
          h('span', { style: S.label }, '阅读'),
          select(READ_OPTIONS, subtitle.minReadMs, value => { void act('setSubtitle', { minReadMs: Number(value) }) }),
        ),
        h('div', { style: S.divider }),
        h('div', { style: S.wrapRow },
          h('button', { style: S.button, onClick: () => { void act('clear') } }, '清屏'),
          h('button', { style: S.button, onClick: () => { void act('restart') } }, '重连音频'),
          h('button', { style: S.button, onClick: () => { void act('prepare') } }, '准备模型'),
        ),
        h('div', { style: S.hint }, '字幕画在屏幕置顶叠加窗；屏幕共享与录屏时会被看到。'),
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
      inject: ['slots', 'connection'],
      apply(ctx) {
        const call = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload)
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'rt-translation-control',
          order: 120,
          inject: () => ({ call }),
        }, ControlBar))
      },
    }
  },
})
