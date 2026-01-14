import path from 'path';

// Paths
export const DATA_DIR = path.join(process.cwd(), 'data');
export const LOOPS_DIR = path.join(DATA_DIR, 'loops');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Theme colors (Cyberpunk/Vaporwave)
export const colors = {
  bg: '#0b0b0f',
  bgPanel: '#1a1a1f',
  text: '#eaeaea',
  textDim: '#666666',

  // Neon accents
  pink: '#ff4fd8',
  cyan: '#2de2e6',
  purple: '#9b5de5',

  // Border
  border: '#444444',

  // Status colors
  running: '#2de2e6',   // cyan
  paused: '#ffbe0b',    // yellow
  completed: '#00f5d4', // teal
  error: '#ff006e',     // red
  queued: '#666666',    // dim
  stopped: '#666666',   // dim
} as const;

// Agent CLI commands
export const AGENT_COMMANDS = {
  claude: 'claude --dangerously-skip-permissions',
  claude_safe: 'claude',
  codex: 'codex exec',
} as const;

// Tab names
export const TABS = ['All', 'Running', 'Paused', 'Completed', 'Errors'] as const;

// Loop settings
export const MAX_ITERATIONS_DEFAULT = 20;
export const STUCK_TIMEOUT_MINUTES = 5;
export const AUTO_COMPLETE_ON_CRITERIA = true;

// Circuit breaker thresholds
export const CB_NO_PROGRESS_THRESHOLD = 3;        // Open after N loops with no file changes
export const CB_SAME_ERROR_THRESHOLD = 5;         // Open after N loops with same errors
export const CB_OUTPUT_DECLINE_THRESHOLD = 0.7;   // Open if output declines >70%
export const CB_CONSECUTIVE_TEST_THRESHOLD = 3;   // Exit after N consecutive test-only loops

// Rate limiting
export const RATE_LIMIT_CALLS_PER_HOUR = 100;

// Timeouts
export const ITERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per iteration

// Completion promise tag
export const COMPLETION_PROMISE = '<promise>TASK COMPLETE</promise>';

// Ralph status block patterns
export const RALPH_STATUS_REGEX = /---RALPH_STATUS---[\s\S]*?STATUS:\s*(.*?)[\s\S]*?EXIT_SIGNAL:\s*(true|false)/i;

// Detection patterns
export const COMPLETION_PATTERNS = [
  /\bdone\b/i,
  /\bcomplete[d]?\b/i,
  /\bfinished\b/i,
  /all tasks complete/i,
  /project complete/i,
  /ready for review/i,
];

export const TEST_ONLY_PATTERNS = [
  /running tests/i,
  /npm test/i,
  /bun test/i,
  /pytest/i,
  /jest/i,
  /cargo test/i,
  /go test/i,
  /bats/i,
];

export const IMPLEMENTATION_PATTERNS = [
  /implementing/i,
  /creating/i,
  /writing/i,
  /adding/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /refactoring/i,
  /fixing/i,
];

export const NO_WORK_PATTERNS = [
  /nothing to do/i,
  /no changes/i,
  /already implemented/i,
  /up to date/i,
];
