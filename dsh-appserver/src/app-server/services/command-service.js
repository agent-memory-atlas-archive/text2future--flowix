import { CapabilityUnavailableError, InvalidInputError } from '../protocol/domain-errors.js'

export class CommandService {
  constructor(ctx, { resolveAgent, sessionRepository, historyGuard, exportStore, skillCatalog }) {
    this.ctx = ctx
    this.resolveAgent = resolveAgent
    this.sessionRepository = sessionRepository
    this.historyGuard = historyGuard
    this.exportStore = exportStore
    this.skillCatalog = skillCatalog
  }

  effects(line, attachments, execution) {
    const result = execution?.result && typeof execution.result === 'object' ? execution.result : execution
    if (result?.kind === 'error') return { turn: 'none' }
    const parts = String(line || '').trim().split(/\s+/u)
    const name = String(parts.shift() || '').replace(/^\//u, '').toLowerCase()
    const args = parts.join(' ').trim()
    if (name === 'plan') {
      if (args.toLowerCase() === 'off' && attachments.length === 0) return { turn: 'none' }
      return args !== '' || attachments.length > 0 ? { turn: 'steer' } : { turn: 'none' }
    }
    if (name === 'goal') {
      const control = args.toLowerCase()
      if (args === '' || control === 'clear' || control === 'pause') return { turn: 'none' }
      if (control === 'edit') return { turn: 'none' }
      return { turn: 'goal-round', ...(attachments.length > 0 ? { followup: true } : {}) }
    }
    return { turn: 'none' }
  }

  async execute(id, line, attachments = []) {
    const agent = await this.resolveAgent(id)
    const commands = this.ctx.commands || this.ctx.get?.('commands')
    if (!commands?.execute) throw new CapabilityUnavailableError('commands')
    const execution = await commands.execute(agent, line, attachments, new AbortController().signal)
    if (execution === undefined) throw new InvalidInputError('command', `is not registered: ${line}`)
    const effects = this.effects(line, attachments, execution)
    if (!/^\/export(?:[\t\n\r ]*)$/u.test(line)) return { execution, effects }
    const snapshot = await this.sessionRepository.snapshot(id)
    this.historyGuard?.checkEvents(snapshot.events || [], { sessionId: id, operation: 'export' })
    const filename = `dsh-session-${String(id).replace(/[^a-z0-9_-]+/giu, '_')}.json`
    const content = JSON.stringify({ sessionId: String(id), events: snapshot.events || [] }, null, 2)
    const result = { execution, effects, export: await this.exportStore.create(filename, content) }
    this.historyGuard?.checkResult(result, { sessionId: id, operation: 'export' })
    return result
  }

  async listSkills(id) {
    if (this.skillCatalog) return this.skillCatalog.listForThread(id)
    const agent = await this.resolveAgent(id)
    const presets = this.ctx.get?.('agentPresets')
    const registry = presets?.serviceFor?.(agent, 'skills') || this.ctx.skills || this.ctx.get?.('skills')
    if (!registry?.list) throw new CapabilityUnavailableError('skills')
    const skills = await registry.list({ cwd: agent.session?.header?.cwd, scope: agent })
    return {
      skills: (Array.isArray(skills) ? skills : skills?.candidates || [])
        .filter(skill => skill?.invocation?.userInvocable !== false)
        .map(skill => ({
          name: String(skill.name), description: String(skill.description || ''),
          ...(skill.path ? { path: String(skill.path) } : {}),
          ...(skill.displayName || skill.interface?.displayName
            ? { displayName: String(skill.displayName || skill.interface.displayName) } : {}),
          ...(skill.whenToUse === undefined ? {} : { whenToUse: String(skill.whenToUse) }),
          ...(skill.invocation?.modelInvocable === undefined ? {} : { modelInvocable: Boolean(skill.invocation.modelInvocable) }),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }
}
