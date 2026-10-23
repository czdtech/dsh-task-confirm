const TRAILING_PUNCTUATION = /[\s。！!，,.、；;：:]+$/u;
const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g;
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeWord(text) {
    return text.trim().toLowerCase().replace(TRAILING_PUNCTUATION, '');
}
export function isSubagentSession(header) {
    if (!header)
        return false;
    return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
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
    options;
    sessions = new Map();
    readOnly = new Set();
    cancelWords = new Set();
    confirmWords = new Set();
    markerPattern = null;
    currentMarker = '';
    pendingTtlMs = 0;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now;
        this.updateSettings({
            marker: options.marker,
            readOnlyTools: options.readOnlyTools,
            cancelWords: options.cancelWords,
            confirmWords: options.confirmWords,
            pendingTtlMs: options.pendingTtlMs,
        });
    }
    /** Apply live config changes; open turns keep their already-observed flags. */
    updateSettings(settings) {
        this.currentMarker = settings.marker;
        this.readOnly = new Set(settings.readOnlyTools);
        this.cancelWords = new Set(settings.cancelWords.map(normalizeWord));
        this.confirmWords = new Set(settings.confirmWords.map(normalizeWord));
        const marker = settings.marker.trim();
        this.markerPattern = marker
            ? new RegExp(`^(?:[#>*+-]\\s*)*${escapeRegExp(marker)}`)
            : null;
        this.pendingTtlMs = Math.max(0, settings.pendingTtlMs);
    }
    reset() {
        this.sessions.clear();
    }
    get marker() {
        return this.currentMarker;
    }
    onTurnStart(sessionId) {
        const record = this.ensure(sessionId);
        this.expire(record);
        record.phase = 'gate';
        record.humanTurn = true;
        record.turnClassified = false;
        record.sawUnderstanding = false;
        record.cancelled = false;
        record.midTurnConfirmed = false;
        record.confirmedByUser = false;
        return record.awaitingConfirm ? 'pending' : 'gate';
    }
    /** A human message was admitted; later synthetic input can not downgrade the turn. */
    onHumanMessage(sessionId) {
        const record = this.ensure(sessionId);
        record.turnClassified = true;
        record.humanTurn = true;
    }
    /** Classify a turn from its admitted message batch; a later human message upgrades it. */
    onTurnMessage(sessionId, fromHuman) {
        const record = this.ensure(sessionId);
        if (!record.turnClassified) {
            record.turnClassified = true;
            record.humanTurn = fromHuman;
            return;
        }
        if (fromHuman)
            record.humanTurn = true;
    }
    /** Unknown sessions stay gated: only a classified unattended turn is exempt. */
    isHumanTurn(sessionId) {
        return this.sessions.get(sessionId)?.humanTurn ?? true;
    }
    onAssistantMessage(sessionId, text) {
        if (!text.trim())
            return;
        const record = this.ensure(sessionId);
        if (this.isUnderstanding(text))
            record.sawUnderstanding = true;
    }
    /** Remember the session's latest title so status rows are recognisable. */
    onTitle(sessionId, title) {
        const trimmed = title.trim();
        if (!trimmed)
            return;
        this.ensure(sessionId).title = trimmed.slice(0, 200);
    }
    onTurnEnd(sessionId, reasonKind) {
        const record = this.ensure(sessionId);
        this.expire(record);
        const normal = reasonKind === 'completed' || reasonKind === 'max-tokens';
        if (!normal) {
            record.phase = 'gate';
        }
        else if (record.cancelled) {
            this.disarm(record);
            record.phase = 'gate';
        }
        else if (record.midTurnConfirmed || record.confirmedByUser) {
            this.disarm(record);
            record.phase = 'gate';
        }
        else if (record.humanTurn && record.sawUnderstanding) {
            this.arm(record);
            record.phase = 'gate';
        }
        else {
            record.phase = 'gate';
        }
        record.sawUnderstanding = false;
        record.cancelled = false;
        record.midTurnConfirmed = false;
        record.confirmedByUser = false;
        return record.phase;
    }
    /**
     * A human message entered a step. `confirm` consumes an awaiting
     * confirmation; `cancel` abandons it (or the current confirmed turn).
     * Synthetic messages never reach this method.
     */
    onUserMessages(sessionId, texts) {
        const record = this.sessions.get(sessionId);
        if (!record)
            return null;
        this.expire(record);
        const cancel = texts.some((text) => this.isCancel(text));
        if (record.phase === 'confirmed') {
            if (!cancel)
                return null;
            record.cancelled = true;
            this.disarm(record);
            record.phase = 'gate';
            return 'cancel';
        }
        if (record.awaitingConfirm) {
            if (cancel) {
                this.disarm(record);
                record.cancelled = true;
                return 'cancel';
            }
            // Only an explicit confirmation word approves; any other message leaves
            // the pending proposal untouched, so an unrelated reply can not unlock it.
            if (!texts.some((text) => this.isConfirm(text)))
                return null;
            this.disarm(record);
            record.phase = 'confirmed';
            record.confirmedByUser = true;
            return 'confirm';
        }
        if (record.sawUnderstanding) {
            if (cancel) {
                record.cancelled = true;
                return 'cancel';
            }
            if (texts.some((text) => this.isConfirm(text))) {
                record.phase = 'confirmed';
                record.midTurnConfirmed = true;
                return 'confirm';
            }
        }
        return null;
    }
    decide(sessionId, toolName) {
        const record = this.ensure(sessionId);
        this.expire(record);
        // Unattended turns have no human to confirm; they keep working autonomously.
        if (!record.humanTurn)
            return { allow: true };
        if (record.phase === 'confirmed')
            return { allow: true };
        if (record.sawUnderstanding) {
            return { allow: false, reason: this.options.understandingSentReason };
        }
        if (this.readOnly.has(toolName))
            return { allow: true };
        return { allow: false, reason: this.options.denyReason(toolName) };
    }
    phase(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record)
            return undefined;
        this.expire(record);
        if (record.phase === 'confirmed')
            return 'confirmed';
        return record.awaitingConfirm ? 'pending' : 'gate';
    }
    /** Rows the settings page should show: armed confirmations and confirmed turns. */
    snapshot() {
        const rows = [];
        for (const [id, record] of this.sessions) {
            this.expire(record);
            const phase = record.phase === 'confirmed' ? 'confirmed' : record.awaitingConfirm ? 'pending' : null;
            if (!phase)
                continue;
            rows.push({
                id,
                title: record.title,
                phase,
                awaitingSince: record.awaitingSince,
                humanTurn: record.humanTurn,
            });
        }
        rows.sort((left, right) => {
            if (left.phase !== right.phase)
                return left.phase === 'pending' ? -1 : 1;
            return (left.awaitingSince ?? 0) - (right.awaitingSince ?? 0);
        });
        return rows;
    }
    /** Sessions with any in-memory record, including those currently at the gate. */
    get tracked() {
        return this.sessions.size;
    }
    cancel(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record)
            return false;
        this.expire(record);
        if (!record.awaitingConfirm && record.phase !== 'confirmed')
            return false;
        this.disarm(record);
        record.phase = 'gate';
        record.cancelled = true;
        return true;
    }
    forget(sessionId) {
        this.sessions.delete(sessionId);
    }
    ensure(sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing)
            return existing;
        const created = {
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
        };
        this.sessions.set(sessionId, created);
        return created;
    }
    arm(record) {
        record.awaitingConfirm = true;
        record.awaitingSince = this.now();
    }
    disarm(record) {
        record.awaitingConfirm = false;
        record.awaitingSince = null;
    }
    expire(record) {
        if (!record.awaitingConfirm || this.pendingTtlMs <= 0)
            return false;
        if (record.awaitingSince === null)
            return false;
        if (this.now() - record.awaitingSince < this.pendingTtlMs)
            return false;
        this.disarm(record);
        return true;
    }
    isUnderstanding(text) {
        if (!this.markerPattern)
            return false;
        // A quoted protocol echo inside a fenced block must not arm the gate.
        const prose = text.replace(FENCED_BLOCK, '').trimStart();
        if (!prose)
            return false;
        return this.markerPattern.test(prose);
    }
    isCancel(text) {
        return this.cancelWords.has(normalizeWord(text));
    }
    isConfirm(text) {
        return this.confirmWords.has(normalizeWord(text));
    }
}
//# sourceMappingURL=state.js.map