import type { Change, ChangeStatus, Problem, TodoItem, TodoTag } from '../types'

export type FoundTodo = Omit<TodoItem, 'state'>

const MAX_TODOS = 300
const MAX_PROBLEMS = 300

// コメントの印の後ろにある TODO だけを拾う。`const TODO_RE` のようなコードは拾わない
const TODO_IN_COMMENT =
  /(?:\/\/|\/\*|^\s*\*|#|<!--|^\s*--|;)[^\n]*?\b(TODO|FIXME|HACK|XXX)\b[\s:：()\[\]-]*(.*)$/

export function relativeTo(cwd: string, path: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  const plain = path.startsWith('./') ? path.slice(2) : path

  return plain.startsWith(base) ? plain.slice(base.length) : plain
}

export function todoKey(todo: Pick<TodoItem, 'file' | 'tag' | 'text'>): string {
  return `${todo.file}\u0000${todo.tag}\u0000${todo.text}`
}

// rg / git grep の `path:line:content` を読む
export function parseTodoLines(stdout: string): FoundTodo[] {
  const found: FoundTodo[] = []

  for (const raw of stdout.split('\n')) {
    const row = /^(.+?):(\d+):(.*)$/.exec(raw)
    if (!row) continue
    const [, file, line, content] = row
    const hit = TODO_IN_COMMENT.exec(content ?? '')
    if (!hit || !file || !line) continue
    const text = (hit[2] ?? '')
      .replace(/\s*(\*\/\s*\}?|-->)\s*$/, '')
      .trim()
    found.push({
      file: file.startsWith('./') ? file.slice(2) : file,
      line: Number(line),
      tag: hit[1] as TodoTag,
      text: text.length > 0 ? text : '（本文なし）',
    })
    if (found.length >= MAX_TODOS) break
  }

  return found
}

// 初回は今ある分を基準にし、以後は基準との差で「新規」と「済」を付ける
export function mergeTodos(
  found: FoundTodo[],
  baseline: string[] | null,
  previous: TodoItem[],
): { todos: TodoItem[]; baseline: string[] } {
  const keys = found.map(todoKey)
  if (baseline === null) {
    return {
      todos: sortByFile(found.map(todo => ({ ...todo, state: 'base' as const }))),
      baseline: [...new Set(keys)],
    }
  }

  const known = new Set(baseline)
  const present = new Set(keys)
  const todos: TodoItem[] = found.map(todo => ({
    ...todo,
    state: known.has(todoKey(todo)) ? 'base' : 'added',
  }))
  for (const before of previous) {
    const key = todoKey(before)
    if (before.state === 'added' || present.has(key) || !known.has(key)) continue
    todos.push({ ...before, state: 'done' })
  }

  return { todos: sortByFile(todos), baseline }
}

function sortByFile<T extends { file: string; line: number }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  )
}

// tsc --pretty false: `src/a.ts(12,5): error TS2322: ...`
export function parseTsc(stdout: string, cwd: string): Problem[] {
  const problems: Problem[] = []
  for (const raw of stdout.split('\n')) {
    const row = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.*)$/.exec(raw)
    if (!row) continue
    const [, file, line, col, severity, message] = row
    problems.push({
      file: relativeTo(cwd, file ?? ''),
      line: Number(line),
      col: Number(col),
      severity: severity === 'warning' ? 'warning' : 'error',
      source: 'tsc',
      message: message ?? '',
    })
    if (problems.length >= MAX_PROBLEMS) break
  }

  return problems
}

type EslintFile = {
  filePath?: string
  messages?: Array<{ line?: number; column?: number; severity?: number; message?: string; ruleId?: string | null }>
}

