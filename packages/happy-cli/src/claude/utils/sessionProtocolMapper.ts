import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import {
    createEnvelope,
    type SessionEnvelope,
    type SessionTaskEvent,
    type SessionTaskStatus,
    type SessionUsage,
    type SessionTurnEndStatus,
} from '@slopus/happy-wire';

export type ClaudeSessionProtocolState = {
    currentTurnId: string | null;
    uuidToProviderSubagent?: Map<string, string>;
    taskPromptToSubagents?: Map<string, string[]>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
    hiddenParentToolCalls?: Set<string>;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    /** When each task's last `task_progress` envelope went out, for its throttle. */
    taskProgressSentAt?: Map<string, number>;
    /** Progress held back by the throttle, so the last one can follow a status change. */
    pendingTaskProgress?: Map<string, { envelope: SessionEnvelope; at: number }>;
};

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

function isSubagentTool(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

function shouldHideParentToolCall(name: string): boolean {
    return name === 'Task';
}

function pickProviderSubagent(message: RawJSONLines): string | undefined {
    const raw = message as { parent_tool_use_id?: unknown; parentToolUseId?: unknown };
    if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0) {
        return raw.parent_tool_use_id;
    }
    if (typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0) {
        return raw.parentToolUseId;
    }
    return undefined;
}

function getUuidToProviderSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.uuidToProviderSubagent) {
        state.uuidToProviderSubagent = new Map<string, string>();
    }
    return state.uuidToProviderSubagent;
}

function getTaskPromptToSubagents(state: ClaudeSessionProtocolState): Map<string, string[]> {
    if (!state.taskPromptToSubagents) {
        state.taskPromptToSubagents = new Map<string, string[]>();
    }
    return state.taskPromptToSubagents;
}

function getProviderSubagentToSessionSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.providerSubagentToSessionSubagent) {
        state.providerSubagentToSessionSubagent = new Map<string, string>();
    }
    return state.providerSubagentToSessionSubagent;
}

function getSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string | undefined {
    return getProviderSubagentToSessionSubagent(state).get(providerSubagent);
}

function deterministicSessionSubagentId(providerSubagent: string): string {
    const digest = createHash('sha256')
        .update(`claude-subagent:${providerSubagent}`)
        .digest('hex');
    return `c${digest.slice(0, 23)}`;
}

function ensureSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string {
    const existing = getSessionSubagentIdForProviderSubagent(state, providerSubagent);
    if (existing) {
        return existing;
    }

    const created = deterministicSessionSubagentId(providerSubagent);
    getProviderSubagentToSessionSubagent(state).set(providerSubagent, created);
    return created;
}

function getSubagentTitles(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.subagentTitles) {
        state.subagentTitles = new Map<string, string>();
    }
    return state.subagentTitles;
}

function getBufferedSubagentMessages(state: ClaudeSessionProtocolState): Map<string, RawJSONLines[]> {
    if (!state.bufferedSubagentMessages) {
        state.bufferedSubagentMessages = new Map<string, RawJSONLines[]>();
    }
    return state.bufferedSubagentMessages;
}

function getHiddenParentToolCalls(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.hiddenParentToolCalls) {
        state.hiddenParentToolCalls = new Set<string>();
    }
    return state.hiddenParentToolCalls;
}

function bufferSubagentMessage(state: ClaudeSessionProtocolState, subagent: string, message: RawJSONLines): void {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    queue.push(message);
    buffer.set(subagent, queue);
}

function consumeBufferedSubagentMessages(state: ClaudeSessionProtocolState, subagent: string): RawJSONLines[] {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    buffer.delete(subagent);
    return queue;
}

function getStartedSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.startedSubagents) {
        state.startedSubagents = new Set<string>();
    }
    return state.startedSubagents;
}

function getActiveSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.activeSubagents) {
        state.activeSubagents = new Set<string>();
    }
    return state.activeSubagents;
}

function pickUuid(message: RawJSONLines): string | undefined {
    const raw = message as { uuid?: unknown };
    if (typeof raw.uuid === 'string' && raw.uuid.length > 0) {
        return raw.uuid;
    }
    return undefined;
}

function pickParentUuid(message: RawJSONLines): string | undefined {
    const raw = message as { parentUuid?: unknown; parentUUID?: unknown };
    if (typeof raw.parentUuid === 'string' && raw.parentUuid.length > 0) {
        return raw.parentUuid;
    }
    if (typeof raw.parentUUID === 'string' && raw.parentUUID.length > 0) {
        return raw.parentUUID;
    }
    return undefined;
}

