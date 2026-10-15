import type { ClientModule } from 'claude-code'

import type { EditorProps } from '../types'
import {
  applyKey,
  cellsOf,
  cellsUntil,
  charsOf,
  clickAt,
  ensureVisible,
  fromProps,
  gutterWidth,
  isDirty,
  reloadFrom,
  sliceCells,
  syncProps,
  type Buffer,
} from './editing'

// 枠の上の見出し 1 行と、下の案内 1 行
const CHROME_ROWS = 2

const Editor: ClientModule<EditorProps, Buffer> = (props, surface) => {
  const { Box, Text, Code } = surface.elements
  const known = surface.state ?? fromProps(props)
  const buf = syncProps(known, props)
  if (buf !== surface.state) surface.setState(buf)

  const rows = Math.max(3, (surface.rows || 20) - CHROME_ROWS)
  const gutter = gutterWidth(buf)
  const cols = Math.max(4, (surface.columns || 60) - gutter)

  surface.onKey(event => {
    const current = surface.state ?? buf
    const { buf: keyed, effect } = applyKey(current, event, rows)
    const next = effect?.type === 'reload' ? reloadFrom(keyed, props.text) : keyed
    surface.setState(ensureVisible(next, rows, cols))
    if (effect?.type === 'save') surface.post({ type: 'save', path: buf.path, text: effect.text })
    if (effect?.type === 'reload') surface.post({ type: 'reload', path: buf.path })
    if (effect?.type === 'dirty') surface.post({ type: 'dirty', path: buf.path, isDirty: effect.isDirty })
  })

  surface.onPointer(event => {
    if (event.type !== 'down' || (event.button !== undefined && event.button !== 'left')) return
    const y = event.y - 1
    if (y < 0 || y >= rows) return
    const current = surface.state ?? buf
    surface.setState(ensureVisible(clickAt(current, y, event.x - gutter), rows, cols))
  })

  const view = ensureVisible(buf, rows, cols)
  const shown = view.lines.slice(view.top, view.top + rows)
  const cursorAt = view.row - view.top
  const slice = (line: string) => sliceCells(line, view.left, cols)
  const above = shown.slice(0, Math.max(0, cursorAt)).map(slice)
  const below = shown.slice(cursorAt + 1).map(slice)

  // カーソルの行は自分で描き、カーソルの 1 文字だけ反転させる
  const cursorLine = view.lines[view.row] ?? ''
  const beforeCursor = slice(charsOf(cursorLine).slice(0, view.col).join(''))
  const cursorChar = charsOf(cursorLine)[view.col] ?? ' '
  const usedCells = cellsUntil(beforeCursor, charsOf(beforeCursor).length) + cellsOf(cursorChar)
  const afterCursor = sliceCells(charsOf(cursorLine).slice(view.col + 1).join(''), 0, Math.max(0, cols - usedCells))

  const numbers = shown.map((_, i) => String(view.top + i + 1).padStart(gutter - 1))
  const filler = Math.max(0, rows - shown.length)
  const isChanged = isDirty(view)

  // 空の Code は描かない。カーソルの行は常に見えている（ensureVisible の後）
  const body = [
    ...(above.length > 0 ? [<Code key="above" source={above.join('\n')} path={view.path} wrap="truncate-end" />] : []),
    <Text key="cursor" wrap="truncate-end">
      {beforeCursor}
      <Text inverse>{cursorChar === '\t' ? ' ' : cursorChar}</Text>
      {afterCursor}
    </Text>,
    ...(below.length > 0 ? [<Code key="below" source={below.join('\n')} path={view.path} wrap="truncate-end" />] : []),
  ]

  const status = view.isConflict ? (
    <Text color="warning"> Claude が書き換えました · ⌃S 上書き · ⌃R 読み直す</Text>
  ) : isChanged ? (
    <Text color="warning"> ● 未保存</Text>
  ) : (
    <Text dimColor> 保存済み</Text>
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold wrap="truncate-middle">{view.path}</Text>
        {status}
      </Box>
      <Box flexDirection="row">
        <Box flexDirection="column" width={gutter}>
          {numbers.map((number, i) =>
            i === cursorAt ? (
              <Text key={`n:${i}`} color="claude">
                {number}
              </Text>
            ) : (
              <Text key={`n:${i}`} dimColor>
                {number}
              </Text>
            ),
          )}
          {Array.from({ length: filler }, (_, i) => (
            <Text key={`f:${i}`} dimColor>
              ~
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">クリックで編集 · ⌃S 保存 · ⌃R 読み直す · Esc 一覧へ</Text>
        <Text dimColor>{`${view.row + 1}:${view.col + 1}`}</Text>
      </Box>
    </Box>
  )
}

export default Editor
