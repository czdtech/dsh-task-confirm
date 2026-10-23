export type ConfirmPhase = 'gate' | 'pending' | 'confirmed'

export type ConfirmDecision =
  | { allow: true }
  | { allow: false; reason: string }

export interface SessionHeaderLike {
  readonly origin?: string
  readonly delegationDepth?: number
}

export interface ConfirmStateOptions {
  readonly marker: string
  readonly readOnlyTools: readonly string[]
  readonly cancelWords: readonly string[]
  readonly confirmWords: readonly string[]
  readonly denyReason: (toolName: string) => string
  readonly understandingSentReason: string
  /** Lifetime of an armed confirmation. `0` keeps it until consumed. */
  readonly pendingTtlMs: number
  readonly now: () => number
}

/** Runtime settings the host can change without remounting the plugin. */
export interface ConfirmStateSettings {
  readonly marker: string
  readonly readOnlyTools: readonly string[]
  readonly cancelWords: readonly string[]
  readonly confirmWords: readonly string[]
  readonly pendingTtlMs: number
}

interface SessionRecord {
  /** What the current turn may do. Reset to `gate` at every turn start. */
  phase: Exclude<ConfirmPhase, 'pending'>
  /** A previous turn asked for confirmation and no human reply consumed it yet. */
  awaitingConfirm: boolean
  /** Clock value when `awaitingConfirm` was armed; `null` when it is not. */
  awaitingSince: number | null
  /** The current turn was opened by a human; unattended turns bypass the gate. */
  humanTurn: boolean
  /** Whether the current turn's origin has been classified from its admitted messages. */
  turnClassified: boolean
  sawUnderstanding: boolean
  cancelled: boolean
  /** Confirmed by a steering message inside the phase-one turn. */
  midTurnConfirmed: boolean
  /** The awaiting confirmation was consumed by a human message in this turn. */
  confirmedByUser: boolean
  /** Latest human-readable session title, mirrored from `session/title`. */
  title: string | null
}

export type UserMessageOutcome = 'cancel' | 'confirm' | null

/** One session the settings page can show without exposing the internal record. */
export interface SessionStatusSnapshot {
  readonly id: string
  readonly title: string | null
  readonly phase: 'pending' | 'confirmed'
  readonly awaitingSince: number | null
  readonly humanTurn: boolean
}

const TRAILING_PUNCTUATION = /[\s。！!，,.、；;：:]+$/u
const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeWord(text: string): string {
  return text.trim().toLowerCase().replace(TRAILING_PUNCTUATION, '')
}

