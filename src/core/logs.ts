import fs from 'fs';
import path from 'path';
import { LogEntry } from './types.js';
import { getLoopDir, ensureLoopDir } from './state.js';

// Get log file path for a loop
export function getLogPath(loopId: string): string {
  return path.join(getLoopDir(loopId), 'log.jsonl');
}

// Append a log entry
export function appendLog(loopId: string, entry: Omit<LogEntry, 'timestamp' | 'loopId'>): void {
  ensureLoopDir(loopId);
  const logPath = getLogPath(loopId);

  const fullEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    loopId,
    ...entry,
  };

  fs.appendFileSync(logPath, JSON.stringify(fullEntry) + '\n');
}

// Read all log entries for a loop
export function readLogs(loopId: string): LogEntry[] {
  const logPath = getLogPath(loopId);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  return lines.map(line => {
    try {
      return JSON.parse(line) as LogEntry;
    } catch {
      return null;
    }
  }).filter((entry): entry is LogEntry => entry !== null);
}

// Read last N log entries efficiently (reads from end of file)
export function readRecentLogs(loopId: string, count: number): LogEntry[] {
  const logPath = getLogPath(loopId);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const stat = fs.statSync(logPath);
  if (stat.size === 0) {
    return [];
  }

  // Read last chunk of file (estimate ~500 bytes per log entry)
  const chunkSize = Math.min(stat.size, count * 500);
  const buffer = Buffer.alloc(chunkSize);
  const fd = fs.openSync(logPath, 'r');

  try {
    fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
  } finally {
    fs.closeSync(fd);
  }

  const content = buffer.toString('utf-8');
  const lines = content.split('\n').filter(Boolean);

  // Parse and return last N entries
  const entries: LogEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < count; i--) {
    try {
      const entry = JSON.parse(lines[i]) as LogEntry;
      entries.unshift(entry);
    } catch {
      // Skip malformed lines (including partial first line from chunk)
    }
  }

  return entries;
}

// Tail log file and call callback for new entries
// Uses polling for rock-solid reliability (fs.watch is unreliable on macOS)
export function tailLog(
  loopId: string,
  onEntry: (entry: LogEntry) => void,
  onError?: (error: Error) => void,
  pollIntervalMs: number = 250
): () => void {
  const logPath = getLogPath(loopId);
  ensureLoopDir(loopId);

  // Create file if it doesn't exist
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

  let position = fs.statSync(logPath).size;
  let active = true;
  let lineBuffer = '';

  const poll = () => {
    if (!active) return;

    try {
      const stat = fs.statSync(logPath);

      if (stat.size > position) {
        // Read new content
        const fd = fs.openSync(logPath, 'r');
        const newBytes = stat.size - position;
        const buffer = Buffer.alloc(newBytes);

        try {
          fs.readSync(fd, buffer, 0, newBytes, position);
        } finally {
          fs.closeSync(fd);
        }

        const newContent = buffer.toString('utf-8');
        lineBuffer += newContent;

        // Process complete lines
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            try {
              const entry = JSON.parse(line) as LogEntry;
              onEntry(entry);
            } catch {
              // Skip invalid JSON
            }
          }
        }

        position = stat.size;
      } else if (stat.size < position) {
        // File was truncated, reset position
        position = 0;
        lineBuffer = '';
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        onError?.(err as Error);
      }
    }

    // Schedule next poll
    if (active) {
      setTimeout(poll, pollIntervalMs);
    }
  };

  // Start polling
  poll();

  // Return cleanup function
  return () => {
    active = false;
  };
}

// Format log entry for display
export function formatLogEntry(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const typeColors: Record<string, string> = {
    agent: '#2de2e6',
    operator: '#ff4fd8',
    system: '#666',
    error: '#ff006e',
  };
  const color = typeColors[entry.type] || '#666';
  return `{${color}-fg}[${entry.type}]{/} ${entry.content}`;
}

/**
 * Generate a summary of work done from logs for resume prompt.
 * Extracts key actions, files modified, and progress indicators.
 */
export function generateResumeSummary(loopId: string, maxChars: number = 2000): string {
  const logs = readLogs(loopId);
  if (logs.length === 0) {
    return 'No previous work logged.';
  }

  // Extract meaningful entries
  const systemLogs = logs.filter(l => l.type === 'system');
  const agentLogs = logs.filter(l => l.type === 'agent');

  // Find iteration count
  const iterationMatches = systemLogs
    .filter(l => l.content.includes('--- Iteration'))
    .map(l => {
      const match = l.content.match(/Iteration (\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
  const maxIteration = Math.max(0, ...iterationMatches);

  // Find completed criteria
  const criteriaCompletions = systemLogs
    .filter(l => l.content.includes('Criterion') && l.content.includes('complete'))
    .map(l => l.content);

  // Extract file modifications from agent output
  const filePatterns = /(?:created|modified|edited|wrote|updated|deleted)\s+(?:file\s+)?[`"]?([^\s`"]+\.[a-z]{1,5})[`"]?/gi;
  const filesModified = new Set<string>();
  for (const log of agentLogs) {
    let match;
    while ((match = filePatterns.exec(log.content)) !== null) {
      filesModified.add(match[1]);
    }
  }

  // Extract tool usage from agent output
  const toolPatterns = /(?:Using|Called|Invoked)\s+(?:tool\s+)?(\w+)/gi;
  const toolsUsed = new Set<string>();
  for (const log of agentLogs) {
    let match;
    while ((match = toolPatterns.exec(log.content)) !== null) {
      toolsUsed.add(match[1]);
    }
  }

  // Get last system analysis
  const analysisLogs = systemLogs.filter(l => l.content.startsWith('Analysis:'));
  const lastAnalysis = analysisLogs[analysisLogs.length - 1]?.content || '';

  // Build summary
  const parts: string[] = [];

  parts.push(`Iterations completed: ${maxIteration}`);

  if (filesModified.size > 0) {
    parts.push(`Files touched: ${Array.from(filesModified).slice(0, 10).join(', ')}`);
  }

  if (criteriaCompletions.length > 0) {
    parts.push(`Criteria progress: ${criteriaCompletions.length} updates`);
  }

  if (lastAnalysis) {
    parts.push(`Last analysis: ${lastAnalysis.replace('Analysis: ', '')}`);
  }

  // Add recent agent activity (last meaningful chunks)
  const recentAgent = agentLogs.slice(-5).map(l => l.content.slice(0, 200)).join('\n');
  if (recentAgent.length > 0) {
    parts.push(`Recent activity:\n${recentAgent.slice(0, 800)}`);
  }

  let summary = parts.join('\n\n');

  // Truncate if needed
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 3) + '...';
  }

  return summary;
}
