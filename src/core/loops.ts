import { spawn, type Subprocess } from 'bun';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  Loop,
  LoopStatus,
  LoopEvent,
  Issue,
  AgentType,
  LoopIterationState,
  ExitReason,
  AcceptanceCriterion,
} from './types.js';
import { getAdapter, SpawnArgs } from '../adapters/index.js';
import { appendLog, generateResumeSummary } from './logs.js';
import { buildPromptFromIssue } from './issues.js';
import {
  COMPLETION_PROMISE,
  MAX_ITERATIONS_DEFAULT,
  CB_CONSECUTIVE_TEST_THRESHOLD,
  ITERATION_TIMEOUT_MS,
  AUTO_COMPLETE_ON_CRITERIA,
} from '../config.js';
import {
  loadState,
  saveState,
  updateLoop,
  addLoop,
  generateLoopId,
  ensureLoopDir,
} from './state.js';
import { analyzeResponse, shouldExit, GitBaselineInfo } from './analyzer.js';
import {
  createCircuitBreaker,
  recordIteration,
  shouldHalt,
  getHaltReason,
  getStatusSummary as getCbStatus,
} from './circuitBreaker.js';
import {
  createRateLimiter,
  checkRateLimit,
  recordCall,
  waitForRateLimit,
  getStatusSummary as getRlStatus,
} from './rateLimiter.js';

// Active subprocess handles
const processes: Map<string, Subprocess> = new Map();

// Iteration states per loop (in-memory during execution)
const iterationStates: Map<string, LoopIterationState> = new Map();
const criterionBuffers: Map<string, string> = new Map();

// Pending interventions - will be injected into next iteration prompt
const pendingInterventions: Map<string, string> = new Map();

// Event emitter for loop events
export const loopEvents = new EventEmitter();

// Emit a typed event
function emit(event: LoopEvent): void {
  loopEvents.emit('event', event);
  loopEvents.emit(event.type, event);
}

type CriterionUpdate = { index: number; completed: boolean };

function parseCriterionTags(chunk: string, buffer: string): { updates: CriterionUpdate[]; rest: string } {
  const updates: CriterionUpdate[] = [];
  const combined = buffer + chunk;
  const regex = /<criterion-(complete|incomplete)>(\d+)<\/criterion-\1>/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = regex.exec(combined)) !== null) {
    const type = match[1];
    const idx = parseInt(match[2], 10);
    if (!Number.isNaN(idx) && idx > 0) {
      updates.push({ index: idx - 1, completed: type === 'complete' });
    }
    lastIndex = regex.lastIndex;
  }

  let rest = combined;
  if (lastIndex > 0) {
    rest = combined.slice(lastIndex);
  }
  if (rest.length > 2000) {
    rest = rest.slice(-2000);
  }

  return { updates, rest };
}

function applyCriterionUpdates(loopId: string, updates: CriterionUpdate[], completedBy: 'agent' | 'operator'): void {
  if (updates.length === 0) return;

  let state = loadState();
  const loop = state.loops.find(l => l.id === loopId);
  if (!loop) return;

  let changed = false;
  const criteria = loop.issue.acceptanceCriteria;

  for (const update of updates) {
    if (update.index < 0 || update.index >= criteria.length) continue;
    const criterion = criteria[update.index];
    const nextCompleted = update.completed;
    const nextBy = nextCompleted ? completedBy : undefined;
    if (criterion.completed !== nextCompleted || criterion.completedBy !== nextBy) {
      criterion.completed = nextCompleted;
      criterion.completedBy = nextBy;
      criterion.completedAt = nextCompleted ? new Date().toISOString() : undefined;
      appendLog(loopId, {
        type: 'system',
        content: `Criterion ${update.index + 1} marked ${nextCompleted ? 'complete' : 'incomplete'} by ${completedBy}`,
      });
      changed = true;
    }
  }

  if (changed) {
    state = updateLoop(state, loopId, { issue: loop.issue });
    saveState(state);
    emit({ type: 'criteria', loopId });
  }
}

function getIncompleteCriteria(criteria: AcceptanceCriterion[]): string[] {
  return criteria
    .map((criterion, idx) => ({ criterion, idx }))
    .filter(item => !item.criterion.completed)
    .map(item => `${item.idx + 1}. ${item.criterion.text}`);
}

