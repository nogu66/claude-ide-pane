import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Change, DiffView, Editor, EditorProps, Problem, Problems, Tab, TodoItem } from '../types'
import {
  changesOutsideGit,
  clipDiff,
  groupByFile,
  mergeTodos,
  parseEslint,
  parseGitStatus,
  parseTodoLines,
  parseTsc,
  pushTrail,
  relativeTo,
  sortProblems,
} from './parse'

const PANE = 'ide-pane'
const TITLE = 'IDE'
const QUICK_POLL_MS = 15_000
const SETTLE_MS = 800
// 1 ファイルの差分はこの行数まで見せる
const MAX_DIFF_LINES = 80
// これより広いと一覧の右にエディタを並べる。狭いとエディタだけを出す
const SPLIT_MIN_COLUMNS = 76
// Client の props は 10 万文字まで。JSON にしたときの増分を見込んで余裕を取る
const MAX_EDITOR_CHARS = 90_000
const EDITOR_KEY = 'editor'

const tabAtom = atom({ plugin: 'ide-pane', key: 'tab' } as const, 'todo')
const todosAtom = atom({ plugin: 'ide-pane', key: 'todos' } as const, [])
const baselineAtom = atom({ plugin: 'ide-pane', key: 'baseline' } as const, null)
const problemsAtom = atom({ plugin: 'ide-pane', key: 'problems' } as const, {
  status: 'idle',
  items: [],
  trail: [],
  tools: [],
})
const changesAtom = atom({ plugin: 'ide-pane', key: 'changes' } as const, [])
const expandedAtom = atom({ plugin: 'ide-pane', key: 'expanded' } as const, [])
const diffsAtom = atom({ plugin: 'ide-pane', key: 'diffs' } as const, {})
const claudeFilesAtom = atom({ plugin: 'ide-pane', key: 'claudeFiles' } as const, [])
const touchAtom = atom({ plugin: 'ide-pane', key: 'touch' } as const, null)
const editorAtom = atom({ plugin: 'ide-pane', key: 'editor' } as const, null)

const TABS: Array<{ tab: Tab; label: string; hotkey: string }> = [
  { tab: 'todo', label: 'TODO', hotkey: '1' },
  { tab: 'problems', label: '問題', hotkey: '2' },
  { tab: 'changes', label: '変更', hotkey: '3' },
]

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// モジュールの変数は再読み込みで消える。消えても困らないものだけ置く
let settle: Timer | undefined
let isChecking = false
let isCheckAgain = false
let isProblemsDirty = true
// 一覧の行の key から、エディタで開く場所を引く。描くたびに作り直す
const rowTargets = new Map<string, { path: string; line: number }>()
let openSeq = 0
let focusedRow: { path: string; line: number } | undefined
let isNarrow = false

async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch {
    return undefined
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return (await run($, ['test', '-e', path], 5_000))?.exitCode === 0
}

async function refreshTodos($: EngineInterface): Promise<void> {
  const patterns = ['-e', 'TODO', '-e', 'FIXME', '-e', 'HACK', '-e', 'XXX']
  let out = await run($, [
    'rg', '--line-number', '--no-heading', '--with-filename', '--color', 'never',
    '--word-regexp', '--max-columns', '400', '--max-filesize', '1M',
    '--glob', '!*.min.*', '--glob', '!*.lock', '--glob', '!package-lock.json',
    // .gitignore の無いフォルダでも依存とビルド出力は数えない
    '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/build/**',
    '--glob', '!**/.next/**', '--glob', '!**/coverage/**', '--glob', '!**/out/**',
    ...patterns, '.',
  ])
  if (!out || out.exitCode > 1) {
    out = await run($, ['git', 'grep', '-n', '-I', '-w', ...patterns])
  }
  if (!out || out.exitCode > 1) return

  const found = parseTodoLines(out.stdout)
  const baseline = await read($, baselineAtom)
  const previous = await read($, todosAtom)
  const merged = mergeTodos(found, baseline, previous)
  await update($, baselineAtom, () => merged.baseline)
  await update($, todosAtom, () => merged.todos)
}

