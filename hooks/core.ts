import type { PluginOptions } from 'claude-code'

import type { Hit } from '../types'
import { defang, footer, header, sanitizeSource } from './sanitize'
import { innerScripts, invocations, parse, scriptInvocations, subcommand } from './shell'
import type { Invocation } from './shell'

// Programs whose output is someone else's text, matched on argv0 (any path, any case).
const FETCHERS = new Set([
  'curl', 'wget', 'xh', 'http', 'https', 'httpie', 'lynx', 'w3m', 'aria2c', 'ssh', 'nc',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
])
// Remote only with a host:path operand; otherwise a local copy.
const HOST_COPIERS = new Set(['scp', 'rsync'])
// Remote only when fetching a named package version or a URL; `npx tsc` runs a local bin.
const RUNNERS = new Set(['npx', 'bunx'])
// Flags that only print about the tool itself.
const SELF_INFO = new Set(['--version', '-V', '--help', '-h', '--manual', '-M'])
// Programs whose arguments are text, not files they read.
const NON_READERS = new Set(['echo', 'printf', 'touch', 'rm', 'mkdir', 'rmdir', 'test', '[', 'chmod', 'chown', 'export', 'true', 'false'])
const isHostPath = (arg: string) => /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/.test(arg) && !/^[A-Za-z]:[\\/]/.test(arg)
// gh subcommands that print or save other people's text, and the second level where one is needed.
const GH_REMOTE: Record<string, Set<string> | null> = {
  issue: new Set(['view', 'list', 'status', 'comment']),
  pr: new Set(['view', 'diff', 'list', 'status', 'checks', 'comment']),
  release: new Set(['view', 'list', 'download']),
  gist: new Set(['view', 'clone', 'list']),
  discussion: null,
  run: new Set(['view', 'watch', 'download']),
  repo: new Set(['view']),
  search: null,
  api: null,
}
const GH_VALUED = new Set(['-R', '--repo', '--hostname'])
const PKG_INFO = new Set(['view', 'info', 'show', 'dlx'])
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun'])
const COPIERS = new Set(['cp', 'mv', 'install', 'ln', 'scp', 'rsync', 'copy-item', 'move-item'])
const EXTRACTORS = new Set(['tar', 'unzip', 'bsdtar', '7z'])
// Programs that read a whole directory they are pointed at (or the cwd when given none).
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'find', 'tree'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const URL = /^https?:\/\//i

// Options that take a value, per program, so their values are not mistaken for files.
const VALUED: Record<string, Set<string>> = {
  scp: new Set(['-o', '-i', '-P', '-F', '-c', '-l', '-S', '-J']),
  rsync: new Set(['-e', '--rsh', '-f', '--filter', '--include', '--exclude', '--exclude-from', '--include-from', '--files-from', '--password-file', '--port', '-T', '--temp-dir', '-B', '--block-size']),
  cp: new Set(['-t', '--target-directory', '-S', '--suffix']),
  mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
  install: new Set(['-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix']),
  ln: new Set(['-t', '--target-directory', '-S', '--suffix']),
  rg: new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '-r', '--replace', '-j', '--threads', '-M', '--max-columns']),
  grep: new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '-d', '-D']),
  ag: new Set(['-G', '--file-search-regex', '-A', '-B', '-C', '-m', '--ignore']),
  fd: new Set(['-e', '--extension', '-t', '--type', '-E', '--exclude', '-d', '--max-depth']),
  find: new Set(),
}
// Options after which every plain operand is a path (the pattern was given as an option).
const PATTERN_OPTS = new Set(['-e', '--regexp', '-f', '--file'])
// Short curl/wget flags that take a value: in a cluster they end the flags.
const CURL_VALUED = new Set('HdXuAeFTbcKmrwxyYzEUCD'.split(''))
const WGET_VALUED = new Set('oaiBtTwPUelQY'.split(''))

const VENDORED =
  /(^|\/)(node_modules|vendor|bower_components|Pods|\.venv|venv|site-packages|dist-packages|third_party|third-party|\.cargo\/registry|go\/pkg\/mod|\.m2\/repository|\.gradle\/caches)(\/|$)/i

const HOME_DOWNLOADS = /^\/(?:users|home)\/[^/]+\/downloads(\/|$)/

export type Call = { tool: string; [k: string]: unknown }
// What classification needs about the session: files fetched so far (a trailing
// "/" marks a whole directory), and where relative paths point.
export type Context = { tainted: readonly string[]; cwd: string; home?: string }
const NO_CONTEXT: Context = { tainted: [], cwd: '/' }