// Create a new loop from an issue
export function createLoop(
  issue: Issue,
  agent: AgentType,
  skipPermissions: boolean,
  workingDir: string
): Loop {
  const id = generateLoopId();
  ensureLoopDir(id);

  const loop: Loop = {
    id,
    issue,
    agent,
    status: 'queued',
    skipPermissions,
    workingDir,
    iteration: 0,
  };

  // Save to state
  let state = loadState();
  state = addLoop(state, loop);
  saveState(state);

  appendLog(id, { type: 'system', content: `Loop created for issue: ${issue.title}` });

  return loop;
}

/**
 * Capture git baseline for progress detection.
 * Returns the set of dirty files AND their content hashes.
 */
function captureGitBaseline(workingDir: string): GitBaselineInfo | null {
  try {
    // Capture initial dirty files (modified, staged, untracked)
    // Using --porcelain for machine-readable output
    // Use execFileSync with argv to avoid shell injection
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const initialDirtyFiles = new Set<string>();
    const initialFileHashes = new Map<string, string>();

    for (const line of statusOutput.split('\n')) {
      if (line.length > 3) {
        // Format: "XY filename" or "XY filename -> newname" for renames
        const filename = line.substring(3).split(' -> ')[0];
        initialDirtyFiles.add(filename);

        // Capture content hash for this file (safe - no shell, passes file as argv)
        try {
          const hash = execFileSync('git', ['hash-object', '--', filename], {
            cwd: workingDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          initialFileHashes.set(filename, hash);
        } catch {
          // File might be deleted or inaccessible - try fs fallback
          try {
            const content = readFileSync(join(workingDir, filename));
            initialFileHashes.set(filename, createHash('sha256').update(content).digest('hex'));
          } catch {
            // File truly inaccessible
          }
        }
      }
    }

    return { initialDirtyFiles, initialFileHashes };
  } catch {
    return null;
  }
}

/**
 * Start a loop with multi-iteration support.
 * Uses session continuity via agent's --continue mechanism.
 */
export async function startLoop(loopId: string): Promise<void> {
  let state = loadState();
  const loop = state.loops.find(l => l.id === loopId);

  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.status === 'running') {
    throw new Error(`Loop already running: ${loopId}`);
  }

  const adapter = getAdapter(loop.agent);
  if (!adapter) {
    throw new Error(`Adapter not found for agent: ${loop.agent}`);
  }

  if (!adapter.isAvailable()) {
    throw new Error(`Agent CLI not available: ${loop.agent}`);
  }

  // Capture git baseline for progress detection
  const gitBaseline = captureGitBaseline(loop.workingDir);

  // Initialize iteration state
  const iterState: LoopIterationState = {
    iteration: 0,
    maxIterations: MAX_ITERATIONS_DEFAULT,
    circuitBreaker: createCircuitBreaker(),
    analysisHistory: [],
    sessionId: undefined,  // Will be set after first iteration
  };
  iterationStates.set(loopId, iterState);

  // Initialize rate limiter
  let rateLimiter = createRateLimiter();

  // Build initial prompt
  const prompt = buildPromptFromIssue(loop.issue);

  appendLog(loopId, { type: 'system', content: `Starting ${loop.agent} agent with session continuity...` });
  appendLog(loopId, { type: 'system', content: `Max iterations: ${iterState.maxIterations}, Timeout: ${ITERATION_TIMEOUT_MS / 1000}s` });
  if (gitBaseline) {
    appendLog(loopId, { type: 'system', content: `Git baseline captured: ${gitBaseline.initialDirtyFiles.size} dirty files tracked` });
  }

  // Update state to running
  state = updateLoop(state, loopId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    iteration: 0,
  });
  saveState(state);
  emit({ type: 'started', loopId });

  // Run iteration loop
  try {
    await runIterationLoop(loopId, loop, adapter, prompt, iterState, rateLimiter, gitBaseline);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    appendLog(loopId, { type: 'error', content: `Loop error: ${errorMsg}` });

    let state = loadState();
    state = updateLoop(state, loopId, {
      status: 'error',
      error: errorMsg,
      endedAt: new Date().toISOString(),
    });
    saveState(state);
    emit({ type: 'error', loopId, error: errorMsg });
  }
}

/**
 * Main iteration loop - runs agent and analyzes responses.
 */
