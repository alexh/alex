import { AgentType } from '../core/types.js';

// Spawn arguments for safe execution (no shell)
export interface SpawnArgs {
  cmd: string;
  args: string[];
}

// Adapter interface for different AI agents
export interface AgentAdapter {
  type: AgentType;

  // Build argv array for initial prompt (no shell injection)
  buildSpawnArgs(prompt: string, skipPermissions: boolean): SpawnArgs;

  // Build argv array to continue/resume a session
  buildContinueArgs(sessionId: string, prompt: string, skipPermissions: boolean): SpawnArgs;

  // Extract session ID from agent output (returns null if not found)
  extractSessionId(output: string): string | null;

  // Build follow-up prompt for session continuity (optional)
  buildFollowUpPrompt?(context: string): string;

  // Build prompt for resuming from a paused state (cross-session resume)
  buildResumePrompt?(workSummary: string, remainingCriteria: string[]): string;

  // Check if agent CLI is available
  isAvailable(): boolean;
}

// Registry of adapters
const adapters: Map<AgentType, AgentAdapter> = new Map();

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getAdapter(type: AgentType): AgentAdapter | undefined {
  return adapters.get(type);
}

export function getAvailableAdapters(): AgentAdapter[] {
  return Array.from(adapters.values()).filter(a => a.isAvailable());
}
