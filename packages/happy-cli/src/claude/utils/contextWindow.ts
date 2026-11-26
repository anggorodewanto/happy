/**
 * Context-window bookkeeping shared by the local and remote Claude launchers.
 *
 * The SDK reports each model's real context window only on result messages,
 * and only remote mode sees those. Local mode reads the on-disk transcript,
 * which has no result messages, so the app would know how many tokens were
 * used but not what they are a fraction of. Both modes therefore share one
 * per-model map (Session.contextWindows); local mode falls back to inferring
 * the window from the configured model when nothing was measured yet.
 */

import type { RawJSONLines } from '@/claude/types';
import { readClaudeModelSetting } from './claudeSettings';

export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;
export const LARGE_CLAUDE_CONTEXT_WINDOW = 1_000_000;

/** Context windows measured (or otherwise known) per model. */
export type ContextWindowByModel = Map<string, number>;

const CLAUDE_MODEL_PREFIX = 'claude-';
const LARGE_CONTEXT_SUFFIX = /\[1m\]$/i;
const MODEL_FLAG = '--model';

export function isClaudeModel(model: string | undefined): boolean {
    if (!model) {
        return false;
    }
    return model.toLowerCase().startsWith(CLAUDE_MODEL_PREFIX);
}

/** A model string asks for the 1M window with a `[1m]` suffix. */
export function asksForLargeContext(model: string | undefined): boolean {
    if (!model) {
        return false;
    }
    return LARGE_CONTEXT_SUFFIX.test(model.trim());
}

/**
 * Remember a measured window. Unusable values are ignored so callers can pass
 * SDK data straight through.
 */
export function recordContextWindow(
    windows: ContextWindowByModel,
    model: string,
    contextWindow: number | undefined,
): void {
    if (!model) {
        return;
    }
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return;
    }
    windows.set(model, contextWindow);
}

/** Extract the last `--model` value from Claude args (`--model x` or `--model=x`). */
export function modelFromArgs(args: string[] | undefined): string | undefined {
    if (!args) {
        return undefined;
    }

    let found: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === MODEL_FLAG && i + 1 < args.length) {
            found = args[i + 1];
            continue;
        }
        if (arg.startsWith(`${MODEL_FLAG}=`)) {
            found = arg.slice(MODEL_FLAG.length + 1);
        }
    }

    return found || undefined;
}

/**
 * Resolve the model the session is configured to run, from the most explicit
 * source to the least: `--model` args, then `ANTHROPIC_MODEL`, then Claude
 * settings files.
 */
export function resolveConfiguredModel(opts: {
    claudeArgs?: string[];
    claudeEnvVars?: Record<string, string>;
    cwd: string;
}): string | undefined {
    const fromArgs = modelFromArgs(opts.claudeArgs);
    if (fromArgs) {
        return fromArgs;
    }

    const fromEnv = opts.claudeEnvVars?.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL;
    if (fromEnv) {
        return fromEnv;
    }

    return readClaudeModelSetting(opts.cwd);
}

/**
 * Context already measured for a turn: everything the model had to read plus
 * what it wrote.
 */
export function measuredContextTokens(usage: any): number {
    if (!usage) {
        return 0;
    }

    let total = 0;
    for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            total += value;
        }
    }
    return total;
}

/**
 * A configured `[1m]` model applies only to messages from that model, so a
 * subagent on another model (e.g. haiku) is not given the 1M window. Matches
 * both full IDs (`claude-opus-5-5[1m]`) and aliases (`opus[1m]`).
 */
function configuredLargeContextApplies(configuredModel: string | undefined, model: string): boolean {
    if (!configuredModel || !asksForLargeContext(configuredModel)) {
        return false;
    }
    const base = configuredModel.trim().replace(LARGE_CONTEXT_SUFFIX, '').toLowerCase();
    if (!base) {
        return false;
    }
    return model.toLowerCase().includes(base);
}

/**
 * Infer a Claude model's context window. Unknown and non-Claude models return
 * undefined so their usage is left untouched.
 */
export function inferContextWindow(opts: {
    model?: string;
    configuredModel?: string;
    measuredTokens?: number;
}): number | undefined {
    if (!opts.model || !isClaudeModel(opts.model)) {
        return undefined;
    }

    if (asksForLargeContext(opts.model) || configuredLargeContextApplies(opts.configuredModel, opts.model)) {
        return LARGE_CLAUDE_CONTEXT_WINDOW;
    }

    if (typeof opts.measuredTokens === 'number' && opts.measuredTokens > DEFAULT_CLAUDE_CONTEXT_WINDOW) {
        return LARGE_CLAUDE_CONTEXT_WINDOW;
    }

    return DEFAULT_CLAUDE_CONTEXT_WINDOW;
}

/**
 * Prefer a window measured earlier in this Happy session for the exact model,
 * then fall back to inference.
 */
export function contextWindowForMessage(opts: {
    windows: ContextWindowByModel;
    model?: string;
    configuredModel?: string;
    measuredTokens?: number;
}): number | undefined {
    const known = opts.model ? opts.windows.get(opts.model) : undefined;
    if (known) {
        return known;
    }

    return inferContextWindow(opts);
}

/**
 * Stamp `usage.context_window` onto an assistant transcript message, returning
 * a copy. Non-assistant or usage-less messages (and non-Claude models whose
 * window cannot be inferred) are returned untouched.
 */
export function stampContextWindow(message: RawJSONLines, opts: {
    windows: ContextWindowByModel;
    configuredModel?: string;
}): RawJSONLines {
    if (message.type !== 'assistant') {
        return message;
    }

    const body = message.message;
    if (!body?.usage) {
        return message;
    }

    const model = typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model
        : undefined;

    const contextWindow = contextWindowForMessage({
        windows: opts.windows,
        model,
        configuredModel: opts.configuredModel,
        measuredTokens: measuredContextTokens(body.usage),
    });
    if (!contextWindow) {
        return message;
    }
    // Once a turn proves the 1M window, keep it for later turns of this model
    // so the meter's denominator never drops back to 200K.
    if (model && contextWindow === LARGE_CLAUDE_CONTEXT_WINDOW && !opts.windows.has(model)) {
        opts.windows.set(model, contextWindow);
    }

    return {
        ...message,
        message: {
            ...body,
            usage: {
                ...body.usage,
                context_window: contextWindow,
            },
        },
    } as RawJSONLines;
}
