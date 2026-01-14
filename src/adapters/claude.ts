import { execSync } from 'child_process';
import { AgentAdapter, SpawnArgs, registerAdapter } from './base.js';

const claudeAdapter: AgentAdapter = {
  type: 'claude',

  buildSpawnArgs(prompt: string, skipPermissions: boolean): SpawnArgs {
    // Build argv array for safe execution (no shell)
    const args: string[] = [];

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Pass prompt via -p flag
    args.push('-p', prompt);

    // Request stream-json output for structured parsing (includes sessionId)
    args.push('--output-format', 'stream-json');

    return {
      cmd: 'claude',
      args,
    };
  },

  buildContinueArgs(sessionId: string, prompt: string, skipPermissions: boolean): SpawnArgs {
    // Use --continue to resume a session
    const args: string[] = [];

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Continue the session with the given ID
    args.push('--continue', sessionId);

    // Pass the follow-up prompt
    args.push('-p', prompt);

    // Request stream-json output
    args.push('--output-format', 'stream-json');

    return {
      cmd: 'claude',
      args,
    };
  },

  extractSessionId(output: string): string | null {
    // Claude stream-json output includes sessionId in the result message
    // Format: {"type":"result","sessionId":"...","cost_usd":...}
    const sessionIdMatch = output.match(/"sessionId"\s*:\s*"([^"]+)"/);
    if (sessionIdMatch) {
      return sessionIdMatch[1];
    }

    // Also check for session_id format
    const altMatch = output.match(/"session_id"\s*:\s*"([^"]+)"/);
    return altMatch ? altMatch[1] : null;
  },

  buildResumePrompt(workSummary: string, remainingCriteria: string[]): string {
    const criteriaList = remainingCriteria.length > 0
      ? remainingCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '(all criteria completed)';

    return `RESUMING FROM PAUSE (previous session)

## Summary of work done so far:
${workSummary}

## Remaining acceptance criteria:
${criteriaList}

Please continue working on this task. Review the summary above and pick up where you left off. When each criterion is complete, emit <criterion-complete>N</criterion-complete>. When all criteria are done, emit <promise>TASK COMPLETE</promise>.`;
  },

  isAvailable(): boolean {
    try {
      execSync('which claude', { encoding: 'utf-8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },
};

// Register on import
registerAdapter(claudeAdapter);

export { claudeAdapter };
