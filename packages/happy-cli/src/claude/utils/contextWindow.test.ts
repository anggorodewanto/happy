/**
 * Tests for context-window inference and stamping used by local mode.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    DEFAULT_CLAUDE_CONTEXT_WINDOW,
    LARGE_CLAUDE_CONTEXT_WINDOW,
    asksForLargeContext,
    contextWindowForMessage,
    inferContextWindow,
    isClaudeModel,
    measuredContextTokens,
    modelFromArgs,
    recordContextWindow,
    resolveConfiguredModel,
    stampContextWindow,
} from './contextWindow';
import type { RawJSONLines } from '@/claude/types';

const assistantWithUsage = (model: string | undefined, usage: Record<string, unknown>): RawJSONLines => ({
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
        role: 'assistant',
        ...(model ? { model } : {}),
        content: [{ type: 'text', text: 'hi' }],
        usage,
    },
} as unknown as RawJSONLines);

describe('model helpers', () => {
    it('recognizes Claude models', () => {
        expect(isClaudeModel('claude-opus-4-8')).toBe(true);
        expect(isClaudeModel('Claude-Sonnet-4-5')).toBe(true);
        expect(isClaudeModel('gpt-5')).toBe(false);
        expect(isClaudeModel(undefined)).toBe(false);
    });

    it('recognizes the 1M context suffix case-insensitively', () => {
        expect(asksForLargeContext('claude-opus-4-8[1m]')).toBe(true);
        expect(asksForLargeContext('claude-opus-4-8[1M]')).toBe(true);
        expect(asksForLargeContext('claude-opus-4-8')).toBe(false);
        expect(asksForLargeContext(undefined)).toBe(false);
    });

    it('extracts --model from Claude args in both forms, last one winning', () => {
        expect(modelFromArgs(['--model', 'claude-opus-4-8'])).toBe('claude-opus-4-8');
        expect(modelFromArgs(['--model=claude-opus-4-8[1m]'])).toBe('claude-opus-4-8[1m]');
        expect(modelFromArgs(['--model', 'claude-haiku-4-5', '--model', 'claude-opus-4-8'])).toBe('claude-opus-4-8');
        expect(modelFromArgs(['--resume', 'abc'])).toBe(undefined);
        expect(modelFromArgs(undefined)).toBe(undefined);
    });
});

describe('measuredContextTokens', () => {
    it('sums every measured input bucket', () => {
        expect(measuredContextTokens({
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
        })).toBe(60);
    });

    it('treats missing buckets as zero', () => {
        expect(measuredContextTokens({ input_tokens: 10 })).toBe(10);
        expect(measuredContextTokens(undefined)).toBe(0);
    });
});

describe('inferContextWindow', () => {
    it('defaults Claude models to 200K', () => {
        expect(inferContextWindow({ model: 'claude-opus-4-8' })).toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    });

    it('uses 1M when the message or configured model asks for it', () => {
        expect(inferContextWindow({ model: 'claude-opus-4-8[1m]' })).toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
        expect(inferContextWindow({
            model: 'claude-opus-4-8',
            configuredModel: 'claude-opus-4-8[1m]',
        })).toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
    });

    it('applies a configured [1m] model only to messages from that model', () => {
        expect(inferContextWindow({ model: 'claude-opus-4-8', configuredModel: 'opus[1m]' }))
            .toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
        expect(inferContextWindow({ model: 'claude-haiku-4-5', configuredModel: 'opus[1m]' }))
            .toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW);
        expect(inferContextWindow({ model: 'claude-haiku-4-5', configuredModel: 'claude-opus-4-8[1m]' }))
            .toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    });

    it('uses 1M once a turn already exceeds 200K', () => {
        expect(inferContextWindow({ model: 'claude-opus-4-8', measuredTokens: 200_001 }))
            .toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
        expect(inferContextWindow({ model: 'claude-opus-4-8', measuredTokens: 200_000 }))
            .toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    });

    it('leaves non-Claude and unknown models alone', () => {
        expect(inferContextWindow({ model: 'gpt-5' })).toBe(undefined);
        expect(inferContextWindow({ model: undefined })).toBe(undefined);
    });
});

describe('contextWindowForMessage', () => {
    it('prefers a window measured earlier for the same model', () => {
        const windows = new Map([['claude-opus-4-8', 500_000]]);

        expect(contextWindowForMessage({
            windows,
            model: 'claude-opus-4-8',
            configuredModel: 'claude-opus-4-8[1m]',
        })).toBe(500_000);
    });

    it('does not reuse another model\'s window', () => {
        const windows = new Map([['claude-opus-4-8', 1_000_000]]);

        expect(contextWindowForMessage({ windows, model: 'claude-haiku-4-5' }))
            .toBe(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    });
});

describe('stampContextWindow', () => {
    it('keeps the 1M window for later turns once a turn proves it', () => {
        const windows = new Map<string, number>();
        stampContextWindow(assistantWithUsage('claude-opus-4-8', { input_tokens: 250_000, output_tokens: 5 }), { windows });

        const later = stampContextWindow(assistantWithUsage('claude-opus-4-8', { input_tokens: 10, output_tokens: 5 }), { windows });

        expect((later as any).message.usage.context_window).toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
    });

    it('stamps context_window without mutating the input message', () => {
        const message = assistantWithUsage('claude-opus-4-8', { input_tokens: 10, output_tokens: 5 });

        const stamped = stampContextWindow(message, { windows: new Map() });

        expect((stamped as any).message.usage).toEqual({
            input_tokens: 10,
            output_tokens: 5,
            context_window: DEFAULT_CLAUDE_CONTEXT_WINDOW,
        });
        expect((message as any).message.usage).not.toHaveProperty('context_window');
    });

    it('stamps the learned window for the message model', () => {
        const windows = new Map([['claude-haiku-4-5', 200_000]]);

        const stamped = stampContextWindow(
            assistantWithUsage('claude-haiku-4-5', { input_tokens: 10, output_tokens: 5 }),
            { windows },
        );

        expect((stamped as any).message.usage.context_window).toBe(200_000);
    });

    it('uses 1M when the turn already exceeds 200K', () => {
        const stamped = stampContextWindow(
            assistantWithUsage('claude-sonnet-4-5', {
                input_tokens: 5,
                cache_read_input_tokens: 250_000,
                output_tokens: 5,
            }),
            { windows: new Map() },
        );

        expect((stamped as any).message.usage.context_window).toBe(LARGE_CLAUDE_CONTEXT_WINDOW);
    });

    it('returns non-assistant, usage-less and unknown-model messages untouched', () => {
        const user = {
            type: 'user',
            uuid: 'user-1',
            message: { content: 'hi' },
        } as unknown as RawJSONLines;
        const noUsage = {
            type: 'assistant',
            uuid: 'assistant-2',
            message: { role: 'assistant', model: 'claude-opus-4-8', content: [] },
        } as unknown as RawJSONLines;
        const otherModel = assistantWithUsage('gpt-5', { input_tokens: 10, output_tokens: 5 });

        const windows = new Map<string, number>();
        expect(stampContextWindow(user, { windows })).toBe(user);
        expect(stampContextWindow(noUsage, { windows })).toBe(noUsage);
        expect(stampContextWindow(otherModel, { windows })).toBe(otherModel);
    });
});

describe('recordContextWindow', () => {
    it('stores usable windows and ignores broken values', () => {
        const windows = new Map<string, number>();

        recordContextWindow(windows, 'claude-opus-4-8', 1_000_000);
        recordContextWindow(windows, 'claude-haiku-4-5', 0);
        recordContextWindow(windows, 'claude-haiku-4-5', Number.NaN);

        expect(windows.get('claude-opus-4-8')).toBe(1_000_000);
        expect(windows.has('claude-haiku-4-5')).toBe(false);
    });
});

describe('resolveConfiguredModel', () => {
    let testRoot: string;
    let userConfigDir: string;
    let projectDir: string;
    let originalClaudeConfigDir: string | undefined;
    let originalAnthropicModel: string | undefined;

    const writeSettings = (path: string, settings: Record<string, unknown>) => {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify(settings));
    };

    beforeEach(() => {
        testRoot = mkdtempSync(join(tmpdir(), 'happy-context-window-'));
        userConfigDir = join(testRoot, 'user');
        projectDir = join(testRoot, 'project');
        mkdirSync(userConfigDir, { recursive: true });
        mkdirSync(projectDir, { recursive: true });

        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        originalAnthropicModel = process.env.ANTHROPIC_MODEL;
        process.env.CLAUDE_CONFIG_DIR = userConfigDir;
        delete process.env.ANTHROPIC_MODEL;
    });

    afterEach(() => {
        if (originalClaudeConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        } else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        if (originalAnthropicModel !== undefined) {
            process.env.ANTHROPIC_MODEL = originalAnthropicModel;
        } else {
            delete process.env.ANTHROPIC_MODEL;
        }
        rmSync(testRoot, { recursive: true, force: true });
    });

    it('prefers --model args, then ANTHROPIC_MODEL, then settings', () => {
        writeSettings(join(userConfigDir, 'settings.json'), { model: 'claude-from-user-settings' });
        process.env.ANTHROPIC_MODEL = 'claude-from-env';

        expect(resolveConfiguredModel({
            claudeArgs: ['--model', 'claude-from-args'],
            cwd: projectDir,
        })).toBe('claude-from-args');

        expect(resolveConfiguredModel({ cwd: projectDir })).toBe('claude-from-env');

        delete process.env.ANTHROPIC_MODEL;
        expect(resolveConfiguredModel({ cwd: projectDir })).toBe('claude-from-user-settings');
    });

    it('reads claudeEnvVars over process env', () => {
        process.env.ANTHROPIC_MODEL = 'claude-from-process-env';

        expect(resolveConfiguredModel({
            claudeEnvVars: { ANTHROPIC_MODEL: 'claude-from-session-env' },
            cwd: projectDir,
        })).toBe('claude-from-session-env');
    });

    it('lets the most specific settings file win', () => {
        writeSettings(join(userConfigDir, 'settings.json'), { model: 'claude-from-user-settings' });
        writeSettings(join(projectDir, '.claude', 'settings.json'), { model: 'claude-opus-4-8[1m]' });

        expect(resolveConfiguredModel({ cwd: projectDir })).toBe('claude-opus-4-8[1m]');

        writeSettings(join(projectDir, '.claude', 'settings.local.json'), { model: 'claude-haiku-4-5' });

        expect(resolveConfiguredModel({ cwd: projectDir })).toBe('claude-haiku-4-5');
    });

    it('skips settings files that do not set a model', () => {
        writeSettings(join(userConfigDir, 'settings.json'), { model: 'claude-from-user-settings' });
        writeSettings(join(projectDir, '.claude', 'settings.json'), { includeCoAuthoredBy: false });

        expect(resolveConfiguredModel({ cwd: projectDir })).toBe('claude-from-user-settings');
    });
});