async function refreshChanges($: EngineInterface): Promise<void> {
  const claudeFiles = await read($, claudeFilesAtom)
  const out = await run($, ['git', 'status', '--porcelain=v1', '-z', '-uall'])
  const changes =
    out && out.exitCode === 0 ? parseGitStatus(out.stdout, claudeFiles) : changesOutsideGit(claudeFiles)
  await update($, changesAtom, () => changes)
  await refreshDiffs($, changes)
}

// 未追跡と git の外のファイルは、空のファイルとの差分にする
async function loadDiff($: EngineInterface, change: Change): Promise<DiffView> {
  const base = ['git', 'diff', '--no-color', '--no-ext-diff']
  const asNew = [...base, '--no-index', '--', '/dev/null', change.path]
  let out = await run($, change.status === 'U' || change.status === '•' ? asNew : [...base, 'HEAD', '--', change.path])
  // まだ一度もコミットしていないリポジトリには HEAD が無い
  if (out && out.exitCode > 1 && change.status !== 'D') out = await run($, asNew)
  if (!out || out.exitCode > 1) return { status: 'error', source: '', hidden: 0, firstLine: 1 }

  const clip = clipDiff(out.stdout, MAX_DIFF_LINES)
  if (clip.isBinary) return { status: 'binary', source: '', hidden: 0, firstLine: 1 }
  if (clip.source.length === 0) return { status: 'empty', source: '', hidden: 0, firstLine: 1 }

  return { status: 'ok', source: clip.source, hidden: clip.hidden, firstLine: clip.firstLine }
}

// 開いている差分を読み直す。変更でなくなったファイルは閉じる
async function refreshDiffs($: EngineInterface, changes: Change[]): Promise<void> {
  const expanded = await read($, expandedAtom)
  if (expanded.length === 0) return
  const open = changes.filter(change => expanded.includes(change.path))
  const loaded = await Promise.all(open.map(async change => [change.path, await loadDiff($, change)] as const))
  await update($, expandedAtom, () => open.map(change => change.path))
  await update($, diffsAtom, () => Object.fromEntries(loaded))
}

async function toggleDiff($: EngineInterface, change: Change): Promise<void> {
  const expanded = await read($, expandedAtom)
  if (expanded.includes(change.path)) {
    await update($, expandedAtom, paths => paths.filter(path => path !== change.path))
    await update($, diffsAtom, diffs => {
      const { [change.path]: _closed, ...rest } = diffs
      return rest
    })
    return
  }
  const diff = await loadDiff($, change)
  await update($, diffsAtom, diffs => ({ ...diffs, [change.path]: diff }))
  await update($, expandedAtom, paths => (paths.includes(change.path) ? paths : [...paths, change.path]))
}

async function localBin($: EngineInterface, name: string): Promise<string | undefined> {
  const path = `node_modules/.bin/${name}`

  return (await exists($, path)) ? path : undefined
}

async function hasEslintConfig($: EngineInterface): Promise<boolean> {
  const names = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  ]
  for (const name of names) if (await exists($, name)) return true

  return false
}

async function checkTsc($: EngineInterface, cwd: string): Promise<Problem[] | undefined> {
  if (!(await exists($, 'tsconfig.json'))) return undefined
  const tsc = await localBin($, 'tsc')
  const argv = [tsc ?? 'tsc']
  const out = await run($, [...argv, '--noEmit', '--pretty', 'false', '-p', '.'], 180_000)
  if (!out) return undefined

  return parseTsc(out.stdout, cwd)
}

async function checkEslint($: EngineInterface, cwd: string): Promise<Problem[] | undefined> {
  const eslint = await localBin($, 'eslint')
  if (!eslint || !(await hasEslintConfig($))) return undefined
  const out = await run($, [eslint, '--format', 'json', '.'], 180_000)
  if (!out) return undefined

  return parseEslint(out.stdout, cwd)
}

