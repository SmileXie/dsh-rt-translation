/**
 * Browser half of dsh-rt-translation.
 *
 * The WPF overlay keeps drawing subtitles on the desktop. The controls live in
 * the app shell itself: a "实时翻译" entry in the left sidebar (`sidebar.panellist`)
 * and the page it opens in the main column (`main`, keyed by the same id), the
 * way the shipped Plugins and Schedule pages are built. Nothing floats over the
 * conversation any more.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rt-translation',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Shared by the sidebar entry and the main page it selects. */
    const PANEL_ID = 'rt-translation'
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

    /** Control-level styles shared by every row of the page. */
    const S = {
      dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto' },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, minWidth: 60, flex: '0 0 auto' },
      arrow: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      select: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 13,
        fontFamily: 'inherit',
        minWidth: 0,
        maxWidth: 160,
      },
      button: {
        background: 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2))',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      primaryButton: {
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-on-color)',
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '4px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      smallButton: {
        background: 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2))',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        width: 24,
        height: 24,
        fontSize: 13,
        lineHeight: '18px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        padding: 0,
      },
      number: { minWidth: 34, textAlign: 'center', color: 'var(--dsw-alias-label-primary)' },
    }

    /** Page-level layout; the shell gives the main column the full height. */
    const P = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: 880,
        margin: '0 auto',
        // The main column has no scroller of its own; the page owns one.
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '28px 32px 48px',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-primary)',
      },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      intro: { margin: '4px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      headActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      status: { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      cardTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 620 },
      footer: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' },
    }

    /** Map transport/auth failures to a short message for the page footer. */
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
        : { ...S.number, minWidth: 62, whiteSpace: 'nowrap' }
      return h('div', { style: { ...P.row, gap: 4 } },
        h('span', { style: S.label }, label),
        h('button', { style: S.smallButton, title: '减少', onClick: () => onChange(Math.max(min, value - step)) }, '−'),
        h('span', { style: numberStyle }, format === undefined ? String(value) : format(value)),
        h('button', { style: S.smallButton, title: '增加', onClick: () => onChange(Math.min(max, value + step)) }, '+'),
      )
    }

    function card(title, ...children) {
      return h('section', { style: P.card },
        h('div', { style: P.cardTitle }, title),
        ...children,
      )
    }

    /** Apply the Host's glossary caps while typing so the textarea never shows text that will be dropped. */
    function clampGlossaryText(text) {
      return text.split(/\r?\n/).slice(0, 200).map(line => line.slice(0, 120)).join('\n')
    }

    /** Sidebar glyph: a subtitle frame with two text lines, drawn in `currentColor`. */
    function PanelEntryIcon({ size }) {
      const edge = typeof size === 'number' ? size : 20
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M7 11h7M7 15h10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        }),
      )
    }

    /** The page the sidebar entry selects; it polls the Host while it is open. */
    function RtPage() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      // Background editors keep their own draft while focused so polling never
      // overwrites what is being typed. null means "follow the snapshot".
      const [bgDraft, setBgDraft] = useState(null)
      const [briefDraft, setBriefDraft] = useState(null)
      const [glossDraft, setGlossDraft] = useState(null)
      const [briefOpen, setBriefOpen] = useState(false)
      const [glossOpen, setGlossOpen] = useState(false)
      const [preparing, setPreparing] = useState(false)
      const [clearArmed, setClearArmed] = useState(false)

      const apply = useCallback(result => {
        if (result && result.ok && result.value) {
          setSnap(result.value)
          setError('')
          return
        }
        if (result && result.error) setError(result.error.message)
        else setError('控制页不可用')
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
        return h('div', { style: P.page },
          h('header', { style: P.head },
            h('div', null,
              h('h1', { style: P.title }, '实时翻译'),
              h('p', { style: P.intro }, '系统声音实时字幕'),
            ),
          ),
          h('section', { style: P.card },
            h('div', { style: S.muted }, error ? '未连接到插件' : '连接中…'),
            error ? h('div', { style: P.error }, error) : null,
            h('div', { style: P.row },
              h('button', { style: S.button, onClick: () => { void refresh() } }, '重试'),
            ),
          ),
        )
      }

      const state = snap.state
      const subtitle = snap.subtitle
      const segment = snap.segment || { silenceMs: 550, maxSegmentMs: 8000 }
      const autoPause = typeof snap.autoPauseAfterMs === 'number' ? snap.autoPauseAfterMs : 120000
      const running = state.phase === 'listening' || state.phase === 'preparing'
      const phaseLabel = PHASE_LABEL[state.phase] || state.phase
      const dotColor = PHASE_COLOR[state.phase] || PHASE_COLOR.idle

      const tr = snap.translate || {}
      const bg = bgDraft ?? tr.background ?? ''
      const brief = briefDraft ?? tr.backgroundBrief ?? ''
      // The draft is raw textarea text, not an array: derive the list from it while editing.
      const glossary = glossDraft === null
        ? (tr.glossary || [])
        : glossDraft.split(/\r?\n/).filter(line => line.trim() !== '')
      const glossText = glossDraft ?? glossary.join('\n')
      const glossaryCollapsed = glossary.length > 8 && !glossOpen

      const blurBackground = () => {
        if (bgDraft !== null) { void act('setBackground', bgDraft); setBgDraft(null) }
      }
      const blurBrief = () => {
        if (briefDraft !== null) { void act('setBrief', briefDraft); setBriefDraft(null) }
      }
      const blurGlossary = () => {
        if (glossDraft !== null) { void act('setGlossary', glossDraft.split(/\r?\n/)); setGlossDraft(null) }
      }
      const prepare = async () => {
        if (preparing || bg.trim() === '') return
        setPreparing(true)
        try {
          if (bgDraft !== null) await act('setBackground', bgDraft)
          await act('prepareGlossary')
        } finally {
          setPreparing(false)
          setBgDraft(null)
        }
      }
      const clearGlossary = () => {
        if (!clearArmed) {
          setClearArmed(true)
          window.setTimeout(() => setClearArmed(false), 3000)
          return
        }
        setClearArmed(false)
        setGlossDraft(null)
        void act('setGlossary', [])
      }
      const fieldStyle = { ...S.select, width: '100%', maxWidth: '100%', boxSizing: 'border-box', padding: '6px 8px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical', whiteSpace: 'pre' }

      const briefRow = briefOpen
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: P.row },
            h('span', { style: S.label }, '背景摘要'),
            h('span', { style: P.hint }, '会进每句 prompt'),
            h('button', { style: S.smallButton, title: '收起', onClick: () => { blurBrief(); setBriefOpen(false) } }, '×'),
          ),
          h('textarea', {
            rows: 3,
            value: brief,
            maxLength: 300,
            placeholder: '一两句话说清在听什么、谁是谁；留空则不注入',
            style: fieldStyle,
            onFocus: () => { if (briefDraft === null) setBriefDraft(tr.backgroundBrief || '') },
            onChange: event => setBriefDraft(event.target.value),
            onBlur: blurBrief,
          }),
        )
        : h('div', { style: P.row },
          h('span', { style: S.label }, '背景摘要'),
          h('span', { style: S.muted }, brief === '' ? '填背景后点准备词汇，或手写摘要' : `${brief.length} 字 · 会进 prompt`),
          h('button', { style: S.button, onClick: () => { setBriefOpen(true) } }, brief === '' ? '手写' : '改'),
        )

      const glossarySection = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: P.row },
          h('span', { style: S.label }, '术语'),
          h('span', { style: S.muted }, `${glossary.length} 条 · ${glossText.length} 字符`),
          glossary.length > 8
            ? h('button', { style: S.button, onClick: () => { if (glossOpen) blurGlossary(); setGlossOpen(!glossOpen) } }, glossOpen ? '收起' : '展开')
            : null,
          h('button', { style: S.button, onClick: clearGlossary }, clearArmed ? '确认清空？' : '清空术语'),
        ),
        glossaryCollapsed
          ? h('div', { style: P.hint }, `已折叠 ${glossary.length} 条术语；翻译时只注入本句出现的词条。`)
          : h('textarea', {
            rows: 6,
            value: glossText,
            spellCheck: false,
            placeholder: '每行一条「原文=译文」，例如 Hermione=赫敏',
            style: { ...fieldStyle, maxHeight: 240, overflowY: 'auto' },
            onFocus: () => { if (glossDraft === null) setGlossDraft(glossText) },
            onChange: event => setGlossDraft(clampGlossaryText(event.target.value)),
            onBlur: blurGlossary,
          }),
        !glossaryCollapsed && glossary.length === 0
          ? h('div', { style: P.hint }, '暂无术语，可手填，或先填背景再点「准备词汇」。')
          : null,
        h('div', { style: P.hint }, '最多 200 行、每行 120 字符，超出会即时截断；翻译时只注入本句出现的词条（≤12 条），空行与重复行会被忽略。'),
      )

      return h('div', { style: P.page },
        h('header', { style: P.head },
          h('div', { style: { minWidth: 0 } },
            h('h1', { style: P.title }, '实时翻译'),
          ),
          h('div', { style: P.headActions },
            h('span', { style: P.status },
              h('span', { style: { ...S.dot, background: dotColor } }),
              phaseLabel,
            ),
            h('button', {
              style: running ? S.primaryButton : S.button,
              title: running ? '停止（Ctrl+Alt+S）' : '开始（Ctrl+Alt+S）',
              onClick: () => { void act('toggle') },
            }, running ? '⏸ 停止' : '▶ 开始'),
          ),
        ),
        card('语言',
          h('div', { style: P.row },
            h('span', { style: S.label }, '源'),
            select(SOURCES, state.source, value => { void act('setSource', value) }),
            h('span', { style: S.arrow }, '→'),
            h('span', { style: S.label }, '目的'),
            select(TARGETS, state.target, value => { void act('setTarget', value) }),
          ),
        ),
        card('翻译背景',
          h('textarea', {
            rows: 2,
            value: bg,
            maxLength: 2000,
            placeholder: '例：看《哈利·波特与魔法石》／讨论 AI 大模型方案',
            style: fieldStyle,
            onFocus: () => { if (bgDraft === null) setBgDraft(tr.background || '') },
            onChange: event => setBgDraft(event.target.value),
            onBlur: blurBackground,
          }),
          h('div', { style: P.row },
            h('button', {
              style: S.button,
              disabled: bg.trim() === '' || preparing,
              onClick: () => { void prepare() },
            }, preparing ? '准备中…' : '准备词汇'),
            h('span', { style: P.hint }, '用当前翻译模型提炼背景并生成词表，生成后可修改'),
          ),
          briefRow,
          glossarySection,
          tr.glossaryError ? h('div', { style: P.error }, tr.glossaryError) : null,
        ),
        card('分段',
          h('div', { style: P.row },
            stepper('静音切分', segment.silenceMs, 100, 3000, 50, value => { void act('setSegment', { silenceMs: value }) }, value => `${value} ms`),
            stepper('单句最长', segment.maxSegmentMs, 1000, 15000, 500, value => { void act('setSegment', { maxSegmentMs: value }) }, value => `${(value / 1000).toFixed(1)} s`),
          ),
          h('div', { style: P.hint },
            '静音切分越短越灵敏，但短于正常停顿会把一句话切成两半；会议语音建议 500–800 ms。',
          ),
        ),
        card('字幕',
          h('div', { style: P.row },
            stepper('字号', subtitle.fontSize, 12, 96, 2, value => { void act('setFontSize', value) }),
            stepper('行数', subtitle.maxLines, 2, 5, 1, value => { void act('setSubtitle', { maxLines: value }) }),
          ),
          h('div', { style: P.row },
            h('span', { style: S.label }, '透明度'),
            h('input', {
              type: 'range',
              min: 0.2,
              max: 1,
              step: 0.01,
              value: subtitle.opacity,
              style: { width: 160, accentColor: 'var(--dsw-alias-brand-primary)' },
              onChange: event => { void act('setSubtitle', { opacity: Number(event.target.value) }) },
            }),
            h('span', { style: S.muted }, `${Math.round(subtitle.opacity * 100)}%`),
            h('span', { style: { width: 12 } }),
            h('span', { style: S.label }, '阅读'),
            select(READ_OPTIONS, subtitle.minReadMs, value => { void act('setSubtitle', { minReadMs: Number(value) }) }),
            h('label', { style: { ...P.row, marginLeft: 12 } },
              h('input', {
                type: 'checkbox',
                checked: subtitle.bilingual === true,
                onChange: event => { void act('setSubtitle', { bilingual: event.target.checked }) },
              }),
              h('span', { style: S.muted }, '显示原文'),
            ),
          ),
        ),
        card('自动暂停',
          h('div', { style: P.row },
            select(AUTO_PAUSE_OPTIONS, String(autoPause), value => { void act('setAutoPause', Number(value)) }),
            h('span', { style: S.muted }, '连续静音这么久后停止采集，按开始恢复'),
          ),
        ),
        card('操作',
          h('div', { style: P.row },
            h('button', { style: S.button, onClick: () => { void act('clear') } }, '清屏'),
            h('button', { style: S.button, onClick: () => { void act('restart') } }, '重连音频'),
            h('button', { style: S.button, onClick: () => { void act('prepare') } }, '准备模型'),
            h('button', {
              style: S.button,
              title: '切分、自动暂停与字幕恢复默认值（语言保持不变）',
              onClick: () => { void act('resetDefaults') },
            }, '默认配置'),
          ),
        ),
        h('section', { style: P.card },
          h('div', { style: P.footer },
            `识别: ${snap.stt}`,
            h('br'),
            `翻译: ${snap.translate.provider || '跟随默认'} / ${snap.translate.model || '自动'}`,
            snap.persistence ? null : h('span', null, h('br'), '设置未写入 profile（仅内存）'),
          ),
          state.error || error ? h('div', { style: P.error }, state.error || error) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The page and its sidebar entry share one id: the entry selects the panel.
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, RtPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          // Shipped panel rows pass a label function; the sidebar resolves it.
          label: () => '实时翻译',
        }, PanelEntryIcon))
      },
    }
  },
})