const short = (text: string, room = 60) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > room ? `${line.slice(0, room - 1)}…` : line
}

export function trustedServers(options: PluginOptions): Set<string> {
  return new Set(
    String(options.trustedMcpServers ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  )
}

// Absolute, with ~, $HOME, . and .. resolved and macOS /private aliases folded,
// so two spellings of one path compare equal.
export function normalize(path: string, ctx: { cwd: string; home?: string }): string {
  let full = path.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, '~')
  if (full === '~' || full.startsWith('~/')) full = (ctx.home ?? '~') + full.slice(1)
  full = full.replace(/\\/g, '/')
  if (!full.startsWith('/') && !/^[A-Za-z]:\//.test(full)) full = `${ctx.cwd.replace(/\/$/, '')}/${full}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  // macOS file systems ignore case and Unicode normalization; compare that way everywhere.
  const out = `/${parts.join('/')}`.normalize('NFC').toLowerCase()
  return out.replace(/^\/private\/(tmp|var|etc)(?=\/|$)/, '/$1')
}

const baseName = (path: string) => {
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1) || 'index.html'
}
const remotePath = (operand: string) => operand.replace(/^[^/]*:/, '')

function isRemote(run: Invocation): boolean {
  if (FETCHERS.has(run.name)) return run.args.some(arg => !SELF_INFO.has(arg)) && !run.args.every(arg => arg.startsWith('-'))
  if (HOST_COPIERS.has(run.name)) return operands(run).some(isHostPath)
  if (RUNNERS.has(run.name)) {
    const spec = run.args.find(arg => !arg.startsWith('-'))
    return run.args.some(arg => arg === '-p' || arg === '--package' || URL.test(arg)) || (spec !== undefined && /.@/.test(spec))
  }
  if (run.name === 'gh') {
    const top = subcommand(run.args, GH_VALUED)
    if (top === null || !(top.word in GH_REMOTE)) return false
    const second = GH_REMOTE[top.word]
    if (second === null || second === undefined) return true
    const next = subcommand(top.rest, GH_VALUED)
    return next !== null && second.has(next.word)
  }
  if (PKG_MANAGERS.has(run.name)) {
    const sub = subcommand(run.args)
    if (sub !== null && PKG_INFO.has(sub.word)) return true
    if (run.name !== 'bun') return false
  }
  // Inline code that names a URL (python -c, node -e, bun -e …); a script file alone is not enough.
  if (INTERPRETERS.has(run.name)) return run.args.some(arg => /https?:\/\//i.test(arg))
  return false
}

export function isRemoteShell(command: string): boolean {
  return scriptInvocations(command).some(isRemote)
}

// Plain operands of a program, skipping options and the values of the ones that take one.
function operands(run: Invocation): string[] {
  const valued = VALUED[run.name === 'egrep' || run.name === 'fgrep' ? 'grep' : run.name] ?? new Set<string>()
  const out: string[] = []
  for (let i = 0; i < run.args.length; i += 1) {
    const arg = run.args[i]!
    if (arg === '--') {
      out.push(...run.args.slice(i + 1))
      break
    }
    if (valued.has(arg)) i += 1
    else if (!arg.startsWith('-') || arg === '-') out.push(arg)
  }
  return out
}

// A short-flag cluster: which flags it sets, and the value glued to its last valued flag.
function cluster(arg: string, valued: Set<string>, want: string): { has: boolean; value?: string } {
  if (!/^-[A-Za-z]/.test(arg) || arg.startsWith('--')) return { has: false }
  for (let i = 1; i < arg.length; i += 1) {
    const ch = arg[i]!
    if (ch === want) return { has: true, value: i + 1 < arg.length ? arg.slice(i + 1) : undefined }
    if (valued.has(ch) || !/[A-Za-z0-9]/.test(ch)) return { has: false }
  }
  return { has: false }
}

// Files a fetching program writes, relative paths as written.
function downloads(run: Invocation): { files: string[]; dirs: string[] } {
  const files: string[] = []
  const dirs: string[] = []
  const args = run.args
  const urls = args.filter(arg => URL.test(arg))
  const take = (value: string | undefined) => {
    if (value !== undefined && value !== '-' && value !== '/dev/null') files.push(value)
  }
  if (run.name === 'curl') {
    let remoteName = false
    let outputDir = ''
    const named: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!
      if (arg === '--output') named.push(args[(i += 1)] ?? '')
      else if (arg.startsWith('--output=')) named.push(arg.slice(9))
      else if (arg === '--remote-name' || arg === '--remote-name-all') remoteName = true
      else if (arg === '--output-dir') outputDir = `${args[(i += 1)] ?? ''}/`
      else if (arg.startsWith('--output-dir=')) outputDir = `${arg.slice(13)}/`
      else {
        const o = cluster(arg, CURL_VALUED, 'o')
        if (o.has) named.push(o.value ?? args[(i += 1)] ?? '')
        if (cluster(arg, CURL_VALUED, 'O').has) remoteName = true
      }
    }
    // --output-dir applies to relative -o names too.
    for (const name of named) take(name === '' || name.startsWith('/') || name.startsWith('~') ? name : outputDir + name)
    if (remoteName) for (const url of urls) files.push(outputDir + baseName(url))
  } else if (run.name === 'wget') {
    let explicit = false
    let prefix = ''
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!
      if (arg === '--output-document') {
        explicit = true
        take(args[(i += 1)])
      } else if (arg.startsWith('--output-document=')) {
        explicit = true
        take(arg.slice(18))
      } else if (arg === '-P' || arg === '--directory-prefix') prefix = `${args[(i += 1)] ?? ''}/`
      else if (arg.startsWith('--directory-prefix=')) prefix = `${arg.slice(19)}/`
      else if (cluster(arg, WGET_VALUED, 'P').has) prefix = `${cluster(arg, WGET_VALUED, 'P').value ?? args[(i += 1)] ?? ''}/`
      else {
        const big = cluster(arg, WGET_VALUED, 'O')
        if (big.has) {
          explicit = true
          take(big.value ?? args[(i += 1)])
        }
      }
    }
    if (!explicit) for (const url of urls) files.push(prefix + baseName(url))
  } else if (run.name === 'aria2c') {
    const out = args[args.indexOf('-o') + 1]
    const dir = args.indexOf('-d') >= 0 ? `${args[args.indexOf('-d') + 1]}/` : ''
    if (args.includes('-o') && out !== undefined) files.push(dir + out)
    else for (const url of urls) files.push(dir + baseName(url))
  } else if (/^(invoke-webrequest|iwr|invoke-restmethod|irm)$/.test(run.name)) {
    const at = args.findIndex(arg => /^-outfile$/i.test(arg))
    if (at >= 0) take(args[at + 1])
  } else if (run.name === 'scp' || run.name === 'rsync') {
    const paths = operands(run)
    const dest = paths.pop()
    if (dest !== undefined) {
      files.push(dest)
      for (const source of paths) files.push(`${dest.replace(/\/+$/, '')}/${baseName(remotePath(source))}`)
    }
  } else if (run.name === 'gh') {
    const at = args.findIndex(arg => arg === '-O' || arg === '--output')
    if (at >= 0) take(args[at + 1])
    args.forEach((arg, k) => {
      if ((arg === '-D' || arg === '--dir') && args[k + 1] !== undefined) dirs.push(args[k + 1]!)
      else if (arg.startsWith('--dir=')) dirs.push(arg.slice(6))
      else if (/^-D./.test(arg)) dirs.push(arg.slice(2))
    })
  }
  return { files, dirs }
}

