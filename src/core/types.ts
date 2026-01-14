// Loop statuses
export type LoopStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'stopped';

// Agent types
export type AgentType = 'claude' | 'codex';

// Acceptance criterion
export interface AcceptanceCriterion {
  text: string;
  completed: boolean;
  completedBy?: 'agent' | 'operator';
  completedAt?: string;
}

// GitHub issue data
export interface Issue {
  url: string;
  number: number;
  title: string;
  body: string;
  repo: string;           // owner/repo
  acceptanceCriteria: AcceptanceCriterion[];
  originalAcceptanceCriteria?: AcceptanceCriterion[];
}

// A single loop instance
export interface Loop {
  id: string;
  issue: Issue;
  agent: AgentType;
  status: LoopStatus;
  skipPermissions: boolean;
  issueClosed?: boolean;
  pid?: number;           // child process PID
  startedAt?: string;     // ISO timestamp
  endedAt?: string;       // ISO timestamp
  error?: string;         // error message if status === 'error'
  workingDir: string;     // cwd for the agent
  iteration?: number;     // current iteration count
  exitReason?: string;    // why the loop exited
  // Cross-session pause/resume fields
  pausedSessionId?: string;   // Claude session ID at time of pause
  pausedAt?: string;          // ISO timestamp when paused
  pausedFromPreviousSession?: boolean; // True if paused in a previous TUI session
}

// Log entry for JSONL
export interface LogEntry {
  timestamp: string;
  loopId: string;
  type: 'agent' | 'operator' | 'system' | 'error';
  content: string;
}

// App state persisted to disk
export interface AppState {
  loops: Loop[];
  activeLoopId?: string;
}

// Event types for loop manager
export type LoopEvent =
  | { type: 'started'; loopId: string }
  | { type: 'output'; loopId: string; data: string }
  | { type: 'paused'; loopId: string }
  | { type: 'resumed'; loopId: string }
  | { type: 'stopped'; loopId: string }
  | { type: 'completed'; loopId: string }
  | { type: 'error'; loopId: string; error: string }
  | { type: 'iteration'; loopId: string; iteration: number }
  | { type: 'criteria'; loopId: string };

// Circuit breaker states
export type CircuitState = 'closed' | 'half_open' | 'open';

// Circuit breaker data
export interface CircuitBreakerState {
  state: CircuitState;
  consecutiveNoProgress: number;
  consecutiveSameError: number;
  consecutiveTestOnly: number;
  lastErrors: string[];
  lastOutputLength: number;
  openReason?: string;
  openedAt?: string;
}

// Response analysis result
export interface AnalysisResult {
  hasCompletionSignal: boolean;
  isTestOnly: boolean;
  isStuck: boolean;
  hasProgress: boolean;
  exitSignal: boolean | null;    // null if not found
  completionIndicators: number;
  filesModified: number;
  outputLength: number;
  errors: string[];
  workSummary: string;
  confidenceScore: number;
}

// Exit reason for loop completion
export type ExitReason =
  | 'completion_signal'      // <promise>TASK COMPLETE</promise>
  | 'exit_signal'            // EXIT_SIGNAL: true in RALPH_STATUS
  | 'project_complete'       // completion_indicators >= 2 + exit_signal
  | 'test_saturation'        // consecutive test-only loops
  | 'circuit_breaker'        // circuit breaker opened
  | 'max_iterations'         // hit iteration limit
  | 'user_stopped'           // manual stop
  | 'error';                 // unrecoverable error

// Loop iteration state
export interface LoopIterationState {
  iteration: number;
  maxIterations: number;
  sessionId?: string;
  circuitBreaker: CircuitBreakerState;
  analysisHistory: AnalysisResult[];
  exitReason?: ExitReason;
}

// Rate limiter state
export interface RateLimiterState {
  callCount: number;
  windowStart: number;  // timestamp ms
  callsPerHour: number;
}