async function refreshProblems($: EngineInterface): Promise<void> {
  if (isChecking) {
    isCheckAgain = true
    return
  }
  isChecking = true
  isProblemsDirty = false
  try {
    await update($, problemsAtom, (p): Problems => ({ ...p, status: p.status === 'unavailable' ? p.status : 'running' }))
    const cwd = await $.session.cwd()
    const [tsc, eslint] = await Promise.all([checkTsc($, cwd), checkEslint($, cwd)])
    const tools = [tsc ? 'tsc' : '', eslint ? 'eslint' : ''].filter(name => name.length > 0)
    const items = sortProblems([...(tsc ?? []), ...(eslint ?? [])])
    await update($, problemsAtom, (p): Problems =>
      tools.length === 0
        ? { status: 'unavailable', items: [], trail: [], tools }
        : { status: 'idle', items, trail: pushTrail(p.trail, items.length), tools },
    )
  } finally {
    isChecking = false
  }
  if (isCheckAgain) {
    isCheckAgain = false
    await refreshProblems($)
  }
}

async function refreshQuick($: EngineInterface): Promise<void> {
  await Promise.all([refreshTodos($), refreshChanges($), reloadEditor($, false)])
}

async function refreshAll($: EngineInterface, isForced: boolean): Promise<void> {
  await refreshQuick($)
  if (isForced || isProblemsDirty) await refreshProblems($)
}

// 編集が続く間は待ち、落ち着いてからまとめて数え直す
function scheduleRefresh($: EngineInterface): void {
  isProblemsDirty = true
  settle?.cancel()
  settle = $.clock.after(SETTLE_MS, () => {
    void refreshAll($, false)
  })
}

function filePathOf(input: unknown): string | undefined {
  const fields = input as { file_path?: unknown; notebook_path?: unknown }
  const path = fields.file_path ?? fields.notebook_path

  return typeof path === 'string' && path.length > 0 ? path : undefined
}

async function openPane($: EngineInterface, tab?: Tab) {
  if (tab) await update($, tabAtom, () => tab)

  return $.ui.open({ id: PANE, title: TITLE })
}

function tabFromArgs(args: string): Tab | 'close' | undefined {
  const word = args.trim().toLowerCase()
  if (word === 'todo' || word === 't') return 'todo'
  if (word === 'problems' || word === 'p' || word === '問題') return 'problems'
  if (word === 'changes' || word === 'c' || word === '変更') return 'changes'
  if (word === 'close') return 'close'

  return undefined
}

function askTodo(todo: TodoItem): string {
  return `${todo.file}:${todo.line} の ${todo.tag}「${todo.text}」を片付けて。終わったらこのコメントも消して。`
}

function askProblem(problem: Problem): string {
  return `${problem.file}:${problem.line}:${problem.col} の ${problem.source} の${problem.severity === 'error' ? 'エラー' : '警告'}を直して: ${problem.message}`
}

function askAllProblems(problems: Problem[]): string {
  const lines = problems.slice(0, 30).map(p => `- ${p.file}:${p.line}:${p.col} ${p.source}: ${p.message}`)
  const rest = problems.length > 30 ? `\n…ほか ${problems.length - 30} 件` : ''

  return `次の ${problems.length} 件の問題を直して。直したら tsc と eslint が通ることを確かめて。\n${lines.join('\n')}${rest}`
}

async function fillPrompt($: EngineInterface, text: string, mode: 'replace' | 'insert' = 'replace') {
  const filled = await $.prompt.fill({ text, mode })
  $.ui.toast(filled.isFilled ? '入力欄に入れました。Esc で入力欄に戻り、Enter で送信' : '入力欄に入れられませんでした')
}

// 一覧のパスは作業フォルダからの相対。fs はプロセスの場所を基準にするので、絶対パスにして渡す
async function absolutePath($: EngineInterface, path: string): Promise<string> {
  if (path.startsWith('/')) return path
  const cwd = await $.session.cwd()

  return `${cwd.endsWith('/') ? cwd : `${cwd}/`}${path}`
}

async function loadText($: EngineInterface, path: string): Promise<Pick<Editor, 'text' | 'status'>> {
  try {
    const text = await $.fs.read(await absolutePath($, path))
    if (text.includes('\u0000')) return { text: '', status: 'binary' }
    if (text.length > MAX_EDITOR_CHARS) return { text: '', status: 'tooBig' }
    return { text, status: 'ok' }
  } catch {
    return { text: '', status: 'missing' }
  }
}