export type Walk = { isRemote: boolean; readsTainted: boolean; written: string[] }

// Walks a command in execution order: follows cd, sees what each step fetches,
// copies, redirects or tees, and lets later steps see the files earlier ones tainted.
export function walk(command: string, ctx: Context, depth = 0): Walk {
  const result: Walk = { isRemote: false, readsTainted: false, written: [] }
  const working = new Set(ctx.tainted)
  let cwd = ctx.cwd
  const at = (path: string, dir = cwd) => normalize(path, { cwd: dir, home: ctx.home })
  // A trailing "/" marks a whole folder: it covers the folder itself and everything under it.
  const tainted = (full: string) => working.has(full) || working.has(`${full}/`) || [...working].some(t => t.endsWith('/') && full.startsWith(t))
  const holdsTainted = (dir: string) => {
    const prefix = `${dir.replace(/\/$/, '')}/`
    return [...working].some(t => t.startsWith(prefix) || t === prefix)
  }
  const add = (full: string) => {
    if (!working.has(full)) result.written.push(full)
    working.add(full)
  }
  if (depth > 4) return result

  const { segments, subs } = parse(command)
  const nestedHot = (script: string, dir: string) => {
    const inner = walk(script, { ...ctx, cwd: dir, tainted: [...working] }, depth + 1)
    for (const path of inner.written) add(path)
    result.isRemote ||= inner.isRemote
    result.readsTainted ||= inner.readsTainted
    return inner.isRemote || inner.readsTainted
  }
  for (const sub of subs) nestedHot(sub, cwd)

  let pipe = -1
  let pipeHot = false
  let lastHot = false
  // Subshells keep their own cwd: "(cd /tmp); curl …" downloads in the outer cwd.
  const stack: string[] = []
  let level = 0
  for (const segment of segments) {
    while (segment.level > level) {
      stack.push(cwd)
      level += 1
    }
    while (segment.level < level) {
      cwd = stack.pop() ?? cwd
      level -= 1
    }
    if (segment.pipe !== pipe) {
      pipe = segment.pipe
      pipeHot = false
    }
    const runs = invocations(segment.words)
    const first = runs[0]
    if (first !== undefined && (first.name === 'cd' || first.name === 'pushd')) {
      const target = first.args.find(arg => !arg.startsWith('-'))
      // "cd -" goes back somewhere this walk does not know; leave cwd alone rather than guess.
      if (target !== '-') cwd = target === undefined ? (ctx.home ?? cwd) : at(target)
      continue
    }
    if (first?.name === 'popd') continue
    const here = runs.find(run => run.chdir !== undefined)?.chdir
    const dir = here === undefined ? cwd : at(here)

    // Scripts and substitutions inside this command make it hot when they fetch or read fetched files.
    let hot = false
    for (const script of innerScripts(segment.words)) if (nestedHot(script, dir)) hot = true
    for (const sub of segment.subs) if (nestedHot(sub, dir)) hot = true

    const remote = runs.some(isRemote)
    const program = first?.name ?? ''
    let reads =
      segment.reads.some(path => tainted(at(path, dir))) ||
      (!NON_READERS.has(program) && segment.words.some(word => !word.startsWith('-') && !URL.test(word) && tainted(at(word, dir))))
    for (const run of runs.filter(run => SEARCHERS.has(run.name) || run.name === 'egrep' || run.name === 'fgrep')) {
      const list = operands(run)
      const pathsOnly = run.name === 'find' || run.name === 'tree' || run.name === 'fd' || run.args.some(arg => PATTERN_OPTS.has(arg))
      const targets = pathsOnly ? list : list.slice(1)
      if ((targets.length === 0 ? [dir] : targets.map(word => at(word, dir))).some(path => holdsTainted(path) || tainted(path))) reads = true
    }

    for (const run of runs.filter(isRemote)) {
      const { files, dirs } = downloads(run)
      for (const file of files) add(at(file, dir))
      for (const folder of dirs) add(`${at(folder, dir)}/`)
    }
    for (const run of runs.filter(run => COPIERS.has(run.name))) {
      const paths = operands(run)
      let into: string | undefined
      run.args.forEach((arg, k) => {
        if (arg === '-t' || arg === '--target-directory') into = run.args[k + 1]
        else if (arg.startsWith('--target-directory=')) into = arg.slice(19)
        else if (/^-t./.test(arg)) into = arg.slice(2)
      })
      if (into !== undefined) {
        const value = into
        const k = paths.indexOf(value)
        if (k >= 0) paths.splice(k, 1)
      }
      const dest = into ?? paths.pop()
      if (dest === undefined) continue
      const destAt = (name: string) => at(`${dest.replace(/\/+$/, '')}/${name}`, dir)
      for (const source of paths) {
        const full = at(source, dir)
        if (tainted(full)) {
          // The destination may be a file or a folder: taint both readings.
          if (into === undefined && paths.length === 1) add(at(dest, dir))
          add(destAt(baseName(source)))
          if (working.has(`${full}/`)) add(`${destAt(baseName(source))}/`)
        } else if (holdsTainted(full)) {
          // A folder holding fetched files: its copy holds them too, wherever they land.
          add(`${at(dest, dir)}/`)
        }
      }
    }

    hot ||= remote || reads
    // A redirect after "}" or ")" belongs to the group before it.
    if (segment.words.length === 0) hot ||= lastHot
    if (hot) pipeHot = true
    if (pipeHot) {
      for (const target of segment.writes) if (!/^&?\d*$/.test(target) && target !== '/dev/null') add(at(target, dir))
      if (program === 'tee') for (const arg of first!.args) if (!arg.startsWith('-')) add(at(arg, dir))
      // Archives unpacked from fetched bytes: the folder they unpack into.
      for (const run of runs.filter(run => EXTRACTORS.has(run.name))) {
        const flag = run.args.findIndex(arg => arg === '-C' || arg === '--directory' || arg === '-d')
        const glued = run.args.find(arg => /^--directory=/.test(arg))
        const target = glued?.slice(12) ?? (flag >= 0 ? run.args[flag + 1] : undefined)
        if (target !== undefined) add(`${at(target, dir)}/`)
      }
    }
    lastHot = pipeHot
    result.isRemote ||= remote
    result.readsTainted ||= reads
  }
  return result
}

