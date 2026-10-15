import type { EditorProps } from '../types'

// Client が持つ編集中のバッファ。col は行の中の文字（コードポイント）の位置
export type Buffer = {
  path: string
  version: number
  jumpId: number
  // 最後に知っているディスクの中身。これと違えば未保存
  base: string
  lines: string[]
  row: number
  col: number
  // 上下に動くときに戻りたい表示上の桁
  goal: number
  top: number
  left: number
  eol: '\n' | '\r\n'
  indent: string
  // 未保存のまま、ディスク側が書き換わった
  isConflict: boolean
}

export type Effect =
  | { type: 'save'; text: string }
  | { type: 'reload' }
  | { type: 'dirty'; isDirty: boolean }

export type KeyInput = { key: string; ctrl?: true; shift?: true; meta?: true }

export const TAB_CELLS = 2

const SPECIAL_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function cellsOf(ch: string): number {
  if (ch === '\t') return TAB_CELLS

  return isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
}

export function charsOf(line: string): string[] {
  return Array.from(line)
}

export function cellsUntil(line: string, col: number): number {
  let cells = 0
  for (const ch of charsOf(line).slice(0, col)) cells += cellsOf(ch)

  return cells
}

// 表示上の桁から、そこに一番近い文字の位置を返す
export function colAtCells(line: string, cells: number): number {
  const chars = charsOf(line)
  let at = 0
  for (let i = 0; i < chars.length; i++) {
    const width = cellsOf(chars[i] ?? '')
    if (at + width > cells) return i
    at += width
  }

  return chars.length
}

export function textOf(buf: Buffer): string {
  return buf.lines.join(buf.eol)
}

export function isDirty(buf: Buffer): boolean {
  return textOf(buf) !== buf.base
}

function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n' } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  return { lines: text.split(eol), eol }
}

