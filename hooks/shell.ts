// Just enough shell grammar to name the programs a command runs and the files
// it writes: quote-aware words that remember whether they were operators,
// comments, here-documents, command substitutions, wrapper commands (sudo,
// timeout, env, xargs, find -exec, …) and `sh -c` / `eval` / `env -S` scripts.

export type Token = { text: string; isOp: boolean }
export type Sub = { body: string; at: number }
export type Lexed = { tokens: Token[]; subs: Sub[] }
export type Invocation = { name: string; args: string[] }

const SPLIT = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '{', '}', '!'])

// Reads a $( … ) body starting just after "$(", honouring nested parens and quotes.
function substitution(command: string, start: number): { body: string; end: number } {
  let depth = 1
  let quote: string | null = null
  for (let i = start; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '\\') i += 1
    else if (ch === '(') depth += 1
    else if (ch === ')' && (depth -= 1) === 0) return { body: command.slice(start, i), end: i }
  }
  return { body: command.slice(start), end: command.length }
}

export function lex(command: string): Lexed {
  const tokens: Token[] = []
  const subs: Sub[] = []
  const heredocs: { delimiter: string; isQuoted: boolean }[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  let wordQuoted = false

  const flush = () => {
    if (started) tokens.push({ text: word, isOp: false })
    word = ''
    started = false
    wordQuoted = false
  }
  const op = (text: string) => {
    flush()
    tokens.push({ text, isOp: true })
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < command.length) word += command[(i += 1)]!
      else if (ch === '$' && command[i + 1] === '(') {
        const sub = substitution(command, i + 2)
        subs.push({ body: sub.body, at: tokens.length })
        word += `$(${sub.body})`
        i = sub.end
      } else if (ch === '`') {
        const end = command.indexOf('`', i + 1)
        subs.push({ body: command.slice(i + 1, end < 0 ? undefined : end), at: tokens.length })
        i = end < 0 ? command.length : end
      } else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      wordQuoted = true
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[(i += 1)]!
      started = true
      continue
    }
    // A comment runs to the end of the line, only where a word could start.
    if (ch === '#' && !started) {
      const end = command.indexOf('\n', i)
      i = end < 0 ? command.length : end - 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      const sub = substitution(command, i + 2)
      subs.push({ body: sub.body, at: tokens.length })
      word += `$(${sub.body})`
      started = true
      i = sub.end
      continue
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1)
      subs.push({ body: command.slice(i + 1, end < 0 ? undefined : end), at: tokens.length })
      i = end < 0 ? command.length : end
      started = true
      continue
    }
    // <( … ) and >( … ): a command whose output (or input) stands in for a file.
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      const sub = substitution(command, i + 2)
      subs.push({ body: sub.body, at: tokens.length })
      word += `${ch}(${sub.body})`
      started = true
      i = sub.end
      continue
    }
    if (ch === '\n') {
      op('\n')
      // Here-document bodies follow the line that opened them.
      for (const doc of heredocs.splice(0)) {
        const lines = command.slice(i + 1).split('\n')
        let consumed = 0
        const body: string[] = []
        for (const line of lines) {
          consumed += line.length + 1
          if (line.replace(/^\t+/, '') === doc.delimiter) break
          body.push(line)
        }
        if (!doc.isQuoted) for (const line of body) for (const sub of lex(line).subs) subs.push({ body: sub.body, at: tokens.length })
        i += consumed
      }
      continue
    }
    const three = command.slice(i, i + 3)
    if (three === '<<-' || command.slice(i, i + 2) === '<<') {
      flush()
      i += three === '<<-' ? 3 : 2
      while (command[i] === ' ') i += 1
      const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(i))
      if (match !== null) {
        heredocs.push({ delimiter: match[2]!, isQuoted: match[1] !== '' })
        i += match[0].length - 1
      }
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '|&') {
      op('|')
      i += 1
      continue
    }
    if (two === '&&' || two === '||') {
      op(two)
      i += 1
      continue
    }
    if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      // "2>", "&>", ">>", ">|", ">&file": one redirect operator; the fd digit is not a word.
      if (/^\d+$/.test(word) && !wordQuoted) {
        word = ''
        started = false
      }
      flush()
      let j = ch === '&' ? i + 2 : i + 1
      if (command[j] === '>') j += 1
      if (command[j] === '|') j += 1
      if (command[j] === '&' && !/\d|-/.test(command[j + 1] ?? '')) j += 1
      tokens.push({ text: '>', isOp: true })
      i = j - 1
      continue
    }
    if (ch === '<') {
      op('<')
      continue
    }
    if (';|&()!'.includes(ch) || ((ch === '{' || ch === '}') && !started && /[\s;]|$/.test(command[i + 1] ?? ''))) {
      op(ch)
      continue
    }
    word += ch
    started = true
  }
  flush()
  return { tokens, subs }
}

