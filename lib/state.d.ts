export type ConfirmPhase = 'gate' | 'pending' | 'confirmed';
export type ConfirmDecision = {
    allow: true;
} | {
    allow: false;
    reason: string;
};
export interface SessionHeaderLike {
    readonly origin?: string;
    readonly delegationDepth?: number;
}
export interface ConfirmStateOptions {
    readonly marker: string;
    readonly readOnlyTools: readonly string[];
    readonly cancelWords: readonly string[];
    readonly confirmWords: readonly string[];
    readonly denyReason: (toolName: string) => string;
    readonly understandingSentReason: string;
    /** Lifetime of an armed confirmation. `0` keeps it until consumed. */
    readonly pendingTtlMs: number;
    readonly now: () => number;
}
/** Runtime settings the host can change without remounting the plugin. */
export interface ConfirmStateSettings {
    readonly marker: string;
    readonly readOnlyTools: readonly string[];
    readonly cancelWords: readonly string[];
    readonly confirmWords: readonly string[];
    readonly pendingTtlMs: number;
}
export type UserMessageOutcome = 'cancel' | 'confirm' | null;
/** One session the settings page can show without exposing the internal record. */
export interface SessionStatusSnapshot {
    readonly id: string;
    readonly title: string | null;
    readonly phase: 'pending' | 'confirmed';
    readonly awaitingSince: number | null;
    readonly humanTurn: boolean;
}
export declare function isSubagentSession(header: SessionHeaderLike | undefined): boolean;
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
export declare class ConfirmState {
    private readonly options;
    private readonly sessions;
    private readOnly;
    private cancelWords;
    private confirmWords;
    private markerPattern;
    private currentMarker;
    private pendingTtlMs;
    private readonly now;
    constructor(options: ConfirmStateOptions);
    /** Apply live config changes; open turns keep their already-observed flags. */
    updateSettings(settings: ConfirmStateSettings): void;
    reset(): void;
    get marker(): string;
    onTurnStart(sessionId: string): ConfirmPhase;
    /** A human message was admitted; later synthetic input can not downgrade the turn. */
    onHumanMessage(sessionId: string): void;
    /** Classify a turn from its admitted message batch; a later human message upgrades it. */
    onTurnMessage(sessionId: string, fromHuman: boolean): void;
    /** Unknown sessions stay gated: only a classified unattended turn is exempt. */
    isHumanTurn(sessionId: string): boolean;
    onAssistantMessage(sessionId: string, text: string): void;
    /** Remember the session's latest title so status rows are recognisable. */
    onTitle(sessionId: string, title: string): void;
    onTurnEnd(sessionId: string, reasonKind: string): ConfirmPhase;
    /**
     * A human message entered a step. `confirm` consumes an awaiting
     * confirmation; `cancel` abandons it (or the current confirmed turn).
     * Synthetic messages never reach this method.
     */
    onUserMessages(sessionId: string, texts: readonly string[]): UserMessageOutcome;
    decide(sessionId: string, toolName: string): ConfirmDecision;
    phase(sessionId: string): ConfirmPhase | undefined;
    /** Rows the settings page should show: armed confirmations and confirmed turns. */
    snapshot(): SessionStatusSnapshot[];
    /** Sessions with any in-memory record, including those currently at the gate. */
    get tracked(): number;
    cancel(sessionId: string): boolean;
    forget(sessionId: string): void;
    private ensure;
    private arm;
    private disarm;
    private expire;
    private isUnderstanding;
    private isCancel;
    private isConfirm;
}
