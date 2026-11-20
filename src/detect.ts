/** Heuristic language identification for the five supported spoken languages. */
import type { Language } from './config.ts'

const HANGUL = /[\uAC00-\uD7AF]/
const KANA = /[\u3040-\u30FF]/
const HAN = /[\u4E00-\u9FFF]/
const LATIN = /[A-Za-z]/
const CANTONESE = new Set(['嘅', '咗', '喺', '唔', '啲', '佢', '乜', '嘢', '噉', '嚟'])

/** Return the most likely language of already-transcribed text, or `unknown`. */
export function detectLanguage(text: string): Language | 'unknown' {
  const chars = [...text].filter(ch => !/\s/.test(ch) && !/[!-/:-@[-`{-~，。！？、；：“”‘’（）《》]/.test(ch))
  if (chars.length === 0) return 'unknown'

  const hangul = chars.filter(ch => HANGUL.test(ch)).length
  if (hangul / chars.length > 0.2) return 'ko'

  if (chars.some(ch => KANA.test(ch))) return 'ja'

  const han = chars.filter(ch => HAN.test(ch)).length
  const latin = chars.filter(ch => LATIN.test(ch)).length
  const letters = han + latin
  if (han > 0 && han / letters > 0.2) {
    const hits = chars.filter(ch => CANTONESE.has(ch)).length
    return hits >= 2 ? 'yue' : 'zh'
  }

  if (latin / chars.length > 0.5) return 'en'
  return 'unknown'
}
