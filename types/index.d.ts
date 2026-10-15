export type Tab = 'todo' | 'problems' | 'changes'

export type TodoTag = 'TODO' | 'FIXME' | 'HACK' | 'XXX'

// base: セッション開始時からあった / added: 途中で増えた / done: 途中で消えた
export type TodoState = 'base' | 'added' | 'done'

export type TodoItem = {
  file: string
  line: number
  tag: TodoTag
  text: string
  state: TodoState
}

export type Problem = {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning'
  source: 'tsc' | 'eslint'
  message: string
}

export type ProblemsStatus = 'idle' | 'running' | 'unavailable'

export type Problems = {
  status: ProblemsStatus
  items: Problem[]
  // 件数の移り変わり（12 → 3 → 0）。直近 6 回まで
  trail: number[]
  tools: string[]
}

// U: 未追跡 / A: 追加 / M: 変更 / D: 削除 / R: 名前変更 / •: git の外で Claude が書いた
export type ChangeStatus = 'U' | 'A' | 'M' | 'D' | 'R' | '•'

export type Change = {
  path: string
  status: ChangeStatus
  byClaude: boolean
}

// 変更タブで開いた差分。empty: 差分が無い / error: git が答えなかった
export type DiffView = {
  status: 'ok' | 'binary' | 'empty' | 'error'
  source: string
  hidden: number
  firstLine: number
}

export type Touch = {
  path: string
  kind: 'read' | 'write'
  isLive: boolean
}

// missing: 開けない / tooBig: Client に渡せる大きさを超える / binary: 文字のファイルではない
export type EditorStatus = 'ok' | 'missing' | 'tooBig' | 'binary'

export type Editor = {
  path: string
  // 開いた行。jumpId が変わるたびにカーソルをここへ動かす
  line: number
  jumpId: number
  // ディスク上の中身。version は中身が変わるたびに増える
  text: string
  version: number
  status: EditorStatus
  // Client が知らせてくる未保存の印
  isDirty: boolean
}

// Client に渡す props
export type EditorProps = {
  path: string
  line: number
  jumpId: number
  text: string
  version: number
}

declare module 'claude-code' {
  interface PluginState {
    'ide-pane': {
      tab: Tab
      todos: TodoItem[]
      baseline: string[] | null
      problems: Problems
      changes: Change[]
      // 差分を開いているファイルと、その差分
      expanded: string[]
      diffs: Record<string, DiffView>
      claudeFiles: string[]
      touch: Touch | null
      editor: Editor | null
    }
  }
}