// Simple commands, each with its words and the redirect targets it writes; and
// which ones share a pipeline.
export type Segment = { words: string[]; writes: string[]; reads: string[]; subs: string[]; pipe: number; level: number }

export function parse(command: string): { segments: Segment[]; subs: string[] } {
  const { tokens, subs } = lex(command)
  const segments: Segment[] = []
  let pipe = 0
  let level = 0
  const fresh = (): Segment => ({ words: [], writes: [], reads: [], subs: [], pipe, level })
  let current = fresh()
  const segOf: number[] = []
  const close = (joinsPipe: boolean) => {
    if (current.words.length > 0 || current.writes.length > 0 || current.reads.length > 0) segments.push(current)
    if (!joinsPipe) pipe += 1
    current = fresh()
  }
  for (let i = 0; i < tokens.length; i += 1) {
    segOf[i] = segments.length
    const token = tokens[i]!
    if (!token.isOp) {
      current.words.push(token.text)
    } else if (token.text === '>' || token.text === '<') {
      const target = tokens[i + 1]
      if (target !== undefined && !target.isOp) {
        ;(token.text === '>' ? current.writes : current.reads).push(target.text)
        segOf[i + 1] = segments.length
        i += 1
      }
    } else if (SPLIT.has(token.text)) {
      close(token.text === '|')
      if (token.text === '(') level += 1
      if (token.text === ')') level = Math.max(0, level - 1)
      current.level = level
    }
  }
  close(false)
  // Each substitution runs as part of the command it sits in.
  for (const sub of subs) {
    const index = Math.min(segOf[sub.at] ?? segments.length - 1, segments.length - 1)
    const owner = segments[Math.max(0, index)]
    if (owner !== undefined) owner.subs.push(sub.body)
  }
  return { segments, subs: segments.length === 0 ? subs.map(sub => sub.body) : [] }
}

const base = (word: string) => (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.exe$/, '')