function isSidechainMessage(message: RawJSONLines): boolean {
    const raw = message as { isSidechain?: unknown };
    return raw.isSidechain === true;
}

function normalizePrompt(prompt: string): string {
    return prompt.trim();
}

function queueTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string, subagent: string): void {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized) ?? [];
    if (!queue.includes(subagent)) {
        queue.push(subagent);
    }
    promptMap.set(normalized, queue);
}

function consumeTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string): string | undefined {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return undefined;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    const subagent = queue.shift();
    if (queue.length === 0) {
        promptMap.delete(normalized);
    }
    return subagent;
}

function consumeSinglePendingTaskSubagent(state: ClaudeSessionProtocolState): string | undefined {
    const promptMap = getTaskPromptToSubagents(state);
    let candidateKey: string | null = null;
    let candidateSubagent: string | null = null;

    for (const [prompt, queue] of promptMap.entries()) {
        if (queue.length === 0) {
            continue;
        }

        if (candidateKey !== null) {
            return undefined;
        }

        candidateKey = prompt;
        candidateSubagent = queue[0] ?? null;
    }

    if (!candidateKey || !candidateSubagent) {
        return undefined;
    }

    const queue = promptMap.get(candidateKey);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    queue.shift();
    if (queue.length === 0) {
        promptMap.delete(candidateKey);
    }

    return candidateSubagent;
}

function pickSidechainRootPrompt(message: RawJSONLines): string | undefined {
    if (message.type !== 'user') {
        return undefined;
    }

    if (typeof message.message?.content === 'string') {
        const normalized = normalizePrompt(message.message.content);
        return normalized.length > 0 ? normalized : undefined;
    }

    return undefined;
}

function resolveProviderSubagent(message: RawJSONLines, state: ClaudeSessionProtocolState): string | undefined {
    const explicitSubagent = pickProviderSubagent(message);
    if (explicitSubagent) {
        return explicitSubagent;
    }

    const parentUuid = pickParentUuid(message);
    if (parentUuid) {
        const inheritedSubagent = getUuidToProviderSubagent(state).get(parentUuid);
        if (inheritedSubagent) {
            return inheritedSubagent;
        }
    }

    if (!isSidechainMessage(message)) {
        return undefined;
    }

    const prompt = pickSidechainRootPrompt(message);
    if (prompt) {
        const matchedSubagent = consumeTaskPromptSubagent(state, prompt);
        if (matchedSubagent) {
            return matchedSubagent;
        }
    }

    if (!parentUuid) {
        return consumeSinglePendingTaskSubagent(state);
    }

    return undefined;
}

function rememberSubagentForMessage(message: RawJSONLines, state: ClaudeSessionProtocolState, providerSubagent: string | undefined): void {
    if (!providerSubagent) {
        return;
    }

    const uuid = pickUuid(message);
    if (!uuid) {
        return;
    }

    getUuidToProviderSubagent(state).set(uuid, providerSubagent);
}

function pickTaskPrompt(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const prompt = (input as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string') {
        return undefined;
    }

    const normalized = normalizePrompt(prompt);
    return normalized.length > 0 ? normalized : undefined;
}

function pickTaskTitle(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const candidateKeys = ['description', 'title', 'subagent_type'];
    for (const key of candidateKeys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return undefined;
}

function setSubagentTitle(state: ClaudeSessionProtocolState, subagent: string, title: string | undefined): void {
    if (!title || title.trim().length === 0) {
        return;
    }
    getSubagentTitles(state).set(subagent, title.trim());
}

function maybeEmitSubagentStart(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string | undefined,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent) {
        return;
    }

    const started = getStartedSubagents(state);
    if (started.has(subagent)) {
        return;
    }

    const title = getSubagentTitles(state).get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
    }, { turn, subagent }));
    started.add(subagent);
    getActiveSubagents(state).add(subagent);
}

function maybeEmitSubagentStop(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string,
    envelopes: SessionEnvelope[],
): void {
    const active = getActiveSubagents(state);
    if (!active.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { turn, subagent }));
    active.delete(subagent);
}

function emitActiveSubagentStops(
    state: ClaudeSessionProtocolState,
    turn: string,
    envelopes: SessionEnvelope[],
): void {
    const active = getActiveSubagents(state);
    for (const subagent of active) {
        envelopes.push(createEnvelope('agent', { t: 'stop' }, { turn, subagent }));
    }
    active.clear();
}