async function runIterationLoop(
  loopId: string,
  loop: Loop,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  initialPrompt: string,
  iterState: LoopIterationState,
  rateLimiter: ReturnType<typeof createRateLimiter>,
  gitBaseline: GitBaselineInfo | null
): Promise<void> {
  let currentPrompt = initialPrompt;
  let outputBuffer = '';

  while (iterState.iteration < iterState.maxIterations) {
    // Check if loop was stopped externally
    let state = loadState();
    const currentLoop = state.loops.find(l => l.id === loopId);
    if (!currentLoop || currentLoop.status === 'stopped') {
      iterState.exitReason = 'user_stopped';
      break;
    }

    // Check circuit breaker
    if (shouldHalt(iterState.circuitBreaker)) {
      const reason = getHaltReason(iterState.circuitBreaker);
      appendLog(loopId, { type: 'system', content: `Circuit breaker OPEN: ${reason}` });
      iterState.exitReason = 'circuit_breaker';
      break;
    }

    // Check rate limit
    const remaining = checkRateLimit(rateLimiter);
    if (remaining < 0) {
      appendLog(loopId, { type: 'system', content: `Rate limit reached. ${getRlStatus(rateLimiter)}` });
      await waitForRateLimit(rateLimiter);
    }

    // Increment iteration
    iterState.iteration++;
    appendLog(loopId, {
      type: 'system',
      content: `--- Iteration ${iterState.iteration}/${iterState.maxIterations} ---`,
    });
    emit({ type: 'iteration', loopId, iteration: iterState.iteration });

    // Update loop iteration count
    state = loadState();
    state = updateLoop(state, loopId, { iteration: iterState.iteration });
    saveState(state);

    // Build spawn args - use continue if we have a session ID
    let spawnArgs: SpawnArgs;
    if (iterState.sessionId) {
      appendLog(loopId, { type: 'system', content: `Continuing session: ${iterState.sessionId.substring(0, 8)}...` });
      spawnArgs = adapter.buildContinueArgs(iterState.sessionId, currentPrompt, loop.skipPermissions);
    } else {
      spawnArgs = adapter.buildSpawnArgs(currentPrompt, loop.skipPermissions);
    }

    // Run iteration with timeout
    const result = await runSingleIteration(loopId, loop, spawnArgs, ITERATION_TIMEOUT_MS);
    outputBuffer = result.output;

    // Handle timeout
    if (result.timedOut) {
      appendLog(loopId, { type: 'error', content: `Iteration timed out after ${ITERATION_TIMEOUT_MS / 1000}s` });
      // Don't immediately exit - let circuit breaker handle repeated timeouts
    }

    // Extract and store session ID for next iteration
    const extractedSessionId = adapter.extractSessionId(outputBuffer);
    if (extractedSessionId) {
      if (!iterState.sessionId) {
        appendLog(loopId, { type: 'system', content: `Session established: ${extractedSessionId.substring(0, 8)}...` });
      }
      iterState.sessionId = extractedSessionId;
    } else if (iterState.sessionId) {
      // Had a session but didn't get one back - clear to avoid getting stuck
      // This handles both errors and cases where agent exits 0 but doesn't emit sessionId
      appendLog(loopId, { type: 'system', content: 'No sessionId in output, will start fresh next iteration' });
      iterState.sessionId = undefined;
    }

    // Record API call
    rateLimiter = recordCall(rateLimiter);

    // Analyze response with git baseline
    const analysis = analyzeResponse(outputBuffer, loop.workingDir, gitBaseline);
    iterState.analysisHistory.push(analysis);

    // Log analysis
    appendLog(loopId, {
      type: 'system',
      content: `Analysis: completion=${analysis.completionIndicators}, progress=${analysis.hasProgress}, test_only=${analysis.isTestOnly}, exit_signal=${analysis.exitSignal}`,
    });

    // Update circuit breaker
    iterState.circuitBreaker = recordIteration(iterState.circuitBreaker, analysis);
    appendLog(loopId, { type: 'system', content: `Circuit: ${getCbStatus(iterState.circuitBreaker)}` });

    const allCriteriaComplete = currentLoop.issue.acceptanceCriteria.length === 0 ||
      currentLoop.issue.acceptanceCriteria.every(criterion => criterion.completed);
    const hasPromise = outputBuffer.includes(COMPLETION_PROMISE);

    // Check exit conditions
    const exitReason = shouldExit(
      analysis,
      iterState.circuitBreaker.consecutiveTestOnly,
      CB_CONSECUTIVE_TEST_THRESHOLD
    );

    if (exitReason) {
      if (['completion_signal', 'exit_signal', 'project_complete'].includes(exitReason)) {
        if (allCriteriaComplete && hasPromise) {
          iterState.exitReason = 'completion_signal';
          appendLog(loopId, { type: 'system', content: 'Completion promise detected with all criteria complete' });
          break;
        }
        appendLog(loopId, { type: 'system', content: 'Exit signal ignored (promise and/or criteria missing)' });
      } else {
        iterState.exitReason = exitReason;
        appendLog(loopId, { type: 'system', content: `Exit condition met: ${exitReason}` });
        break;
      }
    }

    if (AUTO_COMPLETE_ON_CRITERIA && allCriteriaComplete && !hasPromise) {
      iterState.exitReason = 'completion_signal';
      appendLog(loopId, { type: 'system', content: 'All criteria complete. Auto-completing loop.' });
      break;
    }

    // Check for explicit completion promise
    if (hasPromise) {
      if (allCriteriaComplete) {
        iterState.exitReason = 'completion_signal';
        appendLog(loopId, { type: 'system', content: 'Completion promise detected with all criteria complete' });
        break;
      }
      const remaining = getIncompleteCriteria(loop.issue.acceptanceCriteria);
      appendLog(loopId, { type: 'system', content: `Completion promise received but criteria remain: ${remaining.length}` });
      currentPrompt = `You output <promise>TASK COMPLETE</promise>, but the following criteria remain:\n` +
        remaining.map(item => `- ${item}`).join('\n') +
        `\n\nComplete them and emit <criterion-complete>N</criterion-complete> for each, then output <promise>TASK COMPLETE</promise> again.`;
      continue;
    }

    // Check for pending intervention (process was killed by operator)
    const intervention = pendingInterventions.get(loopId);
    if (intervention) {
      pendingInterventions.delete(loopId);
      appendLog(loopId, { type: 'system', content: 'Injecting operator intervention into next prompt' });
      currentPrompt = `OPERATOR INTERVENTION:\n${intervention}\n\nPlease acknowledge this message and adjust your approach accordingly. Continue working on the task.`;
      continue;
    }

    // Process exited with error (not timeout, not intervention)
    if (!result.timedOut && result.exitCode !== 0 && result.exitCode !== null) {
      appendLog(loopId, { type: 'error', content: `Iteration exited with code ${result.exitCode}` });
    }

    // Build follow-up prompt for next iteration
    if (adapter.buildFollowUpPrompt) {
      currentPrompt = adapter.buildFollowUpPrompt(outputBuffer.substring(0, 500));
    } else {
      currentPrompt = 'Continue working on the task. What is the next step?';
    }
  }

  // Check if hit max iterations
  if (iterState.iteration >= iterState.maxIterations && !iterState.exitReason) {
    iterState.exitReason = 'max_iterations';
    appendLog(loopId, { type: 'system', content: `Hit max iterations (${iterState.maxIterations})` });
  }

  // Finalize loop
  finalizeLoop(loopId, iterState);
}