// For each wrapper: options that take a value, and how many plain words come before the wrapped command.
type Grammar = { valued: Set<string>; leading?: number }
const WRAPPERS: Record<string, Grammar> = {
  sudo: { valued: new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-R', '-T']) },
  doas: { valued: new Set(['-u', '-C']) },
  env: { valued: new Set(['-u', '-C', '--unset', '--chdir']) },
  timeout: { valued: new Set(['-s', '-k', '--signal', '--kill-after']), leading: 1 },
  nice: { valued: new Set(['-n', '--adjustment']) },
  ionice: { valued: new Set(['-c', '-n', '-p']) },
  stdbuf: { valued: new Set(['-i', '-o', '-e']) },
  nohup: { valued: new Set() },
  command: { valued: new Set() },
  builtin: { valued: new Set() },
  exec: { valued: new Set(['-a']) },
  time: { valued: new Set(['-f', '-o']) },
  xargs: { valued: new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a']) },
  watch: { valued: new Set(['-n', '-d']) },
  npx: { valued: new Set(['-p', '--package']) },
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])

// The programs one simple command runs, unwrapping wrappers and following scripts.
// `cwd` is the directory a wrapper like `env -C` moves the wrapped command to.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])

export function invocations(words: string[], depth = 0): (Invocation & { chdir?: string })[] {
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || KEYWORDS.has(words[i]!))) i += 1
  if (i >= words.length || depth > 4) return []
  const name = base(words[i]!)
  const args = words.slice(i + 1)

  const grammar = WRAPPERS[name]
  if (grammar !== undefined) {
    let j = 0
    let chdir: string | undefined
    let script: string | undefined
    while (j < args.length) {
      const arg = args[j]!
      if (arg === '--') {
        j += 1
        break
      }
      if (!arg.startsWith('-') || arg === '-') break
      if (name === 'env' && (arg === '-C' || arg === '--chdir')) chdir = args[j + 1]
      if (name === 'env' && arg.startsWith('--chdir=')) chdir = arg.slice(8)
      if (name === 'env' && /^-C./.test(arg)) chdir = arg.slice(2)
      if (name === 'env' && (arg === '-S' || arg === '--split-string')) {
        script = args[j + 1]
        break
      }
      if (name === 'env' && arg.startsWith('-S') && arg.length > 2) {
        script = arg.slice(2)
        break
      }
      j += grammar.valued.has(arg) ? 2 : 1
    }
    if (script !== undefined) {
      const inner = scriptInvocations(script, depth + 1).map(run => (chdir !== undefined ? { ...run, chdir } : run))
      return [{ name, args }, ...inner]
    }
    while (j < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j]!)) j += 1
    j += grammar.leading ?? 0
    const inner = invocations(args.slice(j), depth + 1).map(run => (chdir !== undefined && run.chdir === undefined ? { ...run, chdir } : run))
    return [{ name, args }, ...inner]
  }
  if (name === 'busybox') return invocations(args, depth + 1)
  if (name === 'eval') return [{ name, args }, ...scriptInvocations(args.join(' '), depth + 1)]
  if (name === 'find') {
    const out: Invocation[] = [{ name, args }]
    args.forEach((arg, k) => {
      if (arg === '-exec' || arg === '-execdir' || arg === '-ok') {
        const end = args.findIndex((word, m) => m > k && (word === ';' || word === '+'))
        out.push(...invocations(args.slice(k + 1, end < 0 ? undefined : end), depth + 1))
      }
    })
    return out
  }
  if (SHELLS.has(name)) {
    const flag = args.findIndex(arg => /^-[A-Za-z]*c$/.test(arg) || /^-(command|c)$/i.test(arg))
    const script = flag >= 0 ? args[flag + 1] : undefined
    return [{ name, args }, ...(script === undefined ? [] : scriptInvocations(script, depth + 1))]
  }
  return [{ name, args }]
}

export function scriptInvocations(command: string, depth = 0): Invocation[] {
  const { segments, subs } = parse(command)
  const nested = [...subs, ...segments.flatMap(segment => segment.subs)]
  return [...segments.flatMap(segment => invocations(segment.words, depth)), ...nested.flatMap(sub => scriptInvocations(sub, depth + 1))]
}

// The first argument that is not an option (skipping the values of the options named).
export function subcommand(args: string[], valued: Set<string> = new Set()): { word: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (valued.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    return { word: arg, rest: args.slice(i + 1) }
  }
  return null
}

// The scripts a simple command hands to another shell (sh -c, eval, env -S), for walking in order.
export function innerScripts(words: string[]): string[] {
  const runs = invocations(words)
  const out: string[] = []
  for (const run of runs) {
    if (run.name === 'eval') out.push(run.args.join(' '))
    if (SHELLS.has(run.name)) {
      const flag = run.args.findIndex(arg => /^-[A-Za-z]*c$/.test(arg) || /^-(command|c)$/i.test(arg))
      const script = flag >= 0 ? run.args[flag + 1] : undefined
      if (script !== undefined) out.push(script)
    }
    if (run.name === 'env') {
      const flag = run.args.findIndex(arg => arg === '-S' || arg === '--split-string')
      if (flag >= 0 && run.args[flag + 1] !== undefined) out.push(run.args[flag + 1]!)
      const glued = run.args.find(arg => /^-S./.test(arg))
      if (glued !== undefined) out.push(glued.slice(2))
    }
  }
  return out
}
