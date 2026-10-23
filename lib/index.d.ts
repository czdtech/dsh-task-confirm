import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-task-confirm";
export declare const inject: string[];
/** A volatile schemastery field arrives as a ref whose getter tracks live edits. */
type LiveValue<T> = T | {
    get(): T;
};
export interface Config {
    readonly enabled: LiveValue<boolean>;
    readonly marker: LiveValue<string>;
    readonly readOnlyTools: LiveValue<readonly string[]>;
    readonly cancelWords: LiveValue<readonly string[]>;
    readonly confirmWords: LiveValue<readonly string[]>;
    readonly pendingTtlMs: LiveValue<number>;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    marker: z<string, string, "volatile-defined">;
    readOnlyTools: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    cancelWords: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    confirmWords: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    pendingTtlMs: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    marker: z<string, string, "volatile-defined">;
    readOnlyTools: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    cancelWords: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    confirmWords: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    pendingTtlMs: z<number, number, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
export {};