/**
 * Run a single iteration of the agent using Bun's spawn with timeout.
 */
async function runSingleIteration(
  loopId: string,
  loop: Loop,
  spawnArgs: SpawnArgs,
  timeoutMs: number
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  let output = '';
  let timedOut = false;
  let cancelled = false;

  // Use Bun's spawn for safe execution (no shell injection)
  const proc = spawn([spawnArgs.cmd, ...spawnArgs.args], {
    cwd: loop.workingDir,
    env: { ...process.env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  processes.set(loopId, proc);

  // Read stdout
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  let criterionBuffer = criterionBuffers.get(loopId) || '';

  // Process stdout chunks
  const readStdout = async () => {
    try {
      while (!cancelled) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        output += text;
        appendLog(loopId, { type: 'agent', content: text });
        emit({ type: 'output', loopId, data: text });
        const parsed = parseCriterionTags(text, criterionBuffer);
        criterionBuffer = parsed.rest;
        if (parsed.updates.length > 0) {
          applyCriterionUpdates(loopId, parsed.updates, 'agent');
        }
      }
    } catch {
      // Reader closed or cancelled
    }
  };

  // Process stderr chunks (many CLIs like Codex write normal output to stderr)
  const readStderr = async () => {
    try {
      while (!cancelled) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        output += text;  // Include in analysis
        appendLog(loopId, { type: 'agent', content: text });
        const parsed = parseCriterionTags(text, criterionBuffer);
        criterionBuffer = parsed.rest;
        if (parsed.updates.length > 0) {
          applyCriterionUpdates(loopId, parsed.updates, 'agent');
        }
      }
    } catch {
      // Reader closed or cancelled
    }
  };

  // Setup timeout
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  // Race between process completion and timeout
  const processPromise = (async () => {
    await Promise.all([readStdout(), readStderr()]);
    return await proc.exited;
  })();

  const result = await Promise.race([
    processPromise.then(code => ({ type: 'done' as const, exitCode: code })),
    timeoutPromise.then(() => ({ type: 'timeout' as const, exitCode: null })),
  ]);

  // Clear timeout if process completed normally
  if (timeoutId && result.type === 'done') {
    clearTimeout(timeoutId);
  }

  if (result.type === 'timeout') {
    timedOut = true;
    cancelled = true;

    // Cancel the stream readers to stop them from blocking
    try {
      await stdoutReader.cancel();
    } catch {
      // Already closed
    }
    try {
      await stderrReader.cancel();
    } catch {
      // Already closed
    }

    // Kill the timed-out process
    if (proc.pid) {
      process.kill(proc.pid, 'SIGKILL');
    }

    // Wait briefly for process to actually terminate
    await proc.exited.catch(() => {});
  }

  criterionBuffers.set(loopId, criterionBuffer);
  processes.delete(loopId);

  return { output, exitCode: result.exitCode, timedOut };
}

/**
 * Finalize loop after iteration loop completes.
 */
function finalizeLoop(loopId: string, iterState: LoopIterationState): void {
  let state = loadState();

  const exitReason = iterState.exitReason || 'error';
  const status: LoopStatus = exitReason === 'user_stopped' ? 'stopped'
    : exitReason === 'error' || exitReason === 'circuit_breaker' ? 'error'
    : 'completed';

  state = updateLoop(state, loopId, {
    status,
    exitReason,
    endedAt: new Date().toISOString(),
    iteration: iterState.iteration,
  });
  saveState(state);

  appendLog(loopId, {
    type: 'system',
    content: `Loop finished: status=${status}, iterations=${iterState.iteration}, exit_reason=${exitReason}`,
  });

  iterationStates.delete(loopId);
  criterionBuffers.delete(loopId);
  pendingInterventions.delete(loopId);

  if (status === 'completed') {
    emit({ type: 'completed', loopId });
  } else if (status === 'error') {
    emit({ type: 'error', loopId, error: exitReason });
  } else {
    emit({ type: 'stopped', loopId });
  }
}

// Pause a loop (SIGSTOP) - saves session ID for cross-session resume
export function pauseLoop(loopId: string): void {
  const proc = processes.get(loopId);
  if (!proc || !proc.pid) {
    throw new Error(`No running process for loop: ${loopId}`);
  }

  process.kill(proc.pid, 'SIGSTOP');

  // Capture session ID for potential cross-session resume
  const iterState = iterationStates.get(loopId);
  const sessionId = iterState?.sessionId;

  let state = loadState();
  state = updateLoop(state, loopId, {
    status: 'paused',
    pausedAt: new Date().toISOString(),
    pausedSessionId: sessionId,
  });
  saveState(state);

  appendLog(loopId, { type: 'system', content: `Loop paused${sessionId ? ` (session: ${sessionId.substring(0, 8)}...)` : ''}` });
  emit({ type: 'paused', loopId });
}

// Resume a loop (SIGCONT) - for same-session resume
export function resumeLoop(loopId: string): void {
  const proc = processes.get(loopId);
  if (!proc || !proc.pid) {
    throw new Error(`No running process for loop: ${loopId}`);
  }

  process.kill(proc.pid, 'SIGCONT');

  let state = loadState();
  state = updateLoop(state, loopId, { status: 'running' });
  saveState(state);

  appendLog(loopId, { type: 'system', content: 'Loop resumed' });
  emit({ type: 'resumed', loopId });
}

/**
 * Resume a paused loop from a previous session.
 * Spawns a new agent process with context from logs.
 * Attempts to use stored sessionId with --continue, falls back to fresh start with summary.
 */
export async function resumePausedLoop(loopId: string): Promise<void> {
  let state = loadState();
  const loop = state.loops.find(l => l.id === loopId);

  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.status !== 'paused') {
    throw new Error(`Loop is not paused: ${loopId} (status: ${loop.status})`);
  }

  // Check if there's still an active process (shouldn't happen for cross-session)
  if (processes.has(loopId)) {
    // Same-session resume - use SIGCONT instead
    resumeLoop(loopId);
    return;
  }

  const adapter = getAdapter(loop.agent);
  if (!adapter) {
    throw new Error(`Adapter not found for agent: ${loop.agent}`);
  }

  if (!adapter.isAvailable()) {
    throw new Error(`Agent CLI not available: ${loop.agent}`);
  }

  // Generate work summary from logs
  const workSummary = generateResumeSummary(loopId);

  // Get remaining criteria
  const remainingCriteria = loop.issue.acceptanceCriteria
    .filter(c => !c.completed)
    .map(c => c.text);

  // Build resume prompt
  const resumePrompt = adapter.buildResumePrompt
    ? adapter.buildResumePrompt(workSummary, remainingCriteria)
    : `Resuming from pause. Previous work summary:\n${workSummary}\n\nRemaining criteria: ${remainingCriteria.join(', ') || 'none'}`;

  appendLog(loopId, { type: 'system', content: '--- CROSS-SESSION RESUME ---' });
  appendLog(loopId, { type: 'system', content: `Resuming paused loop from previous session` });

  // Capture git baseline for progress detection
  const gitBaseline = captureGitBaseline(loop.workingDir);

  // Initialize iteration state, preserving iteration count
  const previousIteration = loop.iteration || 0;
  const iterState: LoopIterationState = {
    iteration: previousIteration,
    maxIterations: MAX_ITERATIONS_DEFAULT,
    circuitBreaker: createCircuitBreaker(),
    analysisHistory: [],
    sessionId: loop.pausedSessionId,  // Try to resume the session
  };
  iterationStates.set(loopId, iterState);

  // Initialize rate limiter
  let rateLimiter = createRateLimiter();

  // Update state - clear pause fields and set to running
  state = updateLoop(state, loopId, {
    status: 'running',
    pausedAt: undefined,
    pausedSessionId: undefined,
    pausedFromPreviousSession: undefined,
  });
  saveState(state);
  emit({ type: 'resumed', loopId });

  // Run iteration loop with resume prompt
  try {
    await runIterationLoop(loopId, loop, adapter, resumePrompt, iterState, rateLimiter, gitBaseline);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    appendLog(loopId, { type: 'error', content: `Resume error: ${errorMsg}` });

    let state = loadState();
    state = updateLoop(state, loopId, {
      status: 'error',
      error: errorMsg,
      endedAt: new Date().toISOString(),
    });
    saveState(state);
    emit({ type: 'error', loopId, error: errorMsg });
  }
}