// The source label when a call's output is untrusted, or null when it is trusted.
export function classify(e: Call, options: PluginOptions, ctx: Context = NO_CONTEXT): string | null {
  const label = (text: string) => sanitizeSource(text)
  if (e.tool === 'WebFetch') return label(`WebFetch ${String(e.url ?? '')}`)
  if (e.tool === 'WebSearch') return label(`WebSearch "${short(String(e.query ?? ''))}"`)
  if (e.tool.startsWith('mcp__')) {
    const server = e.tool.split('__')[1] ?? ''
    return trustedServers(options).has(server) ? null : label(e.tool)
  }
  if (SHELL_TOOLS.has(e.tool)) {
    const command = String(e.command ?? '')
    const steps = walk(command, ctx)
    if (options.quarantineAllShell === true || steps.isRemote) return label(`${e.tool}: ${short(command)}`)
    return steps.readsTainted ? label(`${e.tool}: ${short(command)} (reads a fetched file)`) : null
  }
  if (e.tool === 'Read' || e.tool === 'Grep' || e.tool === 'Glob') {
    const raw = String(e.file_path ?? e.path ?? '')
    const full = normalize(raw === '' ? '.' : raw, ctx)
    const covered = ctx.tainted.some(t => t === full || t.startsWith(`${full}/`) || (t.endsWith('/') && full.startsWith(t)))
    if (covered) return label(`${e.tool} ${raw || '.'} (fetched earlier)`)
    const vendored = VENDORED.test(full) || HOME_DOWNLOADS.test(full)
    return options.quarantineVendorReads !== false && vendored ? label(`${e.tool} ${raw || '.'}`) : null
  }
  return null
}

