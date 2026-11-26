import { describe, expect, it } from 'vitest';
import { OutgoingMessageQueue } from './OutgoingMessageQueue';

describe('OutgoingMessageQueue', () => {
    it('forwards background-task system messages and keeps every other system message local', async () => {
        const sent: any[] = [];
        const queue = new OutgoingMessageQueue((message) => sent.push(message));

        queue.enqueue({ type: 'system', subtype: 'init', session_id: 's1' });
        queue.enqueue({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1' });
        queue.enqueue({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        queue.enqueue({ type: 'system', subtype: 'task_progress', task_id: 'b1' });
        queue.enqueue({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } });
        queue.enqueue({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
        queue.enqueue({ type: 'assistant', uuid: 'a1' });
        await queue.flush();
        queue.destroy();

        expect(sent.map((m) => m.subtype ?? m.type)).toEqual([
            'task_started',
            'task_progress',
            'task_updated',
            'task_notification',
            'assistant',
        ]);
    });
});