// eslint --format json
export function parseEslint(stdout: string, cwd: string): Problem[] {
  let files: EslintFile[]
  try {
    const parsed: unknown = JSON.parse(stdout)
    files = Array.isArray(parsed) ? (parsed as EslintFile[]) : []
  } catch {
    return []
  }

  const problems: Problem[] = []
  for (const file of files) {
    for (const message of file.messages ?? []) {
      problems.push({
        file: relativeTo(cwd, file.filePath ?? ''),
        line: message.line ?? 0,
        col: message.column ?? 0,
        severity: message.severity === 2 ? 'error' : 'warning',
        source: 'eslint',
        message: message.ruleId ? `${message.message ?? ''} (${message.ruleId})` : (message.message ?? ''),
      })
      if (problems.length >= MAX_PROBLEMS) return problems
    }
  }

  return problems
}

export function sortProblems(problems: Problem[]): Problem[] {
  return sortByFile(problems)
}

function statusOf(xy: string): ChangeStatus {
  if (xy === '??') return 'U'
  const letter = xy[1] !== ' ' ? xy[1] : xy[0]
  if (letter === 'A') return 'A'
  if (letter === 'D') return 'D'
  if (letter === 'R' || letter === 'C') return 'R'

  return 'M'
}

// git status --porcelain=v1 -z -uall。名前変更は後ろに元の名前が続く
export function parseGitStatus(stdout: string, claudeFiles: string[]): Change[] {
  const claude = new Set(claudeFiles)
  const entries = stdout.split('\0')
  const changes: Change[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    if (xy.includes('R') || xy.includes('C')) i++
    changes.push({ path, status: statusOf(xy), byClaude: claude.has(path) })
  }

  return sortByPath(changes)
}

export function changesOutsideGit(claudeFiles: string[]): Change[] {
  return sortByPath(claudeFiles.map(path => ({ path, status: '•' as const, byClaude: true })))
}

function sortByPath(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export type DiffClip = {
  source: string
  // 見せなかった変更の行数
  hidden: number
  // 最初の hunk の新しい側の行番号
  firstLine: number
  isBinary: boolean
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

function countLines(hunk: string[]): number {
  return hunk.filter(line => !line.startsWith('@@') && !line.startsWith('\\')).length
}

// 途中で切った hunk は見出しの行数を数え直す。合わないと Code が差分として読まない
function reheader(hunk: string[]): string[] {
  const head = HUNK_HEAD.exec(hunk[0] ?? '')
  if (!head) return hunk
  const body = hunk.slice(1)
  const oldCount = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const newCount = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length

  return [`@@ -${head[1]},${oldCount} +${head[2]},${newCount} @@${head[3] ?? ''}`, ...body]
}

// git diff の出力から hunk だけを取り出し、maxLines 行までに hunk 単位で切る
export function clipDiff(raw: string, maxLines: number): DiffClip {
  if (/^Binary files .* differ$/m.test(raw)) return { source: '', hidden: 0, firstLine: 1, isBinary: true }

  const hunks: string[][] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) hunks.push([line])
    else if (hunks.length > 0 && /^[ +\-\\]/.test(line)) hunks[hunks.length - 1]?.push(line)
  }
  const first = HUNK_HEAD.exec(hunks[0]?.[0] ?? '')
  const firstLine = Math.max(1, Number(first?.[2] ?? 1))

  const kept: string[][] = []
  let shown = 0
  for (const hunk of hunks) {
    const size = countLines(hunk)
    if (shown + size <= maxLines) {
      kept.push(hunk)
      shown += size
      continue
    }
    if (kept.length === 0) {
      const cut = reheader(hunk.slice(0, maxLines + 1))
      kept.push(cut)
      shown += countLines(cut)
    }
    break
  }
  const total = hunks.reduce((sum, hunk) => sum + countLines(hunk), 0)

  return { source: kept.flat().join('\n'), hidden: total - shown, firstLine, isBinary: false }
}

export function pushTrail(trail: number[], count: number): number[] {
  if (trail[trail.length - 1] === count) return trail

  return [...trail, count].slice(-6)
}

export function groupByFile<T extends { file: string }>(items: T[]): Array<{ file: string; items: T[] }> {
  const groups: Array<{ file: string; items: T[] }> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.file === item.file) last.items.push(item)
    else groups.push({ file: item.file, items: [item] })
  }

  return groups
}