export type Block = { type: string; [k: string]: unknown }

// Rewrites one tool_result's content (a string, a block list, or a lone block);
// images and other media stay as they were.
export function quarantineContent(content: unknown, source: string, isStrict: boolean) {
  let count = 0
  const reasons = new Set<string>()
  const clean = (text: string) => {
    const out = defang(text, isStrict)
    count += out.lines
    for (const reason of out.reasons) reasons.add(reason)
    return out.text
  }

  if (typeof content === 'string') {
    return { content: `${header(source)}\n${clean(content)}\n${footer()}`, count, reasons }
  }
  const list = Array.isArray(content)
    ? (content as Block[])
    : content !== null && typeof content === 'object' && typeof (content as Block).type === 'string'
      ? [content as Block]
      : null
  if (list === null) return null
  const blocks = list.map(block =>
    block.type === 'text' && typeof block.text === 'string' ? { ...block, text: clean(block.text) } : block,
  )
  return {
    content: [{ type: 'text', text: header(source) }, ...blocks, { type: 'text', text: footer() }],
    count,
    reasons,
  }
}

export type Rewrite = { content: Block[]; found: Hit[]; done: string[] }

// The tool_result blocks of one row, rewritten where their call was untrusted.
// `waiting` maps tool_use_id to source for calls classified at tool.call. A row
// holding a single result whose call predates this module is wrapped when its
// tool alone says untrusted; the tool name is never borrowed for siblings.
export function rewriteRow(
  blocks: readonly Block[],
  waiting: Readonly<Record<string, string>>,
  originTool: string | null,
  options: PluginOptions,
  isStrict: boolean,
): Rewrite {
  const found: Hit[] = []
  const done: string[] = []
  const results = blocks.filter(block => block.type === 'tool_result')
  const content = blocks.map(block => {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return block
    const id = block.tool_use_id
    const canFallBack = results.length === 1 && originTool !== null && !SHELL_TOOLS.has(originTool) && originTool !== 'Read'
    const source = waiting[id] ?? (canFallBack ? classify({ tool: originTool }, options) : null)
    if (source === null) return block
    const out = quarantineContent(block.content, source, isStrict)
    if (out === null) return block
    done.push(id)
    found.push({ source, lines: out.count, reasons: [...out.reasons] })
    // Only content changes: tool_use_id and is_error are kept as they were.
    return { ...block, content: out.content }
  })
  return { content, found, done }
}