// Stop a loop (SIGTERM)
export function stopLoop(loopId: string): void {
  const proc = processes.get(loopId);
  if (!proc || !proc.pid) {
    // Maybe already stopped, just update state
    let state = loadState();
    state = updateLoop(state, loopId, {
      status: 'stopped',
      endedAt: new Date().toISOString(),
    });
    saveState(state);
    return;
  }

  process.kill(proc.pid, 'SIGTERM');

  let state = loadState();
  state = updateLoop(state, loopId, {
    status: 'stopped',
    endedAt: new Date().toISOString(),
  });
  saveState(state);

  appendLog(loopId, { type: 'system', content: 'Loop stopped by user' });
  emit({ type: 'stopped', loopId });
}

// Retry an errored/stopped loop
export async function retryLoop(loopId: string): Promise<void> {
  let state = loadState();
  const loop = state.loops.find(l => l.id === loopId);

  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.status === 'running' || loop.status === 'paused') {
    throw new Error(`Loop is still active: ${loopId}`);
  }

  if (loop.status !== 'error' && loop.status !== 'stopped') {
    throw new Error(`Loop cannot be retried (status: ${loop.status})`);
  }

  // Reset loop state for retry
  state = updateLoop(state, loopId, {
    status: 'queued',
    error: undefined,
    exitReason: undefined,
    endedAt: undefined,
    iteration: 0,
  });
  saveState(state);

  appendLog(loopId, { type: 'system', content: '--- RETRY ---' });
  appendLog(loopId, { type: 'system', content: 'Loop reset for retry' });

  // Start the loop again
  await startLoop(loopId);
}

