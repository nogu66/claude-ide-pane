import { expect, mock, test } from 'claude-code/testing'

import { applyKey, fromProps, sliceCells, syncProps, textOf } from '../hooks/editing'
import {
  clipDiff,
  mergeTodos,
  parseEslint,
  parseGitStatus,
  parseTodoLines,
  parseTsc,
  pushTrail,
  relativeTo,
} from '../hooks/parse'

const CWD = '/repo'

const PANE = {
  plugin: 'ide-pane',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'ide-pane',
  props: {
    title: 'IDE',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RG_OUT = [
  'src/api/client.ts:12:  // TODO: リトライ回数を設定に出す',
  'src/api/client.ts:30:const TODO_RE = /x/',
  './src/lib/date.ts:31:# HACK タイムゾーン決め打ち',
  'src/ui/Button.tsx:9:  {/* FIXME disabled の見た目 */}',
].join('\n')

test('TODO はコメントの中だけを拾い、閉じ記号を落とす', () => {
  expect(parseTodoLines(RG_OUT)).toEqual([
    { file: 'src/api/client.ts', line: 12, tag: 'TODO', text: 'リトライ回数を設定に出す' },
    { file: 'src/lib/date.ts', line: 31, tag: 'HACK', text: 'タイムゾーン決め打ち' },
    { file: 'src/ui/Button.tsx', line: 9, tag: 'FIXME', text: 'disabled の見た目' },
  ])
})

test('基準との差で新規と済が付き、行がずれても同じ TODO とみなす', () => {
  const first = mergeTodos(parseTodoLines(RG_OUT), null, [])
  expect(first.todos.every(todo => todo.state === 'base')).toBe(true)

  const next = parseTodoLines(
    [
      'src/api/client.ts:14:  // TODO: リトライ回数を設定に出す',
      'src/api/client.ts:48:  // FIXME: タイムアウトが効かない',
      'src/lib/date.ts:31:# HACK タイムゾーン決め打ち',
    ].join('\n'),
  )
  const merged = mergeTodos(next, first.baseline, first.todos)
  const states = merged.todos.map(todo => `${todo.file}:${todo.line}:${todo.state}`)
  expect(states).toEqual([
    'src/api/client.ts:14:base',
    'src/api/client.ts:48:added',
    'src/lib/date.ts:31:base',
    'src/ui/Button.tsx:9:done',
  ])
})

test('tsc と eslint の出力を作業フォルダからの相対パスにする', () => {
  expect(parseTsc("/repo/src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", CWD)).toEqual([
    { file: 'src/a.ts', line: 3, col: 7, severity: 'error', source: 'tsc', message: "Type 'string' is not assignable to type 'number'." },
  ])
  const eslint = JSON.stringify([
    { filePath: '/repo/src/b.ts', messages: [{ line: 2, column: 1, severity: 1, message: 'Unexpected console', ruleId: 'no-console' }] },
  ])
  expect(parseEslint(eslint, CWD)).toEqual([
    { file: 'src/b.ts', line: 2, col: 1, severity: 'warning', source: 'eslint', message: 'Unexpected console (no-console)' },
  ])
  expect(parseEslint('not json', CWD)).toEqual([])
})

test('git status の名前変更と未追跡を読み、Claude が書いた印を付ける', () => {
  const out = [' M src/a.ts', 'R  src/new.ts', 'src/old.ts', '?? notes.md', ' D gone.ts', ''].join('\0')
  expect(parseGitStatus(out, ['src/a.ts'])).toEqual([
    { path: 'gone.ts', status: 'D', byClaude: false },
    { path: 'notes.md', status: 'U', byClaude: false },
    { path: 'src/a.ts', status: 'M', byClaude: true },
    { path: 'src/new.ts', status: 'R', byClaude: false },
  ])
})

test('件数の移り変わりは同じ数を重ねず 6 回まで', () => {
  expect(pushTrail([12, 3], 3)).toEqual([12, 3])
  expect(pushTrail([9, 8, 7, 6, 5, 4], 0)).toEqual([8, 7, 6, 5, 4, 0])
})

// 道具の入力の型が深すぎて tsc が展開しきれないので、呼び口だけ緩める
function callTool($: unknown, input: Record<string, unknown>) {
  return ($ as { tool: { call: (input: unknown) => Promise<unknown> } }).tool.call(input)
}

const CLIENT_DIFF = [
  'diff --git a/src/api/client.ts b/src/api/client.ts',
  'index 1111111..2222222 100644',
  '--- a/src/api/client.ts',
  '+++ b/src/api/client.ts',
  '@@ -10,3 +10,3 @@ export async function getJson(url: string) {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  '',
].join('\n')

const NEW_FILE_DIFF = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const x = 1',
  '+export const y = 2',
  '',
].join('\n')

test('差分は hunk だけを取り出し、途中で切った hunk は見出しを数え直す', () => {
  const clip = clipDiff(CLIENT_DIFF, 80)
  expect(clip.source.split('\n')[0]).toBe('@@ -10,3 +10,3 @@ export async function getJson(url: string) {')
  expect([clip.hidden, clip.firstLine, clip.isBinary]).toEqual([0, 10, false])

  const two = `${CLIENT_DIFF}@@ -40,2 +40,3 @@\n a\n+b\n c\n`
  const first = clipDiff(two, 5)
  expect(first.source).not.toContain('@@ -40')
  expect(first.hidden).toBe(3)

  const cut = clipDiff('@@ -1,4 +1,4 @@\n a\n-b\n+c\n d\n e\n', 3)
  expect(cut.source).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c')
  expect(cut.hidden).toBe(2)

  expect(clipDiff('Binary files a/x.png and b/x.png differ\n', 80).isBinary).toBe(true)
})

// Code は key を持たないので、差分を包む Box の中から探す
async function diffOf(ui: { find: (q: { key: string }) => Promise<{ children: unknown[] } | undefined> }, path: string) {
  const box = await ui.find({ key: `diff:${path}` })
  const code = box?.children.find(
    (child): child is { type: string; props: Record<string, unknown> } =>
      typeof child === 'object' && child !== null && (child as { type?: unknown }).type === 'Code',
  )

  return code?.props
}

function fakeRun(argv: readonly string[]) {
  const ok = (stdout: string, exitCode = 0) => ({
    exitCode,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })
  if (argv[0] === 'rg') return ok(RG_OUT)
  if (argv[0] === 'git' && argv[1] === 'status') return ok([' M src/api/client.ts', '?? src/new.ts', ''].join('\0'))
  if (argv[0] === 'git' && argv[1] === 'diff') {
    // 未追跡は空のファイルとの差分で、違いがあると終了コードは 1
    return argv.includes('--no-index') ? ok(NEW_FILE_DIFF, 1) : ok(CLIENT_DIFF)
  }
  // tsconfig.json も eslint もないフォルダ
  if (argv[0] === 'test') return ok('', 1)

  return ok('', 127)
}

test('ペイン: タブを切り替え、行を選ぶと入力欄に依頼が入る', async ($, on) => {
  const filled: string[] = []
  mock.clock(on)
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', ($, e) => ({ value: fakeRun(e.argv) }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ key: 'tab:todo' }))?.text).toContain('TODO 3')
  expect((await ui.find({ key: 'tab:problems' }))?.text).toContain('問題 -')
  expect((await ui.find({ key: 'tab:changes' }))?.text).toContain('変更 2')
  // 開いているタブの中身だけを出す
  expect(await ui.find({ key: 'change-press:src/new.ts' })).toBeUndefined()

  await ui.press({ key: 'todo-press:src/api/client.ts:12:TODO' })
  expect(filled[0]).toBe('src/api/client.ts:12 の TODO「リトライ回数を設定に出す」を片付けて。終わったらこのコメントも消して。')

  await ui.press({ key: 'tab:problems' })
  expect(await ui.find({ type: 'Text', text: /tsconfig\.json も eslint の設定も見つかりません/ })).toBeDefined()

  // 変更の行は差分を開閉し、開いた中のボタンで @ファイルを入れる
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'change-press:src/new.ts' })
  const code = await diffOf(ui, 'src/new.ts')
  expect(code?.format).toBe('diff')
  expect(String(code?.source)).toBe('@@ -0,0 +1,2 @@\n+export const x = 1\n+export const y = 2')
  expect((await ui.find({ key: 'change-press:src/new.ts' }))?.text).toContain('▾')

  await ui.press({ key: 'change-mention:src/new.ts' })
  expect(filled[1]).toBe('@src/new.ts ')

  await ui.press({ key: 'change-press:src/api/client.ts' })
  expect(String((await diffOf(ui, 'src/api/client.ts'))?.source)).toContain('+const b = 3')

  await ui.press({ key: 'change-press:src/new.ts' })
  expect(await diffOf(ui, 'src/new.ts')).toBeUndefined()
  expect(await diffOf(ui, 'src/api/client.ts')).toBeDefined()
  await ui.unmount()
})