export function isSubagentSession(header: SessionHeaderLike | undefined): boolean {
  if (!header) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Per-session two-phase confirmation state.
 *
 * A turn may always investigate with read-only tools. Mutating tools are
 * refused until a turn has produced a task-understanding message and a human
 * reply confirms it. Confirmation is consumed in `agent/pre-step`, where the
 * human message is visible, so auto-started turns cannot claim it.
 *
 * A denial alone never arms the confirmation: only an actual understanding
 * message does, so a stale denial can not turn a later unrelated human message
 * into an approval. Armed confirmations expire after `pendingTtlMs`, and only
 * an explicit confirmation word approves them.
 *
 * Only human-opened turns are gated. Goal rounds, scheduled tasks and other
 * synthetic-input turns have no human present, so they run without waiting.
 */
export class ConfirmState {
  private readonly sessions = new Map<string, SessionRecord>()
  private readOnly: ReadonlySet<string> = new Set()
  private cancelWords: ReadonlySet<string> = new Set()
  private confirmWords: ReadonlySet<string> = new Set()
  private markerPattern: RegExp | null = null
  private currentMarker = ''
  private pendingTtlMs = 0
  private readonly now: () => number

  constructor(private readonly options: ConfirmStateOptions) {
    this.now = options.now
    this.updateSettings({
      marker: options.marker,
      readOnlyTools: options.readOnlyTools,
      cancelWords: options.cancelWords,
      confirmWords: options.confirmWords,
      pendingTtlMs: options.pendingTtlMs,
    })
  }

  /** Apply live config changes; open turns keep their already-observed flags. */
  updateSettings(settings: ConfirmStateSettings): void {
    this.currentMarker = settings.marker
    this.readOnly = new Set(settings.readOnlyTools)
    this.cancelWords = new Set(settings.cancelWords.map(normalizeWord))
    this.confirmWords = new Set(settings.confirmWords.map(normalizeWord))
    const marker = settings.marker.trim()
    this.markerPattern = marker
      ? new RegExp(`^(?:[#>*+-]\\s*)*${escapeRegExp(marker)}`)
      : null
    this.pendingTtlMs = Math.max(0, settings.pendingTtlMs)
  }

  reset(): void {
    this.sessions.clear()
  }

  get marker(): string {
    return this.currentMarker
  }

  onTurnStart(sessionId: string): ConfirmPhase {
    const record = this.ensure(sessionId)
    this.expire(record)
    record.phase = 'gate'
    record.humanTurn = true
    record.turnClassified = false
    record.sawUnderstanding = false
    record.cancelled = false
    record.midTurnConfirmed = false
    record.confirmedByUser = false
    return record.awaitingConfirm ? 'pending' : 'gate'
  }

  /** A human message was admitted; later synthetic input can not downgrade the turn. */
  onHumanMessage(sessionId: string): void {
    const record = this.ensure(sessionId)
    record.turnClassified = true
    record.humanTurn = true
  }

  /** Classify a turn from its admitted message batch; a later human message upgrades it. */
  onTurnMessage(sessionId: string, fromHuman: boolean): void {
    const record = this.ensure(sessionId)
    if (!record.turnClassified) {
      record.turnClassified = true
      record.humanTurn = fromHuman
      return
    }
    if (fromHuman) record.humanTurn = true
  }

  /** Unknown sessions stay gated: only a classified unattended turn is exempt. */
  isHumanTurn(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.humanTurn ?? true
  }

  onAssistantMessage(sessionId: string, text: string): void {
    if (!text.trim()) return
    const record = this.ensure(sessionId)
    if (this.isUnderstanding(text)) record.sawUnderstanding = true
  }

  /** Remember the session's latest title so status rows are recognisable. */
  onTitle(sessionId: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    this.ensure(sessionId).title = trimmed.slice(0, 200)
  }

  onTurnEnd(sessionId: string, reasonKind: string): ConfirmPhase {
    const record = this.ensure(sessionId)
    this.expire(record)
    const normal = reasonKind === 'completed' || reasonKind === 'max-tokens'
    if (!normal) {
      record.phase = 'gate'
    } else if (record.cancelled) {
      this.disarm(record)
      record.phase = 'gate'
    } else if (record.midTurnConfirmed || record.confirmedByUser) {
      this.disarm(record)
      record.phase = 'gate'
    } else if (record.humanTurn && record.sawUnderstanding) {
      this.arm(record)
      record.phase = 'gate'
    } else {
      record.phase = 'gate'
    }
    record.sawUnderstanding = false
    record.cancelled = false
    record.midTurnConfirmed = false
    record.confirmedByUser = false
    return record.phase
  }

  /**
   * A human message entered a step. `confirm` consumes an awaiting
   * confirmation; `cancel` abandons it (or the current confirmed turn).
   * Synthetic messages never reach this method.
   */
  onUserMessages(sessionId: string, texts: readonly string[]): UserMessageOutcome {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    this.expire(record)
    const cancel = texts.some((text) => this.isCancel(text))

    if (record.phase === 'confirmed') {
      if (!cancel) return null
      record.cancelled = true
      this.disarm(record)
      record.phase = 'gate'
      return 'cancel'
    }

    if (record.awaitingConfirm) {
      if (cancel) {
        this.disarm(record)
        record.cancelled = true
        return 'cancel'
      }
      // Only an explicit confirmation word approves; any other message leaves
      // the pending proposal untouched, so an unrelated reply can not unlock it.
      if (!texts.some((text) => this.isConfirm(text))) return null
      this.disarm(record)
      record.phase = 'confirmed'
      record.confirmedByUser = true
      return 'confirm'
    }

    if (record.sawUnderstanding) {
      if (cancel) {
        record.cancelled = true
        return 'cancel'
      }
      if (texts.some((text) => this.isConfirm(text))) {
        record.phase = 'confirmed'
        record.midTurnConfirmed = true
        return 'confirm'
      }
    }
    return null
  }

  decide(sessionId: string, toolName: string): ConfirmDecision {
    const record = this.ensure(sessionId)
    this.expire(record)
    // Unattended turns have no human to confirm; they keep working autonomously.
    if (!record.humanTurn) return { allow: true }
    if (record.phase === 'confirmed') return { allow: true }
    if (record.sawUnderstanding) {
      return { allow: false, reason: this.options.understandingSentReason }
    }
    if (this.readOnly.has(toolName)) return { allow: true }
    return { allow: false, reason: this.options.denyReason(toolName) }
  }

  phase(sessionId: string): ConfirmPhase | undefined {
    const record = this.sessions.get(sessionId)
    if (!record) return undefined
    this.expire(record)
    if (record.phase === 'confirmed') return 'confirmed'
    return record.awaitingConfirm ? 'pending' : 'gate'
  }

  /** Rows the settings page should show: armed confirmations and confirmed turns. */
  snapshot(): SessionStatusSnapshot[] {
    const rows: SessionStatusSnapshot[] = []
    for (const [id, record] of this.sessions) {
      this.expire(record)
      const phase = record.phase === 'confirmed' ? 'confirmed' : record.awaitingConfirm ? 'pending' : null
      if (!phase) continue
      rows.push({
        id,
        title: record.title,
        phase,
        awaitingSince: record.awaitingSince,
        humanTurn: record.humanTurn,
      })
    }
    rows.sort((left, right) => {
      if (left.phase !== right.phase) return left.phase === 'pending' ? -1 : 1
      return (left.awaitingSince ?? 0) - (right.awaitingSince ?? 0)
    })
    return rows
  }

  /** Sessions with any in-memory record, including those currently at the gate. */
  get tracked(): number {
    return this.sessions.size
  }

  cancel(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record) return false
    this.expire(record)
    if (!record.awaitingConfirm && record.phase !== 'confirmed') return false
    this.disarm(record)
    record.phase = 'gate'
    record.cancelled = true
    return true
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private ensure(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const created: SessionRecord = {
      phase: 'gate',
      awaitingConfirm: false,
      awaitingSince: null,
      humanTurn: true,
      turnClassified: false,
      sawUnderstanding: false,
      cancelled: false,
      midTurnConfirmed: false,
      confirmedByUser: false,
      title: null,
    }
    this.sessions.set(sessionId, created)
    return created
  }

  private arm(record: SessionRecord): void {
    record.awaitingConfirm = true
    record.awaitingSince = this.now()
  }

  private disarm(record: SessionRecord): void {
    record.awaitingConfirm = false
    record.awaitingSince = null
  }

  private expire(record: SessionRecord): boolean {
    if (!record.awaitingConfirm || this.pendingTtlMs <= 0) return false
    if (record.awaitingSince === null) return false
    if (this.now() - record.awaitingSince < this.pendingTtlMs) return false
    this.disarm(record)
    return true
  }

  private isUnderstanding(text: string): boolean {
    if (!this.markerPattern) return false
    // A quoted protocol echo inside a fenced block must not arm the gate.
    const prose = text.replace(FENCED_BLOCK, '').trimStart()
    if (!prose) return false
    return this.markerPattern.test(prose)
  }

  private isCancel(text: string): boolean {
    return this.cancelWords.has(normalizeWord(text))
  }

  private isConfirm(text: string): boolean {
    return this.confirmWords.has(normalizeWord(text))
  }
}