// Send intervention - interrupts current process and resumes with message
export function sendIntervention(loopId: string, message: string): void {
  const proc = processes.get(loopId);
  if (!proc) {
    throw new Error(`No running process for loop: ${loopId}`);
  }

  const iterState = iterationStates.get(loopId);
  if (!iterState) {
    throw new Error(`No iteration state for loop: ${loopId}`);
  }

  // Store the intervention message - will be picked up by the iteration loop
  pendingInterventions.set(loopId, message);
  appendLog(loopId, { type: 'operator', content: `[INTERVENTION] ${message}` });
  appendLog(loopId, { type: 'system', content: 'Interrupting current process to inject intervention...' });

  // Kill the current process - the iteration loop will detect this and continue
  // with the intervention message in the next prompt
  proc.kill('SIGTERM');
}

// Check if there's a pending intervention for a loop
export function getPendingIntervention(loopId: string): string | undefined {
  return pendingInterventions.get(loopId);
}

// Clear a pending intervention after it's been used
export function clearPendingIntervention(loopId: string): void {
  pendingInterventions.delete(loopId);
}

// Get running process for a loop
export function getProcess(loopId: string): Subprocess | undefined {
  return processes.get(loopId);
}

// Check if a loop has an active process
export function isLoopActive(loopId: string): boolean {
  return processes.has(loopId);
}

