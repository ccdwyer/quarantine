import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { classify, rewriteRow, walk } from './core'
import type { Call, Context } from './core'
import { defang, wrap } from './sanitize'

const pending = atom({ plugin: 'quarantine', key: 'pending' } as const, {})
const hits = atom({ plugin: 'quarantine', key: 'hits' } as const, [])
const results = atom({ plugin: 'quarantine', key: 'results' } as const, 0)
const lines = atom({ plugin: 'quarantine', key: 'lines' } as const, 0)
const tainted = atom({ plugin: 'quarantine', key: 'tainted' } as const, [])
const strict = atom({ plugin: 'quarantine', key: 'strict' } as const, false)

const HISTORY = 30
// Fetched files stay tainted for the session; this only bounds memory.
const TAINT_MAX = 1000

async function showStatus($: EngineInterface) {
  const n = await read($, results)
  const m = await read($, lines)
  const mode = (await read($, strict)) ? ' (strict)' : ''
  $.ui.status(n === 0 ? undefined : `🛡 quarantined ${n} result${n === 1 ? '' : 's'} · ${m} line${m === 1 ? '' : 's'} defanged${mode}`)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quarantine',
      description: 'Quarantine: list recent untrusted results; "/quarantine strict" toggles strict mode',
      argumentHint: '[strict]',
      immediate: true,
    })
    await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'quarantine' }, async ($, e) => {
    if (e.args.trim() === 'strict') {
      const now = await update($, strict, was => !was)
      await showStatus($)
      return {
        text: now
          ? 'Quarantine: strict mode on. Imperatives addressed to the agent and "run the following command" lines are also defanged.'
          : 'Quarantine: strict mode off.',
      }
    }
    const list = await read($, hits)
    const n = await read($, results)
    const m = await read($, lines)
    if (list.length === 0) return { text: 'Quarantine: no untrusted results yet this session.' }
    const rows = list
      .slice()
      .reverse()
      .map(hit => `- ${hit.source}: ${hit.lines === 0 ? 'wrapped, nothing to defang' : `${hit.lines} line(s) defanged (${hit.reasons.join(', ')})`}`)
    return {
      text: `Quarantine: ${n} result(s) wrapped, ${m} line(s) defanged${(await read($, strict)) ? ', strict mode on' : ''}.\n${rows.join('\n')}`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const call = e as Call
    const ctx: Context = { tainted: await read($, tainted), cwd: await $.session.cwd(), home: await $.env.get('HOME') }
    const isShell = (call.tool === 'Bash' || call.tool === 'PowerShell') && typeof call.command === 'string'
    const source = e.tool_use_id === undefined ? null : classify(call, options, ctx)

    // Taint follows the bytes: files this command fetches, copies, redirects or tees.
    const written = isShell ? walk(String(call.command), ctx).written : []
    const remember = async () => {
      if (written.length > 0) await update($, tainted, list => [...list.filter(path => !written.includes(path)), ...written].slice(-TAINT_MAX))
    }
    if (source === null || e.tool_use_id === undefined) {
      const ran = await next(e)
      if (ran.deny === undefined) await remember()
      return ran
    }

    const id = e.tool_use_id
    await update($, pending, all => ({ ...all, [id]: source }))

    const ran = await next(e)
    // A refused command wrote nothing.
    if (ran.deny === undefined) await remember()
    // Notes a lower hook attached for the model ride beside the result: defang those too.
    if (ran.deny === undefined && ran.context !== undefined && ran.context.length > 0) {
      const isStrict = await read($, strict)
      return { ...ran, context: ran.context.map(note => wrap(defang(note, isStrict).text, source)) }
    }
    return ran
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const waiting = await read($, pending)
    const isStrict = await read($, strict)
    const originTool = e.origin.kind === 'tool' ? e.origin.tool : null
    const { content, found, done } = rewriteRow(e.message.content, waiting, originTool, options, isStrict)

    if (found.length === 0) return next(e)
    const stored = await next({ ...e, message: { ...e.message, content } })

    await update($, pending, all => {
      const rest = { ...all }
      for (const id of done) delete rest[id]
      return rest
    })
    await update($, hits, list => [...list, ...found].slice(-HISTORY))
    await update($, results, n => n + found.length)
    await update($, lines, n => n + found.reduce((sum, hit) => sum + hit.lines, 0))
    const defanged = found.filter(hit => hit.lines > 0)
    if (defanged.length > 0) {
      $.ui.toast(`🛡 Quarantine defanged ${defanged.reduce((s, h) => s + h.lines, 0)} line(s) in ${defanged[0]!.source}`)
    }
    await showStatus($)
    return stored
  })
}