async function openEditor($: EngineInterface, path: string, line: number): Promise<void> {
  const current = await read($, editorAtom)
  if (current?.path === path) {
    await update($, editorAtom, editor => (editor ? { ...editor, line, jumpId: editor.jumpId + 1 } : editor))
    return
  }
  if (current?.isDirty) {
    $.ui.toast(`${current.path} が未保存です。⌃S で保存するか ⌃R で戻してから開いてください`)
    return
  }
  // 選ぶ行を素早く動かしたときは、最後に選んだファイルだけを開く
  const seq = ++openSeq
  const loaded = await loadText($, path)
  if (seq !== openSeq) return
  await update($, editorAtom, editor => ({
    path,
    line,
    jumpId: (editor?.jumpId ?? 0) + 1,
    version: (editor?.version ?? 0) + 1,
    isDirty: false,
    ...loaded,
  }))
}

// ディスクから読み直す。中身が変わったときだけ version を上げる
async function reloadEditor($: EngineInterface, isDiscarding: boolean): Promise<void> {
  const current = await read($, editorAtom)
  if (!current) return
  const loaded = await loadText($, current.path)
  await update($, editorAtom, editor => {
    if (!editor || editor.path !== current.path) return editor
    const isChanged = loaded.text !== editor.text || loaded.status !== editor.status
    if (!isChanged && !isDiscarding) return editor
    return {
      ...editor,
      ...loaded,
      version: isChanged ? editor.version + 1 : editor.version,
      isDirty: isDiscarding ? false : editor.isDirty,
    }
  })
}

async function closeEditor($: EngineInterface): Promise<void> {
  const current = await read($, editorAtom)
  if (current?.isDirty) {
    $.ui.toast(`${current.path} が未保存です。⌃S で保存するか ⌃R で戻してから閉じてください`)
    return
  }
  await update($, editorAtom, () => null)
}

type EditorMessage =
  | { type: 'save'; path: string; text: string }
  | { type: 'reload'; path: string }
  | { type: 'dirty'; path: string; isDirty: boolean }

// Client から届いたものはそのまま信じず、形を確かめる
function asEditorMessage(data: unknown): EditorMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const m = data as Record<string, unknown>
  if (typeof m.path !== 'string') return undefined
  if (m.type === 'save' && typeof m.text === 'string') return { type: 'save', path: m.path, text: m.text }
  if (m.type === 'reload') return { type: 'reload', path: m.path }
  if (m.type === 'dirty' && typeof m.isDirty === 'boolean') return { type: 'dirty', path: m.path, isDirty: m.isDirty }

  return undefined
}