// Get iteration state for a loop
export function getIterationState(loopId: string): LoopIterationState | undefined {
  return iterationStates.get(loopId);
}

// Reset circuit breaker for a loop
export function resetLoopCircuitBreaker(loopId: string): void {
  const iterState = iterationStates.get(loopId);
  if (iterState) {
    iterState.circuitBreaker = createCircuitBreaker();
    appendLog(loopId, { type: 'system', content: 'Circuit breaker reset' });
  }
}

// Reset session for a loop (forces new session on next iteration)
export function resetLoopSession(loopId: string): void {
  const iterState = iterationStates.get(loopId);
  if (iterState) {
    iterState.sessionId = undefined;
    appendLog(loopId, { type: 'system', content: 'Session reset - next iteration will start fresh' });
  }
}

// Kill all running processes (for cleanup)
export function killAll(): void {
  for (const [loopId, proc] of processes) {
    if (proc.pid) {
      process.kill(proc.pid, 'SIGKILL');
    }
    processes.delete(loopId);
  }
  iterationStates.clear();
  criterionBuffers.clear();
  pendingInterventions.clear();
}

/**
 * Mark orphaned paused loops as from a previous session.
 * Call this on TUI startup to detect paused loops that lost their process.
 */
export function markOrphanedPausedLoops(): number {
  let state = loadState();
  let orphanCount = 0;

  for (const loop of state.loops) {
    if (loop.status === 'paused' && !processes.has(loop.id)) {
      // This loop was paused but has no active process - it's from a previous session
      if (!loop.pausedFromPreviousSession) {
        state = updateLoop(state, loop.id, { pausedFromPreviousSession: true });
        orphanCount++;
      }
    }
  }

  if (orphanCount > 0) {
    saveState(state);
  }

  return orphanCount;
}

/**
 * Discard a paused loop (remove it from state).
 */
export function discardPausedLoop(loopId: string): void {
  let state = loadState();
  const loop = state.loops.find(l => l.id === loopId);

  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.status !== 'paused') {
    throw new Error(`Can only discard paused loops (status: ${loop.status})`);
  }

  // Remove from state
  state = {
    ...state,
    loops: state.loops.filter(l => l.id !== loopId),
  };
  saveState(state);

  appendLog(loopId, { type: 'system', content: 'Loop discarded by user' });
}

/**
 * Check if a paused loop can be resumed in the current session (has active process).
 */
export function canResumeInSession(loopId: string): boolean {
  return processes.has(loopId);
}