function clearSubagentTracking(state: ClaudeSessionProtocolState): void {
    getUuidToProviderSubagent(state).clear();
    getTaskPromptToSubagents(state).clear();
    getProviderSubagentToSessionSubagent(state).clear();
    getSubagentTitles(state).clear();
    getBufferedSubagentMessages(state).clear();
    getHiddenParentToolCalls(state).clear();
    getStartedSubagents(state).clear();
    getActiveSubagents(state).clear();
}

function ensureTurn(state: ClaudeSessionProtocolState, envelopes: SessionEnvelope[]): string {
    if (state.currentTurnId) {
        return state.currentTurnId;
    }

    const turnId = createId();
    envelopes.push(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
    state.currentTurnId = turnId;
    return turnId;
}

function usageFromClaudeMessage(message: RawJSONLines): SessionUsage | undefined {
    if (message.type !== 'assistant') {
        return undefined;
    }
    const usage = message.message?.usage;
    if (!usage) {
        return undefined;
    }
    // Synthetic messages send `service_tier: null`; the wire type only carries
    // string | undefined, so normalise rather than widen the protocol.
    return { ...usage, service_tier: usage.service_tier ?? undefined };
}

function canCarryUsage(envelope: SessionEnvelope): boolean {
    return envelope.ev.t !== 'turn-start'
        && envelope.ev.t !== 'turn-end'
        && envelope.ev.t !== 'start'
        && envelope.ev.t !== 'stop';
}

function attachUsageToLastEnvelope(
    envelopes: SessionEnvelope[],
    firstCandidateIndex: number,
    usage: SessionUsage | undefined,
): void {
    if (!usage) {
        return;
    }

    for (let i = envelopes.length - 1; i >= firstCandidateIndex; i -= 1) {
        if (canCarryUsage(envelopes[i])) {
            envelopes[i] = {
                ...envelopes[i],
                usage,
            };
            return;
        }
    }
}

/** At most one `task_progress` envelope per task per this interval, so the relay is not flooded. */
const TASK_PROGRESS_MIN_INTERVAL_MS = 5_000;

const TASK_STATUSES: ReadonlySet<string> = new Set([
    'pending',
    'running',
    'completed',
    'failed',
    'killed',
    'paused',
    'stopped',
    'cancelled',
]);

function getTaskProgressSentAt(state: ClaudeSessionProtocolState): Map<string, number> {
    if (!state.taskProgressSentAt) {
        state.taskProgressSentAt = new Map<string, number>();
    }
    return state.taskProgressSentAt;
}

function getPendingTaskProgress(state: ClaudeSessionProtocolState): Map<string, { envelope: SessionEnvelope; at: number }> {
    if (!state.pendingTaskProgress) {
        state.pendingTaskProgress = new Map<string, { envelope: SessionEnvelope; at: number }>();
    }
    return state.pendingTaskProgress;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

function taskNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function taskStatus(value: unknown): SessionTaskStatus | undefined {
    return typeof value === 'string' && TASK_STATUSES.has(value) ? value as SessionTaskStatus : undefined;
}

function taskUsage(value: unknown): { totalTokens?: number; toolUses?: number; durationMs?: number } | undefined {
    const usage = asRecord(value);
    if (!usage) {
        return undefined;
    }
    const totalTokens = taskNumber(usage.total_tokens);
    const toolUses = taskNumber(usage.tool_uses);
    const durationMs = taskNumber(usage.duration_ms);
    if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
        return undefined;
    }
    return {
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(toolUses !== undefined ? { toolUses } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
    };
}

function throttleTaskProgress(
    state: ClaudeSessionProtocolState,
    envelopes: SessionEnvelope[],
    taskId: string,
    event: Omit<SessionTaskEvent, 't'>,
): void {
    const now = Date.now();
    const sentAt = getTaskProgressSentAt(state).get(taskId);
    if (sentAt === undefined || now - sentAt >= TASK_PROGRESS_MIN_INTERVAL_MS) {
        envelopes.push(createEnvelope('agent', { t: 'task', ...event }, { time: now }));
        getTaskProgressSentAt(state).set(taskId, now);
        getPendingTaskProgress(state).delete(taskId);
        return;
    }
    // Held back, replacing the previous held one: the last progress before a
    // status change is flushed first by `flushPendingTaskProgress`.
    getPendingTaskProgress(state).set(taskId, {
        envelope: createEnvelope('agent', { t: 'task', ...event }, { time: now }),
        at: now,
    });
}

function flushPendingTaskProgress(
    state: ClaudeSessionProtocolState,
    envelopes: SessionEnvelope[],
    taskId: string,
): void {
    const pending = getPendingTaskProgress(state);
    const held = pending.get(taskId);
    if (!held) {
        return;
    }
    pending.delete(taskId);
    envelopes.push(held.envelope);
    getTaskProgressSentAt(state).set(taskId, held.at);
}

function flushAllPendingTaskProgress(
    state: ClaudeSessionProtocolState,
    envelopes: SessionEnvelope[],
): void {
    for (const taskId of [...getPendingTaskProgress(state).keys()]) {
        flushPendingTaskProgress(state, envelopes, taskId);
    }
}

/**
 * The Claude Agent SDK's background-task system messages, forwarded as the
 * additive `task` event. Every other system message stays dropped. The app
 * gets `started`/`updated`/`notification` in order, and at most one
 * `progress` per task per 5 s (the last one always follows a status change).
 */
function mapTaskSystemMessage(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
    envelopes: SessionEnvelope[],
): void {
    const raw = message as unknown as Record<string, unknown>;
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
    if (subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_updated' && subtype !== 'task_notification') {
        return;
    }

    const taskId = firstString(raw.task_id, raw.taskId);
    if (!taskId) {
        return;
    }
    const toolUseId = firstString(raw.tool_use_id, raw.toolUseId);

    if (subtype === 'task_started') {
        flushPendingTaskProgress(state, envelopes, taskId);
        const description = firstString(raw.description);
        const taskType = firstString(raw.task_type, raw.subagent_type);
        const isBackgrounded = typeof raw.is_backgrounded === 'boolean' ? raw.is_backgrounded : undefined;
        envelopes.push(createEnvelope('agent', {
            t: 'task',
            phase: 'started',
            taskId,
            ...(toolUseId ? { toolUseId } : {}),
            ...(description ? { description } : {}),
            ...(taskType ? { taskType } : {}),
            ...(isBackgrounded !== undefined ? { isBackgrounded } : {}),
        }));
        return;
    }

    if (subtype === 'task_progress') {
        const description = firstString(raw.description);
        const summary = firstString(raw.summary);
        const lastToolName = firstString(raw.last_tool_name, raw.lastToolName);
        const usage = taskUsage(raw.usage);
        throttleTaskProgress(state, envelopes, taskId, {
            phase: 'progress',
            taskId,
            ...(toolUseId ? { toolUseId } : {}),
            ...(description ? { description } : {}),
            ...(summary ? { summary } : {}),
            ...(lastToolName ? { lastToolName } : {}),
            ...(usage ? { usage } : {}),
        });
        return;
    }

    if (subtype === 'task_updated') {
        flushPendingTaskProgress(state, envelopes, taskId);
        const patch = asRecord(raw.patch) ?? {};
        const description = firstString(patch.description, raw.description);
        const status = taskStatus(patch.status);
        const isBackgrounded = typeof patch.is_backgrounded === 'boolean'
            ? patch.is_backgrounded
            : typeof raw.is_backgrounded === 'boolean'
                ? raw.is_backgrounded
                : undefined;
        envelopes.push(createEnvelope('agent', {
            t: 'task',
            phase: 'updated',
            taskId,
            ...(toolUseId ? { toolUseId } : {}),
            ...(description ? { description } : {}),
            ...(status ? { status } : {}),
            ...(isBackgrounded !== undefined ? { isBackgrounded } : {}),
        }));
        return;
    }

    flushPendingTaskProgress(state, envelopes, taskId);
    const status = taskStatus(raw.status);
    const summary = firstString(raw.summary);
    const outputFile = firstString(raw.output_file, raw.outputFile);
    const usage = taskUsage(raw.usage);
    envelopes.push(createEnvelope('agent', {
        t: 'task',
        phase: 'notification',
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
        ...(outputFile ? { outputFile } : {}),
        ...(usage ? { usage } : {}),
    }));
}

function closeTurn(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    envelopes: SessionEnvelope[],
): void {
    if (!state.currentTurnId) {
        return;
    }

    emitActiveSubagentStops(state, state.currentTurnId, envelopes);
    envelopes.push(createEnvelope('agent', { t: 'turn-end', status }, { turn: state.currentTurnId }));
    state.currentTurnId = null;
    clearSubagentTracking(state);
}

function toolTitle(name: string, input: unknown): string {
    if (input && typeof input === 'object') {
        const description = (input as { description?: unknown }).description;
        if (typeof description === 'string' && description.trim().length > 0) {
            return description.length > 80 ? `${description.slice(0, 77)}...` : description;
        }
    }
    return `${name} call`;
}

function toToolArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as Record<string, unknown>;
    }
    if (input === undefined) {
        return {};
    }
    return { input };
}