test('Claude の編集を検知して、変更に印と「いまここ」を出す', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', ($, e) => ({ value: fakeRun(e.argv) }))
  on('tool.call', () => ({ result: {} as never }))

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab:changes' })
  await callTool($, {
    tool: 'Edit',
    file_path: '/repo/src/api/client.ts',
    old_string: 'a',
    new_string: 'b',
  })
  await ui.press({ key: 'refresh' })

  const row = await ui.find({ key: 'change-press:src/api/client.ts' })
  expect(row?.text).toContain('Claude')
  expect(row?.text).not.toContain('いまここ')
  expect(await ui.find({ type: 'Text', text: /Claude が最後に書いた: src\/api\/client\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('エディタ: 打った文字と改行の字下げ、改行コードを保って保存する', () => {
  let buf = fromProps({ path: 'a.ts', line: 2, jumpId: 1, text: 'one\r\n  two\r\nthree', version: 1 })
  expect([buf.row, buf.col]).toEqual([1, 2])

  const typed = applyKey(buf, { key: 'キャ' }, 10)
  expect(typed.effect).toEqual({ type: 'dirty', isDirty: true })
  buf = applyKey(typed.buf, { key: 'return' }, 10).buf
  expect(buf.lines).toEqual(['one', '  キャ', '  two', 'three'])
  expect([buf.row, buf.col]).toEqual([2, 2])

  // 名前で来る特殊キーは書き込まない
  expect(applyKey(buf, { key: 'f5' }, 10).buf).toBe(buf)
  expect(applyKey(buf, { key: 's', ctrl: true }, 10).effect).toEqual({
    type: 'save',
    text: 'one\r\n  キャ\r\n  two\r\nthree',
  })

  // 元に戻すと未保存の印が消える
  let back = applyKey(buf, { key: 'backspace' }, 10).buf
  back = applyKey(back, { key: 'backspace' }, 10).buf
  back = applyKey(back, { key: 'backspace' }, 10).buf
  const undone = applyKey(applyKey(back, { key: 'backspace' }, 10).buf, { key: 'backspace' }, 10)
  expect(textOf(undone.buf)).toBe('one\r\n  two\r\nthree')
  expect(undone.effect).toEqual({ type: 'dirty', isDirty: false })
})

test('エディタ: ディスク側が変わったとき、未保存なら上書きせず印を付ける', () => {
  const props = { path: 'a.ts', line: 1, jumpId: 1, text: 'a\nb', version: 1 }
  const clean = fromProps(props)
  expect(syncProps(clean, { ...props, text: 'a\nb\nc', version: 2 }).lines).toEqual(['a', 'b', 'c'])

  const dirty = applyKey(clean, { key: 'x' }, 10).buf
  const conflicted = syncProps(dirty, { ...props, text: 'z', version: 2 })
  expect(conflicted.isConflict).toBe(true)
  expect(conflicted.lines).toEqual(['xa', 'b'])

  // 自分の保存が戻ってきたときは印を付けない
  const saved = syncProps(dirty, { ...props, text: 'xa\nb', version: 2 })
  expect(saved.isConflict).toBe(false)
  expect(saved.base).toBe('xa\nb')
})

test('エディタ: 全角文字の途中で切れる桁は空白で埋める', () => {
  expect(sliceCells('あいう', 1, 3)).toBe(' い')
  expect(sliceCells('\tab', 0, 3)).toBe('  a')
})

const CLIENT_TS = Array.from({ length: 15 }, (_, i) =>
  i === 11 ? '  // TODO: リトライ回数を設定に出す' : `const line${i + 1} = ${i + 1}`,
).join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`ペイン（${surface}）: 行を選ぶと右に開き、書き換えて ⌃S で保存する`, async ($, on) => {
    const files: Record<string, string> = { 'src/api/client.ts': CLIENT_TS }
    const written: Array<{ path: string; text: string }> = []
    const toasts: string[] = []
    mock.clock(on)
    on('session.cwd', () => ({ value: CWD }))
    on('process.run', ($, e) => ({ value: fakeRun(e.argv) }))
    // 試験では下で受ける者がいないので、輪が動いたことにする
    on('ui.focus', () => ({}))
    on('fs.read', ($, e) => ({ value: files[relativeTo(CWD, e.path)] ?? '' }))
    on('fs.write', ($, e) => {
      written.push({ path: relativeTo(CWD, e.path), text: e.text })
      files[relativeTo(CWD, e.path)] = e.text
      return { value: undefined }
    })
    on('ui.toast', ($, e) => {
      toasts.push(String(e.text))
      return { value: undefined }
    })
    on('tool.call', () => ({ result: {} as never }))

    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } })
    await ui.press({ key: 'refresh' })
    await $.ui.focus({ component: 'Pane', requestId: 'ide-pane', element: 'todo-press:src/api/client.ts:12:TODO', origin: { kind: 'person' } })
    await ui.redraw()
    expect(await ui.find({ key: 'editor' })).toBeDefined()

    await ui.resize({ columns: 60, rows: 12, in: 'editor' })
    expect(await ui.find({ in: 'editor', text: /12:3/ })).toBeDefined()
    await ui.key({ key: 'X', in: 'editor' })
    expect(await ui.find({ in: 'editor', text: /未保存/ })).toBeDefined()
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    expect(written[0]?.path).toBe('src/api/client.ts')
    expect(written[0]?.text.split('\n')[11]).toBe('  X// TODO: リトライ回数を設定に出す')
    expect(toasts).toContain('保存しました: src/api/client.ts')
    expect(await ui.find({ in: 'editor', text: /保存済み/ })).toBeDefined()

    // 未保存のまま Claude が同じファイルを書いたら、上書きせずに知らせる
    await ui.key({ key: 'Y', in: 'editor' })
    files['src/api/client.ts'] = `${CLIENT_TS}\n// Claude`
    await callTool($, { tool: 'Edit', file_path: '/repo/src/api/client.ts', old_string: 'a', new_string: 'b' })
    expect(await ui.find({ in: 'editor', text: /Claude が書き換えました/ })).toBeDefined()
    await ui.key({ key: 'r', ctrl: true, in: 'editor' })
    expect(await ui.find({ in: 'editor', text: /保存済み/ })).toBeDefined()
    await ui.unmount()
  })
}

test('ペイン: 狭いときは選んでも開かず、e で開いて x で一覧へ戻る', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', ($, e) => ({ value: fakeRun(e.argv) }))
  // 試験では下で受ける者がいないので、輪が動いたことにする
  on('ui.focus', () => ({}))
  on('fs.read', () => ({ value: CLIENT_TS }))

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  await ui.press({ key: 'refresh' })
  await $.ui.focus({ component: 'Pane', requestId: 'ide-pane', element: 'todo-press:src/api/client.ts:12:TODO', origin: { kind: 'person' } })
  await ui.redraw()
  expect(await ui.find({ key: 'editor' })).toBeUndefined()

  await ui.press({ key: 'editor-open' })
  expect(await ui.find({ key: 'editor' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ key: 'todo-press:src/api/client.ts:12:TODO' })).toBeUndefined()

  await ui.press({ key: 'editor-close' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect(await ui.find({ key: 'todo-press:src/api/client.ts:12:TODO' })).toBeDefined()
  await ui.unmount()
})
