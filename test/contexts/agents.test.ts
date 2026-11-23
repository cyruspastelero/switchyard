import { describe, it, expect } from '../support/harness.ts';
import { deriveAgentStatus, describeAction } from '../../src/contexts/agents.ts';
import type { LatestEvent } from '../../src/contexts/store.ts';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const notification = (input: Record<string, unknown> | null): LatestEvent => ({
  event_type: 'Notification', tool_name: null, tool_input: input ? JSON.stringify(input) : null, timestamp: '2026-01-01T11:59:00Z',
});

describe('waiting means the owner must act', () => {
  it('a_permission_prompt_is_waiting', () => {
    const latest = notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(deriveAgentStatus(latest, NOW, 'PreToolUse')).toBe('waiting');
    expect(describeAction(latest, 'PreToolUse')).toBe('needs your input');
  });
  it('a_question_dialog_is_waiting', () => {
    expect(deriveAgentStatus(notification({ notification_type: 'elicitation_dialog' }), NOW, 'PreToolUse')).toBe('waiting');
  });
  it('the_idle_reminder_a_minute_after_finishing_is_not_waiting', () => {
    const latest = notification({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(deriveAgentStatus(latest, NOW, 'Stop')).toBe('idle');
    expect(describeAction(latest, 'Stop')).toBe('finished');
  });
  it('without_a_type_the_message_decides', () => {
    expect(deriveAgentStatus(notification({ message: 'Claude is waiting for your input' }), NOW, 'PreToolUse')).toBe('idle');
    expect(deriveAgentStatus(notification({ message: 'Claude needs your permission to use Bash' }), NOW, 'Stop')).toBe('waiting');
  });
  it('a_bare_notification_right_after_a_stop_means_finished', () => {
    expect(deriveAgentStatus(notification(null), NOW, 'Stop')).toBe('idle');
    expect(describeAction(notification(null), 'Stop')).toBe('finished');
  });
  it('a_bare_notification_in_the_middle_of_a_turn_is_waiting', () => {
    expect(deriveAgentStatus(notification(null), NOW, 'PreToolUse')).toBe('waiting');
    expect(deriveAgentStatus(notification(null), NOW, 'UserPromptSubmit')).toBe('waiting');
  });
  it('a_bare_notification_with_no_history_is_not_waiting', () => {
    expect(deriveAgentStatus(notification(null), NOW, null)).toBe('idle');
  });
});