function firstNonSpace(line: string): number {
  const match = /^\s*/.exec(line)

  return match ? charsOf(match[0]).length : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function fromProps(props: EditorProps): Buffer {
  const { lines, eol } = splitLines(props.text)
  const row = clamp(props.line - 1, 0, lines.length - 1)
  const col = firstNonSpace(lines[row] ?? '')

  return {
    path: props.path,
    version: props.version,
    jumpId: props.jumpId,
    base: props.text,
    lines,
    row,
    col,
    goal: cellsUntil(lines[row] ?? '', col),
    // 開いた行が上から 3 行目あたりに来るようにする
    top: Math.max(0, row - 3),
    left: 0,
    eol,
    indent: lines.some(line => line.startsWith('\t')) ? '\t' : '  ',
    isConflict: false,
  }
}

// フックから新しい props が来たときに、バッファをそれに合わせる
export function syncProps(buf: Buffer, props: EditorProps): Buffer {
  if (props.path !== buf.path) return fromProps(props)

  let next = buf
  if (props.version !== buf.version) {
    if (!isDirty(buf)) {
      const { lines, eol } = splitLines(props.text)
      const row = clamp(buf.row, 0, lines.length - 1)
      next = {
        ...buf,
        version: props.version,
        base: props.text,
        lines,
        eol,
        row,
        col: clamp(buf.col, 0, charsOf(lines[row] ?? '').length),
        isConflict: false,
      }
    } else if (props.text === textOf(buf)) {
      // 自分の保存が戻ってきた
      next = { ...buf, version: props.version, base: props.text, isConflict: false }
    } else {
      next = { ...buf, version: props.version, isConflict: true }
    }
  }
  if (props.jumpId !== next.jumpId) {
    const row = clamp(props.line - 1, 0, next.lines.length - 1)
    const col = firstNonSpace(next.lines[row] ?? '')
    next = { ...next, jumpId: props.jumpId, row, col, goal: cellsUntil(next.lines[row] ?? '', col), top: Math.max(0, row - 3) }
  }

  return next
}

// ディスクの中身で置き換える（⌃R）
export function reloadFrom(buf: Buffer, text: string): Buffer {
  const { lines, eol } = splitLines(text)
  const row = clamp(buf.row, 0, lines.length - 1)

  return {
    ...buf,
    base: text,
    lines,
    eol,
    row,
    col: clamp(buf.col, 0, charsOf(lines[row] ?? '').length),
    isConflict: false,
  }
}

function withCol(buf: Buffer, row: number, col: number): Buffer {
  return { ...buf, row, col, goal: cellsUntil(buf.lines[row] ?? '', col) }
}

function moveVertical(buf: Buffer, delta: number): Buffer {
  const row = clamp(buf.row + delta, 0, buf.lines.length - 1)

  return { ...buf, row, col: colAtCells(buf.lines[row] ?? '', buf.goal) }
}

function insertText(buf: Buffer, text: string): Buffer {
  const chars = charsOf(buf.lines[buf.row] ?? '')
  const pieces = text.replace(/\r\n?/g, '\n').split('\n')
  const head = chars.slice(0, buf.col).join('')
  const tail = chars.slice(buf.col).join('')
  if (pieces.length === 1) {
    const lines = [...buf.lines]
    lines[buf.row] = head + text + tail
    return withCol({ ...buf, lines }, buf.row, buf.col + charsOf(text).length)
  }
  const first = pieces[0] ?? ''
  const last = pieces[pieces.length - 1] ?? ''
  const middle = pieces.slice(1, -1)
  const lines = [
    ...buf.lines.slice(0, buf.row),
    head + first,
    ...middle,
    last + tail,
    ...buf.lines.slice(buf.row + 1),
  ]
  const row = buf.row + pieces.length - 1

  return withCol({ ...buf, lines }, row, charsOf(last).length)
}

function newline(buf: Buffer): Buffer {
  const line = buf.lines[buf.row] ?? ''
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  // 行頭の空白の途中で改行したときは、字下げを足さない
  const keep = buf.col >= charsOf(indent).length ? indent : ''

  return insertText(buf, `\n${keep}`)
}

function backspace(buf: Buffer): Buffer {
  if (buf.col > 0) {
    const chars = charsOf(buf.lines[buf.row] ?? '')
    chars.splice(buf.col - 1, 1)
    const lines = [...buf.lines]
    lines[buf.row] = chars.join('')
    return withCol({ ...buf, lines }, buf.row, buf.col - 1)
  }
  if (buf.row === 0) return buf
  const above = buf.lines[buf.row - 1] ?? ''
  const lines = [...buf.lines]
  lines.splice(buf.row - 1, 2, above + (buf.lines[buf.row] ?? ''))

  return withCol({ ...buf, lines }, buf.row - 1, charsOf(above).length)
}

function deleteForward(buf: Buffer): Buffer {
  const chars = charsOf(buf.lines[buf.row] ?? '')
  if (buf.col < chars.length) {
    chars.splice(buf.col, 1)
    const lines = [...buf.lines]
    lines[buf.row] = chars.join('')
    return { ...buf, lines }
  }
  if (buf.row >= buf.lines.length - 1) return buf
  const lines = [...buf.lines]
  lines.splice(buf.row, 2, (buf.lines[buf.row] ?? '') + (buf.lines[buf.row + 1] ?? ''))

  return { ...buf, lines }
}

function isTyped(event: KeyInput): boolean {
  if (event.ctrl || event.meta) return false
  if (SPECIAL_KEYS.has(event.key)) return false
  // f1 や pagedown のような、名前で来る特殊キーは書き込まない
  if (charsOf(event.key).length > 1 && /^[a-z][a-z0-9]*$/.test(event.key)) return false

  return event.key.length > 0
}

// キーを 1 つ受け取り、次のバッファと、フックに知らせることを返す
export function applyKey(buf: Buffer, event: KeyInput, pageRows: number): { buf: Buffer; effect?: Effect } {
  const line = buf.lines[buf.row] ?? ''
  const length = charsOf(line).length
  const wasDirty = isDirty(buf)
  let next = buf

  if (event.ctrl && event.key === 's') return { buf, effect: { type: 'save', text: textOf(buf) } }
  if (event.ctrl && event.key === 'r') return { buf, effect: { type: 'reload' } }

  if (event.ctrl && event.key === 'a') next = withCol(buf, buf.row, 0)
  else if (event.ctrl && event.key === 'e') next = withCol(buf, buf.row, length)
  else if (event.key === 'left') {
    next = buf.col > 0 ? withCol(buf, buf.row, buf.col - 1)
      : buf.row > 0 ? withCol(buf, buf.row - 1, charsOf(buf.lines[buf.row - 1] ?? '').length) : buf
  } else if (event.key === 'right') {
    next = buf.col < length ? withCol(buf, buf.row, buf.col + 1)
      : buf.row < buf.lines.length - 1 ? withCol(buf, buf.row + 1, 0) : buf
  } else if (event.key === 'up') next = moveVertical(buf, -1)
  else if (event.key === 'down') next = moveVertical(buf, 1)
  else if (event.key === 'pageup') next = moveVertical(buf, -Math.max(1, pageRows - 1))
  else if (event.key === 'pagedown') next = moveVertical(buf, Math.max(1, pageRows - 1))
  else if (event.key === 'home') {
    // 1 回目は字下げの後ろへ、もう 1 回で行頭へ
    const start = firstNonSpace(line)
    next = withCol(buf, buf.row, buf.col === start ? 0 : start)
  } else if (event.key === 'end') next = withCol(buf, buf.row, length)
  else if (event.key === 'return' || event.key === 'enter') next = newline(buf)
  else if (event.key === 'backspace') next = backspace(buf)
  else if (event.key === 'delete') next = deleteForward(buf)
  else if (event.key === 'tab') next = insertText(buf, buf.indent)
  else if (isTyped(event)) next = insertText(buf, event.key)

  if (next === buf) return { buf }
  const isNowDirty = next.lines !== buf.lines ? isDirty(next) : wasDirty

  return isNowDirty !== wasDirty ? { buf: next, effect: { type: 'dirty', isDirty: isNowDirty } } : { buf: next }
}

// クリックした位置にカーソルを置く。y と x は本文の左上からの位置
export function clickAt(buf: Buffer, y: number, x: number): Buffer {
  const row = clamp(buf.top + y, 0, buf.lines.length - 1)

  return withCol(buf, row, colAtCells(buf.lines[row] ?? '', buf.left + Math.max(0, x)))
}

// カーソルが見えるように top と left をずらす
export function ensureVisible(buf: Buffer, rows: number, cols: number): Buffer {
  const viewRows = Math.max(1, rows)
  const viewCols = Math.max(4, cols)
  let top = buf.top
  if (buf.row < top) top = buf.row
  if (buf.row >= top + viewRows) top = buf.row - viewRows + 1
  top = clamp(top, 0, Math.max(0, buf.lines.length - 1))

  const cursor = cellsUntil(buf.lines[buf.row] ?? '', buf.col)
  let left = buf.left
  if (cursor < left) left = Math.max(0, cursor - Math.floor(viewCols / 4))
  if (cursor >= left + viewCols) left = cursor - viewCols + Math.floor(viewCols / 4)

  return top === buf.top && left === buf.left ? buf : { ...buf, top, left }
}

export function gutterWidth(buf: Buffer): number {
  return String(buf.lines.length).length + 1
}

// 1 行のうち、left から cols 桁分を切り出す。タブは空白に置き換える
export function sliceCells(line: string, left: number, cols: number): string {
  let at = 0
  let out = ''
  for (const ch of charsOf(line)) {
    const width = cellsOf(ch)
    if (at + width > left + cols) break
    if (at >= left) out += ch === '\t' ? ' '.repeat(TAB_CELLS) : ch
    else if (at + width > left) out += ' '.repeat(at + width - left)
    at += width
  }

  return out
}