async function handleEditorMessage($: EngineInterface, message: EditorMessage): Promise<void> {
  const current = await read($, editorAtom)
  if (!current || current.path !== message.path) return

  if (message.type === 'dirty') {
    await update($, editorAtom, editor => (editor ? { ...editor, isDirty: message.isDirty } : editor))
    return
  }
  if (message.type === 'reload') {
    await reloadEditor($, true)
    return
  }
  try {
    await $.fs.write(await absolutePath($, message.path), message.text)
  } catch (error) {
    $.ui.toast(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  await update($, editorAtom, (editor): Editor | null =>
    editor && editor.path === message.path
      ? { ...editor, text: message.text, version: editor.version + 1, isDirty: false, status: 'ok' }
      : editor,
  )
  $.ui.toast(`保存しました: ${message.path}`)
  scheduleRefresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'ide-pane',
      description: 'TODO・問題・変更のペインを開く（引数: todo / problems / changes / close）',
    })
    void openPane($)
    void refreshAll($, true)
    $.clock.every(QUICK_POLL_MS, () => {
      void refreshQuick($)
    })

    return started
  })

  on('command.run', { command: 'ide-pane' }, async ($, e) => {
    const word = tabFromArgs(e.args)
    if (word === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'IDE ペインを閉じました。' }
    }
    const opened = await openPane($, word)
    void refreshAll($, true)

    return { text: opened.isPlaced ? 'IDE ペインを開きました。' : `IDE ペインを開けませんでした: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isWrite = WRITE_TOOLS.has(tool)
    const absolute = isWrite || tool === 'Read' ? filePathOf(e) : undefined
    if (!absolute) {
      const ran = await next(e)
      if (tool === 'Bash') scheduleRefresh($)
      return ran
    }

    const path = relativeTo(await $.session.cwd(), absolute)
    await update($, touchAtom, () => ({ path, kind: isWrite ? 'write' : 'read', isLive: true }))
    const ran = await next(e)
    await update($, touchAtom, touch => (touch && touch.path === path ? { ...touch, isLive: false } : touch))
    if (isWrite && ran.deny === undefined && ran.isError !== true) {
      await update($, claudeFilesAtom, files => (files.includes(path) ? files : [...files, path]))
      if ((await read($, editorAtom))?.path === path) await reloadEditor($, false)
      scheduleRefresh($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // 一覧で行を選ぶと、そのファイルをエディタで開く
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    const target = e.element ? rowTargets.get(e.element) : undefined
    if (target && moved.deny === undefined) {
      focusedRow = target
      // 狭いときに開くと一覧が隠れるので、e を押したときだけ開く
      if (!isNarrow) await openEditor($, target.path, target.line)
    }

    return moved
  }).catch(($, e, next) => next(e))

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== EDITOR_KEY) return next(e)
    const message = asEditorMessage(e.data)
    if (message) await handleEditorMessage($, message)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table
    const editor = await read($, editorAtom)
    const columns = e.props.bodyColumns
    isNarrow = columns < SPLIT_MIN_COLUMNS
    rowTargets.clear()
    const tab = await read($, tabAtom)
    const todos = await read($, todosAtom)
    const problems = await read($, problemsAtom)
    const changes = await read($, changesAtom)
    const expanded = await read($, expandedAtom)
    const diffs = await read($, diffsAtom)
    const touch = await read($, touchAtom)

    // 行の key を覚えておき、選ばれたらそのファイルを開く
    const target = (key: string, path: string, line: number) => {
      rowTargets.set(key, { path, line })
      return key
    }

    const openTodos = todos.filter(todo => todo.state !== 'done').length

    const touchLine = touch ? (
      <Text dimColor={!touch.isLive} wrap="truncate-middle">
        <Text color={touch.kind === 'write' ? 'claude' : 'suggestion'}>{touch.isLive ? '●' : '○'}</Text>
        {` Claude ${touch.isLive ? (touch.kind === 'write' ? 'が書いています' : 'が読んでいます') : (touch.kind === 'write' ? 'が最後に書いた' : 'が最後に読んだ')}: ${touch.path}`}
      </Text>
    ) : (
      <Text dimColor>Claude はまだファイルに触っていません</Text>
    )

    const todoBody =
      todos.length === 0 ? (
        <Text dimColor>TODO・FIXME・HACK はありません</Text>
      ) : (
        <Box flexDirection="column">
          {groupByFile(todos).map(group => (
            <Box key={`todo-file:${group.file}`} flexDirection="column">
              <Text bold wrap="truncate-middle">{group.file}</Text>
              {group.items.map(todo =>
                todo.state === 'done' ? (
                  <Box key={`todo:${todo.file}:${todo.tag}:${todo.text}`} paddingLeft={2} flexDirection="row">
                    <Text dimColor strikethrough wrap="truncate-end">
                      {`${String(todo.line).padStart(4)}  ${todo.tag.padEnd(5)} ${todo.text}`}
                    </Text>
                    <Text color="success">  済</Text>
                  </Box>
                ) : (
                  <Box key={`todo:${todo.file}:${todo.tag}:${todo.text}`} paddingLeft={2}>
                    <Button
                      key={target(`todo-press:${todo.file}:${todo.line}:${todo.tag}`, todo.file, todo.line)}
                      plain
                      onPress={() => fillPrompt($, askTodo(todo))}
                    >
                      <Text dimColor>{String(todo.line).padStart(4)}</Text>
                      {'  '}
                      <Text color={todo.tag === 'FIXME' ? 'error' : todo.tag === 'HACK' ? 'merged' : 'warning'}>
                        {todo.tag.padEnd(5)}
                      </Text>
                      {` ${todo.text}`}
                      {todo.state === 'added' ? <Text color="success">  +新規</Text> : ''}
                    </Button>
                  </Box>
                ),
              )}
            </Box>
          ))}
        </Box>
      )

    const trail = problems.trail.length > 1 ? `  ${problems.trail.join(' → ')}` : ''
    const problemsBody =
      problems.status === 'unavailable' ? (
        <Text dimColor>tsconfig.json も eslint の設定も見つかりません</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor>{problems.tools.length > 0 ? problems.tools.join(' · ') : 'tsc · eslint'}</Text>
            <Text color="warning">{trail}</Text>
            {problems.status === 'running' ? <Text color="suggestion">  確認しています…</Text> : <Text> </Text>}
          </Box>
          {problems.items.length === 0 && problems.status === 'idle' ? (
            <Text color="success">問題はありません</Text>
          ) : (
            <Box flexDirection="column">
              <Button key="problems-all" plain hotkey="a" onPress={() => fillPrompt($, askAllProblems(problems.items))}>
                {`全部まとめて Claude に頼む（${problems.items.length} 件）`}
              </Button>
              {groupByFile(problems.items).map(group => (
                <Box key={`problem-file:${group.file}`} flexDirection="column">
                  <Text bold wrap="truncate-middle">{group.file}</Text>
                  {group.items.map(problem => (
                    <Box key={`problem:${problem.file}:${problem.line}:${problem.col}:${problem.message}`} paddingLeft={2}>
                      <Button
                        key={target(
                          `problem-press:${problem.file}:${problem.line}:${problem.col}:${problem.source}`,
                          problem.file,
                          problem.line,
                        )}
                        plain
                        onPress={() => fillPrompt($, askProblem(problem))}
                      >
                        <Text dimColor>{`${problem.line}:${problem.col}`.padStart(7)}</Text>
                        {'  '}
                        <Text color={problem.severity === 'error' ? 'error' : 'warning'}>
                          {problem.severity === 'error' ? '×' : '!'}
                        </Text>
                        {` ${problem.message} `}
                        <Text dimColor>{problem.source}</Text>
                      </Button>
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )

    const statusColor = (status: string) =>
      status === 'A' || status === 'U' ? 'success' : status === 'D' ? 'error' : status === 'R' ? 'suggestion' : 'warning'
    const changesBody =
      changes.length === 0 ? (
        <Text dimColor>変更はありません</Text>
      ) : (
        <Box flexDirection="column">
          {changes.map(change => {
            const isTouched = touch?.path === change.path
            const isOpen = expanded.includes(change.path)
            const diff = diffs[change.path]
            return (
              <Box key={`change:${change.path}`} flexDirection="column">
                <Button
                  key={target(`change-press:${change.path}`, change.path, diff?.firstLine ?? 1)}
                  plain
                  onPress={() => toggleDiff($, change)}
                >
                  <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                  <Text color={statusColor(change.status)}>{change.status}</Text>
                  {`  ${change.path}`}
                  {change.byClaude ? <Text color="claude">  Claude</Text> : ''}
                  {isTouched && touch?.isLive ? <Text color="claude" bold>  ← いまここ</Text> : ''}
                </Button>
                {isOpen ? (
                  <Box key={`diff:${change.path}`} flexDirection="column" paddingLeft={2} marginBottom={1}>
                    {!diff ? (
                      <Text dimColor>差分を読んでいます…</Text>
                    ) : diff.status === 'ok' ? (
                      <Code source={diff.source} format="diff" path={change.path} />
                    ) : (
                      <Text dimColor>
                        {diff.status === 'binary'
                          ? '文字のファイルではないので差分を出せません'
                          : diff.status === 'empty'
                            ? '差分はありません'
                            : '差分を取れませんでした'}
                      </Text>
                    )}
                    {diff && diff.hidden > 0 ? <Text dimColor>{`…ほか ${diff.hidden} 行`}</Text> : ''}
                    <Button
                      key={`change-mention:${change.path}`}
                      plain
                      dimColor
                      onPress={() => fillPrompt($, `@${change.path} `, 'insert')}
                    >
                      @ 入力欄に入れる
                    </Button>
                  </Box>
                ) : (
                  ''
                )}
              </Box>
            )
          })}
        </Box>
      )

    const counts: Record<Tab, string> = {
      todo: String(openTodos),
      problems: problems.status === 'unavailable' ? '-' : String(problems.items.length),
      changes: String(changes.length),
    }
    const tabs = (
      <Box flexDirection="row" gap={2}>
        {TABS.map(item => (
          <Button
            key={`tab:${item.tab}`}
            plain
            hotkey={item.hotkey}
            dimColor={item.tab !== tab}
            onPress={() => update($, tabAtom, () => item.tab)}
          >
            <Text bold={item.tab === tab}>{item.label}</Text> <Text dimColor>{counts[item.tab]}</Text>
          </Button>
        ))}
        <Button key="refresh" plain hotkey="r" dimColor onPress={() => refreshAll($, true)}>
          更新
        </Button>
      </Box>
    )

    const pick = isNarrow ? '↑↓ 選ぶ' : '↑↓ 選ぶと右に開く'
    const hint =
      tab === 'problems'
        ? `${pick} · Enter Claude に頼む · a 全部頼む · 1/2/3 切り替え · r 更新`
        : tab === 'changes'
          ? `${pick} · Enter 差分を開く・閉じる · 1/2/3 切り替え · r 更新`
          : `${pick} · Enter Claude に頼む · 1/2/3 切り替え · r 更新`

    const listBody = (
      <Box flexDirection="column" marginTop={1}>
        {tab === 'todo' ? todoBody : tab === 'problems' ? problemsBody : changesBody}
      </Box>
    )

    // 触った行・余白・案内の 4 行を除いた高さ
    const editorRows = Math.max(8, e.props.scroll.bodyRows - 4)
    const editorProps = (opened: Editor): EditorProps => ({
      path: opened.path,
      line: opened.line,
      jumpId: opened.jumpId,
      text: opened.text,
      version: opened.version,
    })
    const editorMessage = (opened: Editor) =>
      opened.status === 'missing'
        ? `${opened.path} を開けません（消えたか、読めません）`
        : opened.status === 'tooBig'
          ? `${opened.path} は大きすぎて開けません（${MAX_EDITOR_CHARS.toLocaleString()} 文字まで）`
          : opened.status === 'binary'
            ? `${opened.path} は文字のファイルではないので開けません`
            : `${opened.path} はこの画面では編集できません`
    const editorView = editor ? (
      <Box key="editor-frame" flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor>
        {editor.status === 'ok' && 'Client' in table ? (
          <table.Client
            key={EDITOR_KEY}
            module="./editor.tsx"
            props={editorProps(editor)}
            width="100%"
            height={editorRows - 2}
          />
        ) : (
          <Text dimColor>{editorMessage(editor)}</Text>
        )}
      </Box>
    ) : undefined

    const closeButton = (
      <Button key="editor-close" plain hotkey="x" dimColor onPress={() => closeEditor($)}>
        {isNarrow ? '閉じて一覧へ' : 'エディタを閉じる'}
      </Button>
    )
    const openButton = (
      <Button
        key="editor-open"
        plain
        hotkey="e"
        dimColor
        onPress={() => (focusedRow ? openEditor($, focusedRow.path, focusedRow.line) : undefined)}
      >
        選んだ行をエディタで開く
      </Button>
    )

    const body = !editorView ? (
      listBody
    ) : isNarrow ? (
      <Box flexDirection="column" marginTop={1}>
        {editorView}
      </Box>
    ) : (
      <Box flexDirection="row" gap={1}>
        <Box flexDirection="column" width={Math.min(44, Math.max(28, Math.round(columns * 0.38)))}>
          {listBody}
        </Box>
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {editorView}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {tabs}
        {touchLine}
        {body}
        <Box flexDirection="column" marginTop={1}>
          {editorView && isNarrow ? <Text dimColor>クリックで編集 · ⌃S 保存 · Esc でキーを戻す</Text> : <Text dimColor>{hint}</Text>}
          {editorView ? closeButton : isNarrow ? openButton : <Text> </Text>}
        </Box>
      </Box>
    )
  })
}