export function closeClaudeTurnWithStatus(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    flushAllPendingTaskProgress(state, envelopes);
    closeTurn(state, status, envelopes);
    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}

export function mapClaudeLogMessageToSessionEnvelopes(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    return mapClaudeLogMessageToSessionEnvelopesInternal(message, state);
}

function mapClaudeLogMessageToSessionEnvelopesInternal(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    const claudeUuid = pickUuid(message);
    const providerSubagent = resolveProviderSubagent(message, state);
    const subagent = providerSubagent
        ? getSessionSubagentIdForProviderSubagent(state, providerSubagent)
        : undefined;
    rememberSubagentForMessage(message, state, providerSubagent);

    if (providerSubagent && !subagent) {
        bufferSubagentMessage(state, providerSubagent, message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [],
        };
    }

    if (message.type === 'summary') {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'system') {
        mapTaskSystemMessage(message, state, envelopes);
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if ((message as any).isCompactSummary) {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'assistant') {
        const firstUsageCandidateIndex = envelopes.length;
        const usage = usageFromClaudeMessage(message);
        const turnId = ensureTurn(state, envelopes);
        maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];

        for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid }));
                continue;
            }

            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.thinking, thinking: true }, { turn: turnId, subagent, claudeUuid }));
                continue;
            }

            if (block.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId();
                const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
                const baseArgs = toToolArgs(block.input);
                const title = toolTitle(name, block.input);
                const sessionSubagentForCall = ensureSessionSubagentIdForProviderSubagent(state, call);
                if (isSubagentTool(name)) {
                    const prompt = pickTaskPrompt(block.input);
                    if (prompt) {
                        queueTaskPromptSubagent(state, prompt, call);
                    }
                    setSubagentTitle(state, sessionSubagentForCall, pickTaskTitle(block.input) ?? prompt);
                }
                if (shouldHideParentToolCall(name)) {
                    getHiddenParentToolCalls(state).add(call);

                    const buffered = consumeBufferedSubagentMessages(state, call);
                    for (const bufferedMessage of buffered) {
                        const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                        envelopes.push(...replay.envelopes);
                    }
                    continue;
                }
                const args = isSubagentTool(name)
                    ? { ...baseArgs, sessionSubagent: sessionSubagentForCall }
                    : baseArgs;

                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name,
                    title,
                    description: title,
                    args,
                }, { turn: turnId, subagent }));
                const buffered = consumeBufferedSubagentMessages(state, call);
                for (const bufferedMessage of buffered) {
                    const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                    envelopes.push(...replay.envelopes);
                }
            }
        }

        attachUsageToLastEnvelope(envelopes, firstUsageCandidateIndex, usage);

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'user') {
        // SDK-injected synthetic user messages (e.g. the Skill tool feeds
        // the skill prompt back to Claude as a 'user' message with
        // isMeta=true so the model sees it but the human shouldn't).
        // Without this skip the prompt body — easily 10–20k characters —
        // gets emitted as an agent-text envelope and lands in the chat as
        // a wall of text.
        if (message.isMeta) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }
        if (typeof message.message.content === 'string') {
            if (message.isSidechain) {
                const turnId = ensureTurn(state, envelopes);
                maybeEmitSubagentStart(state, turnId, subagent, envelopes);
                envelopes.push(createEnvelope('agent', { t: 'text', text: message.message.content }, { turn: turnId, subagent, claudeUuid }));
            } else {
                closeTurn(state, 'completed', envelopes);
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }, { claudeUuid }));
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        if (blocks.length === 0) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const hasToolResult = blocks.some((block) => {
            return block?.type === 'tool_result';
        });
        if (!message.isSidechain && !hasToolResult) {
            closeTurn(state, 'completed', envelopes);
            for (const block of blocks) {
                if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                    envelopes.push(createEnvelope('user', { t: 'text', text: block.text }, { claudeUuid }));
                }
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const turnId = ensureTurn(state, envelopes);
        if (message.isSidechain) {
            maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        }
        for (const block of blocks) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
                const sessionSubagentForToolResult = getSessionSubagentIdForProviderSubagent(state, block.tool_use_id);
                if (!message.isSidechain) {
                    if (getHiddenParentToolCalls(state).has(block.tool_use_id)) {
                        if (sessionSubagentForToolResult) {
                            maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                        }
                        getHiddenParentToolCalls(state).delete(block.tool_use_id);
                        continue;
                    }
                    if (sessionSubagentForToolResult) {
                        maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                    }
                }
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                }, { turn: turnId, subagent }));
                continue;
            }

            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid }));
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}
