#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import blessed from 'blessed';
import { createScreen } from './ui/screen.js';
import { colors } from './config.js';
import { statusColors, statusIcons } from './ui/theme.js';
import {
  Issue,
  Loop,
  LoopStatus,
  loadState,
  saveState,
  updateLoop,
  fetchIssue,
  closeIssue,
  updateIssueBody,
  applyAcceptanceCriteriaToIssueBody,
  createLoop,
  startLoop,
  pauseLoop,
  resumeLoop,
  resumePausedLoop,
  stopLoop,
  retryLoop,
  sendIntervention,
  loopEvents,
  appendLog,
  readRecentLogs,
  readLogs,
  tailLog,
  formatLogEntry,
  getLogPath,
  killAll,
  markOrphanedPausedLoops,
  discardPausedLoop,
  canResumeInSession,
} from './core/index.js';
import './adapters/index.js';  // Register adapters
import { createInputManager, ManagedInput } from './ui/input-manager.js';
import { createCursorInput, isAnyInputActive } from './ui/cursor-input.js';

function main(): void {
  const screen = createScreen();

  // App state
  let state = loadState();

  // Mark any paused loops without active processes as from previous session
  const orphanedCount = markOrphanedPausedLoops();
  if (orphanedCount > 0) {
    state = loadState(); // Reload after marking
  }

  let selectedLoopId: string | null = state.loops[0]?.id || null;
  let logTailCleanup: (() => void) | null = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // NEON LIGHT SHOW BACKGROUND
  // ═══════════════════════════════════════════════════════════════════════════
  const bgBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    style: { bg: 'black' },
  } as any);

  const bgState = {
    start: Date.now(),
    pulses: [] as { x: number; y: number; strength: number; born: number; life: number; color: string }[],
    logFlash: 0,
    nextSparkAt: Date.now() + 1200,
  };
  const glowChars = ' .:-=+*#%@';
  const glowColors = ['#130815', '#1c0b2a', '#2a0f4f', '#2e1a7a', '#0f3a7a', '#0a5fb8', '#00a5d8', '#00f5d4', '#ff4fd8'];
  const pulseColors = ['#ff4fd8', '#2de2e6', '#00f5d4', '#ffbe0b'];

  function triggerBackgroundGlow(kind: 'log' | 'error' | 'system' = 'log'): void {
    const now = Date.now();
    const w = (screen.width as number) || 80;
    const h = (screen.height as number) || 24;
    if (w < 30 || h < 10) return;

    const color = kind === 'error' ? '#ff006e' : kind === 'system' ? '#ffbe0b' : pulseColors[Math.floor(Math.random() * pulseColors.length)];
    bgState.pulses.push({
      x: Math.random(),
      y: Math.random(),
      strength: kind === 'error' ? 0.6 : 0.4,  // Much gentler pulses
      born: now,
      life: kind === 'error' ? 1800 : 1200,
      color,
    });
    // Subtle flash, not overwhelming
    bgState.logFlash = Math.min(0.3, bgState.logFlash + 0.08);
    if (kind === 'error') {
      bgState.logFlash = Math.min(0.5, bgState.logFlash + 0.15);
      // No strobe - too intense
    }
  }

  function generateLightShow(): string {
    const now = Date.now();
    const t = (now - bgState.start) / 1000;
    const w = (screen.width as number) || 80;
    const h = (screen.height as number) || 24;
    const breath = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.45));
    bgState.logFlash *= 0.92;  // Slightly faster decay

    if (now >= bgState.nextSparkAt) {
      bgState.pulses.push({
        x: Math.random(),
        y: Math.random(),
        strength: 0.8 + Math.random() * 0.6,
        born: now,
        life: 1600 + Math.random() * 1400,
        color: pulseColors[Math.floor(Math.random() * pulseColors.length)],
      });
      bgState.nextSparkAt = now + 1000 + Math.random() * 2200;
    }

    const pulses = bgState.pulses.filter(p => now - p.born < p.life);
    bgState.pulses = pulses;
    let pattern = '';

    for (let y = 0; y < h; y++) {
      let line = '';
      const ny = y / h;
      for (let x = 0; x < w; x++) {
        const nx = x / w;
        const wave =
          Math.sin((nx * 10 + t * 1.2) + Math.cos(ny * 3 + t * 0.6)) * 0.5 +
          Math.sin((ny * 9 - t * 1.1) + Math.cos(nx * 4 - t * 0.4)) * 0.5;
        let intensity = (wave + 1) * 0.35 * breath;

        for (const pulse of pulses) {
          const dx = nx - pulse.x;
          const dy = (ny - pulse.y) * 1.3;
          const dist2 = dx * dx + dy * dy;
          const age = (now - pulse.born) / pulse.life;
          const falloff = Math.exp(-dist2 * 28);
          intensity += pulse.strength * (1 - age) * falloff;
        }

        intensity += bgState.logFlash * 0.15;  // Subtle flash effect
        intensity = Math.max(0, Math.min(1.0, intensity));

        const charIdx = Math.min(glowChars.length - 1, Math.floor(intensity * (glowChars.length - 1)));
        const hueSeed = Math.sin(nx * 4 + ny * 3 + t * 0.4) * 0.5 + 0.5;
        const baseColorIdx = Math.min(glowColors.length - 1, Math.floor(hueSeed * (glowColors.length - 1)));
        const colorIdx = Math.min(glowColors.length - 1, Math.floor((baseColorIdx + intensity * 3)));
        const char = glowChars[charIdx];
        const color = glowColors[colorIdx];
        line += char === ' ' ? ' ' : `{${color}-fg}${char}{/}`;
      }
      pattern += line + '\n';
    }
    return pattern;
  }

  bgBox.setContent(generateLightShow());
  setInterval(() => {
    bgBox.setContent(generateLightShow());
    screen.render();
  }, 120);

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER BAR
  // ═══════════════════════════════════════════════════════════════════════════
  const headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'black', transparent: true },
  } as any);

  function updateHeader(): void {
    const counts = {
      running: state.loops.filter(l => l.status === 'running').length,
      paused: state.loops.filter(l => l.status === 'paused').length,
      completed: state.loops.filter(l => l.status === 'completed').length,
      error: state.loops.filter(l => l.status === 'error').length,
    };
    headerBox.setContent(
      ` {bold}{#ff4fd8-fg}◆ ALEX{/}{/bold} {#666-fg}│{/} ` +
      `{#2de2e6-fg}${counts.running}{/} running {#666-fg}│{/} ` +
      `{#ffbe0b-fg}${counts.paused}{/} paused {#666-fg}│{/} ` +
      `{#00f5d4-fg}${counts.completed}{/} done {#666-fg}│{/} ` +
      `{#ff006e-fg}${counts.error}{/} errors`
    );
  }
  updateHeader();

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB BAR
  // ═══════════════════════════════════════════════════════════════════════════
  const tabBar = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'black', transparent: true },
  } as any);

  const tabDefs = [
    { label: 'All', status: null },
    { label: 'Running', status: 'running' },
    { label: 'Paused', status: 'paused' },
    { label: 'Completed', status: 'completed' },
    { label: 'Errors', status: 'error' },
  ] as const;

  let activeTabIndex = 0;

  const tabButtons = tabDefs.map((tab, index) => blessed.button({
    parent: tabBar,
    top: 0,
    left: 1,
    width: 10,
    height: 1,
    tags: true,
    mouse: true,
    keys: true,
    shrink: true,
    content: tab.label,
    style: {
      fg: '#666666',
      bg: 'black',
      focus: { fg: '#ff4fd8' },
      hover: { fg: '#ff4fd8' },
    },
  } as any));

  function getTabCounts(): Record<string, number> {
    return {
      All: state.loops.length,
      Running: state.loops.filter(l => l.status === 'running').length,
      Paused: state.loops.filter(l => l.status === 'paused').length,
      Completed: state.loops.filter(l => l.status === 'completed').length,
      Errors: state.loops.filter(l => l.status === 'error').length,
    };
  }

  function updateTabBar(): void {
    const counts = getTabCounts();
    let leftOffset = 1;
    tabButtons.forEach((button, index) => {
      const label = tabDefs[index].label;
      const count = counts[label];
      const isActive = index === activeTabIndex;
      const content = isActive
        ? `{bold}{#000000-fg} ${label} ${count} {/}{/bold}`
        : `{#666666-fg} ${label} {#ff4fd8-fg}${count}{/} {/}`;
      button.setContent(content);
      button.style.bg = isActive ? '#ff4fd8' : 'black';
      button.style.fg = isActive ? 'black' : '#666666';
      button.style.bold = isActive;
      const width = `${label} ${count}`.length + 4;
      button.width = width;
      button.left = leftOffset;
      leftOffset += width + 1;
    });
  }

  function getFilteredLoops(): Loop[] {
    const filter = tabDefs[activeTabIndex].status;
    if (!filter) return state.loops;
    return state.loops.filter(loop => loop.status === filter);
  }

  function setActiveTab(index: number): void {
    if (index < 0 || index >= tabDefs.length) return;
    activeTabIndex = index;
    updateTabBar();
    updateLoopList();
    syncSelectionAfterFilter();
    screen.render();
  }

  tabButtons.forEach((button, index) => {
    button.on('press', () => setActiveTab(index));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LOOP LIST
  // ═══════════════════════════════════════════════════════════════════════════
  const loopListWindow = blessed.list({
    parent: screen,
    label: ' {bold}{#ff4fd8-fg}◆ LOOPS{/} ',
    tags: true,
    top: 2,
    left: 1,
    width: '30%-2',
    height: '100%-4',
    keys: true,
    mouse: true,
    vi: true,
    border: 'line',
    scrollbar: { ch: '█', style: { bg: 'magenta' } },
    style: {
      fg: 'white',
      bg: 'black',
      transparent: true,
      border: { fg: 'magenta' },
      selected: { fg: 'white', bg: 'magenta', bold: true },
      label: { fg: 'magenta' },
    },
    shadow: true,
  } as any);

  let loopListData: Loop[] = [];


  function formatDuration(startedAt?: string, endedAt?: string): string {
    if (!startedAt) return '--';
    const endTime = endedAt ? new Date(endedAt).getTime() : Date.now();
    const ms = endTime - new Date(startedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h${mins % 60}m`;
  }

  function getLoopTimestamp(loop: Loop): number {
    // Use most recent action: endedAt if finished, otherwise startedAt, otherwise 0
    const ts = loop.endedAt || loop.startedAt;
    return ts ? new Date(ts).getTime() : 0;
  }

  function updateLoopList(): void {
    const filteredLoops = getFilteredLoops();
    // Sort by most recent action (newest first)
    const sortedLoops = [...filteredLoops].sort((a, b) => getLoopTimestamp(b) - getLoopTimestamp(a));
    loopListData = sortedLoops;
    if (state.loops.length === 0) {
      loopListWindow.setItems(['{#666-fg}No loops yet. Press [N] to create one.{/}']);
      return;
    }
    if (sortedLoops.length === 0) {
      const emptyLabel = tabDefs[activeTabIndex].label.toLowerCase();
      const message = emptyLabel === 'all' ? 'No loops yet.' : `No ${emptyLabel} loops.`;
      loopListWindow.setItems([`{#666-fg}${message}{/}`]);
      return;
    }
    const items = sortedLoops.map((loop) => {
      const icon = statusIcons[loop.status] || '?';
      const color = statusColors[loop.status] || colors.text;
      const time = formatDuration(loop.startedAt, loop.endedAt);
      const prefix = loop.agent === 'claude' ? 'CLA' : 'CDX';
      const title = loop.issue.title.substring(0, 22);
      // Show indicator for paused loops from previous session
      const prevSess = loop.pausedFromPreviousSession ? ' {#ffbe0b-fg}◀prev{/}' : '';
      return ` {${color}-fg}${icon}{/} {bold}${prefix} #${loop.issue.number}{/} ${title}...${prevSess} {#666-fg}${time}{/}`;
    });
    loopListWindow.setItems(items);
  }

  function syncSelectionAfterFilter(): boolean {
    if (loopListData.length === 0) {
      if (selectedLoopId !== null) {
        selectedLoopId = null;
        detailWindow.setContent('{#666-fg}No loops match this filter.{/}');
        updateStatusBar();
        if (logTailCleanup) {
          logTailCleanup();
          logTailCleanup = null;
        }
        logWindow.setContent('');
      }
      return true;
    }

    const selectedIndex = loopListData.findIndex(loop => loop.id === selectedLoopId);
    if (selectedIndex >= 0) {
      loopListWindow.select(selectedIndex);
      return false;
    }

    selectedLoopId = loopListData[0].id;
    loopListWindow.select(0);
    updateDetailPane(loopListData[0]);
    updateStatusBar(loopListData[0]);
    loadLogsForLoop(loopListData[0].id);
    return true;
  }
  updateLoopList();
  updateTabBar();

  // ═══════════════════════════════════════════════════════════════════════════
  // DETAIL PANE
  // ═══════════════════════════════════════════════════════════════════════════
  const detailWindow = blessed.box({
    parent: screen,
    label: ' {bold}{#2de2e6-fg}◆ LOOP DETAIL{/} ',
    tags: true,
    top: 2,
    left: '30%',
    width: '70%-1',
    height: '50%-2',
    border: 'line',
    style: {
      fg: 'white',
      bg: 'black',
      transparent: true,
      border: { fg: 'cyan' },
      label: { fg: 'cyan' },
    },
    shadow: true,
    padding: { left: 1, top: 0 },
    content: '{#666-fg}No loop selected. Press [N] to create one.{/}',
    mouse: true,
  } as any);

  const criteriaList = blessed.list({
    parent: detailWindow,
    top: 5,
    left: 1,
    width: '100%-4',
    height: 8,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    style: {
      fg: 'white',
      bg: 'black',
      selected: { fg: 'white', bg: 'magenta', bold: true },
    },
    scrollbar: { ch: '█', style: { bg: 'magenta' } },
  } as any);


  const runningSymbols = ['·', '✻', '✽', '✶', '✳', '✢', '✦', '✧', '✵', '✸', '✹', '✺'];
  let runningSymbolIndex = 0;
  let runningSymbol = runningSymbols[0];

  function updateDetailPane(loop: Loop): void {
    const statusColor = statusColors[loop.status] || colors.text;
    const statusIcon = loop.status === 'running'
      ? runningSymbol
      : (statusIcons[loop.status] || '?');
    const time = formatDuration(loop.startedAt, loop.endedAt);
    const issueStatus = loop.issueClosed ? ' {#00f5d4-fg}✓ closed{/}' : '';

    // Show indicator for paused loops from previous session
    const prevSessionIndicator = loop.pausedFromPreviousSession
      ? ' {#ffbe0b-fg}◀ PREVIOUS SESSION{/}'
      : '';
    const pausedAtInfo = loop.pausedAt && loop.status === 'paused'
      ? `  {#666-fg}│{/}  {#9b5de5-fg}Paused:{/} ${new Date(loop.pausedAt).toLocaleString()}`
      : '';

    const logPath = getLogPath(loop.id);
    let content =
      `{bold}{#fff-fg}${loop.issue.title}{/}{/bold}\n` +
      `{#666-fg}─────────────────────────────────────────────────────{/}\n` +
      `{${statusColor}-fg}${statusIcon} ${loop.status.toUpperCase()}{/}${prevSessionIndicator}  {#666-fg}│{/}  ` +
      `{#9b5de5-fg}Agent:{/} ${loop.agent}  {#666-fg}│{/}  ` +
      `{#9b5de5-fg}Time:{/} ${time}  {#666-fg}│{/}  ` +
      `{#9b5de5-fg}Issue:{/} #${loop.issue.number}${issueStatus}${pausedAtInfo}\n` +
      `{#9b5de5-fg}Log:{/} ${logPath}\n\n`;

    content += `{#ffbe0b-fg}━━━ Acceptance Criteria ━━━{/}\n`;

    const agentColor = '#2de2e6';
    const operatorColor = '#0a5fb8';
    const items = loop.issue.acceptanceCriteria.length > 0
      ? loop.issue.acceptanceCriteria.map((criterion) => {
        const iconColor = criterion.completed
          ? (criterion.completedBy === 'agent' ? agentColor : operatorColor)
          : '#666';
        const icon = criterion.completed ? '✓' : '○';
        return ` {${iconColor}-fg}${icon}{/} ${criterion.text}`;
      })
      : ['{#666-fg}No acceptance criteria{/}'];
    criteriaList.setItems(items);
    // Keep criteria list height constrained to fit within detail pane
    criteriaList.height = Math.min(8, Math.max(2, items.length));

    if (loop.error) {
      content += `\n{#ff006e-fg}Error: ${loop.error}{/}`;
    }

    detailWindow.setContent(content);
  }

  function toggleCriterion(loopId: string, index: number): void {
    let nextState = loadState();
    const loop = nextState.loops.find(l => l.id === loopId);
    if (!loop) return;
    if (index < 0 || index >= loop.issue.acceptanceCriteria.length) return;

    const criterion = loop.issue.acceptanceCriteria[index];
    const nextCompleted = !criterion.completed;
    criterion.completed = nextCompleted;
    criterion.completedBy = nextCompleted ? 'operator' : undefined;
    criterion.completedAt = nextCompleted ? new Date().toISOString() : undefined;

    nextState = updateLoop(nextState, loopId, { issue: loop.issue });
    saveState(nextState);
    state = nextState;

    appendLog(loopId, {
      type: 'system',
      content: `Criterion ${index + 1} marked ${nextCompleted ? 'complete' : 'incomplete'} by operator`,
    });

    const updatedLoop = state.loops.find(l => l.id === loopId);
    if (updatedLoop) {
      updateDetailPane(updatedLoop);
      updateStatusBar(updatedLoop);
    }
    screen.render();
  }

  criteriaList.on('select', (_item: any, index: number) => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    toggleCriterion(selectedLoopId, index);
  });

  setInterval(() => {
    runningSymbolIndex = (runningSymbolIndex + 1) % runningSymbols.length;
    runningSymbol = runningSymbols[runningSymbolIndex];
    if (Math.random() < 0.2) {
      runningSymbol = runningSymbols[Math.floor(Math.random() * runningSymbols.length)];
    }
    if (selectedLoopId) {
      const loop = state.loops.find(l => l.id === selectedLoopId);
      if (loop?.status === 'running') {
        updateDetailPane(loop);
        screen.render();
      }
    }
  }, 160);

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSCRIPT LOG
  // ═══════════════════════════════════════════════════════════════════════════
  const logWindow = blessed.log({
    parent: screen,
    label: ' {bold}{#9b5de5-fg}◆ LIVE TRANSCRIPT{/} ',
    tags: true,
    top: '50%',
    left: '30%',
    width: '70%-1',
    height: '50%-2',
    keys: true,
    vi: true,
    border: 'line',
    style: {
      fg: 'white',
      bg: 'black',
      transparent: true,
      border: { fg: '#9b5de5' },
      label: { fg: '#9b5de5' },
    },
    shadow: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '█', style: { bg: 'magenta' } },
    mouse: true,
    padding: { left: 1 },
  } as any);

  let logViewer: blessed.Widgets.BoxElement | null = null;
  let logViewerLog: blessed.Widgets.Log | null = null;
  let logViewerCleanup: (() => void) | null = null;

  function buildFullLogContent(loopId: string): string {
    const entries = readLogs(loopId);
    if (entries.length === 0) {
      return '{#666-fg}No log entries yet.{/}';
    }
    return entries.map(entry => formatLogEntry(entry)).join('\n');
  }

  function closeLogViewer(): void {
    if (!logViewer) return;
    if (logViewerCleanup) {
      logViewerCleanup();
      logViewerCleanup = null;
    }
    logViewer.destroy();
    logViewerLog = null;
    logViewer = null;
    loopListWindow.focus();
    screen.render();
  }

  function openLogViewer(loop: Loop): void {
    if (logViewer) return;
    logViewer = blessed.box({
      parent: screen,
      label: ' {bold}{#ff4fd8-fg}◆ FULL LOG{/} ',
      tags: true,
      top: 1,
      left: 2,
      width: '100%-4',
      height: '100%-4',
      border: 'line',
      keys: true,
      vi: true,
      mouse: true,
      style: {
        fg: 'white',
        bg: 'black',
        transparent: true,
        border: { fg: '#ff4fd8' },
        label: { fg: '#ff4fd8' },
      },
      padding: { left: 0, right: 0, top: 0, bottom: 0 },
    } as any);

    logViewerLog = blessed.log({
      parent: logViewer,
      top: 1,
      left: 1,
      width: '100%-2',
      height: '100%-2',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '█', style: { bg: 'magenta' } },
      style: {
        fg: 'white',
        bg: 'black',
        transparent: true,
      },
      padding: { left: 1, right: 1 },
      content: buildFullLogContent(loop.id),
    } as any);

    (logViewerLog as any)._clines = null;
    logViewerLog.setScroll(0);

    logViewerCleanup = tailLog(loop.id, (entry) => {
      if (!logViewerLog || !entry.content.trim()) return;
      logViewerLog.log(formatLogEntry(entry));
      screen.render();
    });

    logViewer.key(['escape', 'l', 'L'], closeLogViewer);
    logViewerLog.key(['escape', 'l', 'L'], closeLogViewer);
    logViewerLog.focus();
    screen.render();
  }

  function setActivePane(pane: blessed.Widgets.BoxElement | blessed.Widgets.ListElement | blessed.Widgets.Log): void {
    const activeBorder = { fg: '#00f5d4' };
    const inactiveBorder = { fg: 'magenta' };
    const activeLabel = { fg: '#00f5d4' };
    const inactiveLabel = { fg: 'magenta' };

    loopListWindow.style.border = pane === loopListWindow ? activeBorder : inactiveBorder;
    loopListWindow.style.label = pane === loopListWindow ? activeLabel : inactiveLabel;
    detailWindow.style.border = pane === detailWindow ? activeBorder : { fg: 'cyan' };
    detailWindow.style.label = pane === detailWindow ? activeLabel : { fg: 'cyan' };
    logWindow.style.border = pane === logWindow ? activeBorder : { fg: '#9b5de5' };
    logWindow.style.label = pane === logWindow ? activeLabel : { fg: '#9b5de5' };
  }

  loopListWindow.on('focus', () => {
    setActivePane(loopListWindow);
    screen.render();
  });
  detailWindow.on('focus', () => {
    setActivePane(detailWindow);
    screen.render();
  });
  criteriaList.on('focus', () => {
    setActivePane(detailWindow);
    screen.render();
  });
  logWindow.on('focus', () => {
    setActivePane(logWindow);
    screen.render();
  });
  setActivePane(loopListWindow);

  screen.key(['tab'], () => {
    if (isAnyInputActive()) return;
    const currentIndex = tabButtons.findIndex(button => screen.focused === button);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabButtons.length;
    tabButtons[nextIndex].focus();
    screen.render();
  });

  function logWithGlow(message: string, kind: 'log' | 'error' | 'system' = 'log'): void {
    logWindow.log(message);
    triggerBackgroundGlow(kind);
  }

  function loadLogsForLoop(loopId: string): void {
    // Cleanup previous tail
    if (logTailCleanup) {
      logTailCleanup();
      logTailCleanup = null;
    }

    // Clear log widget properly (blessed.log quirk)
    logWindow.setContent('');
    (logWindow as any)._clines = null;
    logWindow.setScroll(0);

    // Load recent logs
    const recentLogs = readRecentLogs(loopId, 50);
    for (const entry of recentLogs) {
      if (!entry.content.trim()) continue;
      logWindow.log(formatLogEntry(entry));
    }

    // Scroll to bottom and render
    logWindow.setScrollPerc(100);
    screen.render();

    // Start tailing
    logTailCleanup = tailLog(loopId, (entry) => {
      if (!entry.content.trim()) return;
      logWindow.log(formatLogEntry(entry));
      triggerBackgroundGlow(entry.type === 'error' ? 'error' : entry.type === 'system' ? 'system' : 'log');
      screen.render();
    });
  }

  logWithGlow('{#666-fg}[system]{/} Alex initialized. Press [N] to create a loop.', 'system');

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS BAR
  // ═══════════════════════════════════════════════════════════════════════════
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'black', transparent: true },
    content: '',
  } as any);

  function updateStatusBar(loop?: Loop): void {
    const nav = '{#2de2e6-fg}↑↓{/}Nav';
    const quit = '{#ff4fd8-fg}[Q]{/}uit';
    const newLoop = '{#ff4fd8-fg}[N]{/}ew';
    const refresh = '{#ff4fd8-fg}[T]{/} Refresh';
    const viewLogs = '{#ff4fd8-fg}[L]{/} Logs';

    let actions = '';
    if (!loop) {
      actions = `${newLoop} ${nav} {#666-fg}│{/} ${quit}`;
    } else if (loop.status === 'running') {
      actions = `${newLoop} ${refresh} ${viewLogs} {#ff4fd8-fg}[P]{/}ause {#ff4fd8-fg}[S]{/}top {#ff4fd8-fg}[I]{/}ntervene {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    } else if (loop.status === 'paused') {
      const isPrevSession = loop.pausedFromPreviousSession;
      const discardAction = isPrevSession ? ' {#ff4fd8-fg}[D]{/}iscard' : '';
      const resumeLabel = isPrevSession ? ' Resume(rebuild)' : ' Resume';
      actions = `${newLoop} ${refresh} ${viewLogs} {#ff4fd8-fg}[P]{/}${resumeLabel} {#ff4fd8-fg}[S]{/}top${discardAction} {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    } else if (loop.status === 'queued') {
      actions = `${newLoop} ${refresh} ${viewLogs} {#2de2e6-fg}Enter{/} Start {#ff4fd8-fg}[S]{/} Delete {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    } else if (loop.status === 'error' || loop.status === 'stopped') {
      actions = `${newLoop} ${refresh} ${viewLogs} {#ffbe0b-fg}[R] RETRY{/} {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    } else if (loop.status === 'completed') {
      const closeIssueAction = loop.issueClosed ? '' : ` {#ff4fd8-fg}[C]{/}lose Issue`;
      actions = `${newLoop} ${refresh} ${viewLogs}${closeIssueAction} {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    } else {
      actions = `${newLoop} ${refresh} ${viewLogs} {#666-fg}│{/} ${nav} {#666-fg}│{/} ${quit}`;
    }

    statusBar.setContent(` ${actions}`);
  }

  // Initialize status bar
  updateStatusBar();

  // ═══════════════════════════════════════════════════════════════════════════
  // LOOP SELECTION HANDLER
  // ═══════════════════════════════════════════════════════════════════════════
  loopListWindow.on('select', (_item: any, index: number) => {
    const loop = loopListData[index];
    if (loop) {
      selectedLoopId = loop.id;
      updateDetailPane(loop);
      updateStatusBar(loop);
      loadLogsForLoop(loop.id);
      screen.render();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW LOOP MODAL
  // ═══════════════════════════════════════════════════════════════════════════
  screen.key(['n', 'N'], () => {
    if (isAnyInputActive()) return;
    let selectedAgent: 'claude' | 'codex' = 'claude';
    let skipPermissions = true;

    const modal = blessed.form({
      parent: screen,
      label: ' {bold}{#ff4fd8-fg}◆ NEW LOOP{/} ',
      tags: true,
      top: 'center',
      left: 'center',
      width: 70,
      height: 20,
      border: 'line',
      style: { fg: 'white', bg: 'blue', transparent: true, border: { fg: 'magenta' } },
      shadow: true,
      keys: true,
      vi: false,
    } as any);

    blessed.text({
      parent: modal,
      top: 1,
      left: 2,
      tags: true,
      content: '{#eaeaea-fg}Paste a GitHub Issue URL:{/}',
    });

    const input = createCursorInput({
      parent: modal,
      top: 3,
      left: 2,
      width: 64,
      height: 3,
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' }, focus: { border: { fg: 'magenta' } } },
    }, screen);

    blessed.text({
      parent: modal,
      top: 6,
      left: 2,
      tags: true,
      content: '{#eaeaea-fg}Paste local repo root:{/}',
    });

    const repoInput = createCursorInput({
      parent: modal,
      top: 8,
      left: 2,
      width: 64,
      height: 3,
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' }, focus: { border: { fg: 'magenta' } } },
      value: process.cwd(),
    }, screen);

    // Use InputManager to safely handle switching between inputs
    const inputManager = createInputManager<ManagedInput>({
      onActivate: () => screen.render(),
    });

    // Click to focus/edit textboxes
    input.on('click', () => inputManager.activate(input));
    repoInput.on('click', () => inputManager.activate(repoInput));

    // Auto-focus first input when modal opens
    setTimeout(() => inputManager.activate(input), 50);

    // Tab to switch between inputs
    input.key(['tab'], () => inputManager.activate(repoInput));
    repoInput.key(['tab'], () => inputManager.activate(input));

    blessed.text({
      parent: modal,
      top: 12,
      left: 2,
      tags: true,
      content: '{#9b5de5-fg}Agent:{/}',
    });

    const claudeBtn = blessed.button({
      parent: modal,
      top: 12,
      left: 10,
      width: 12,
      height: 1,
      tags: true,
      content: '{#2de2e6-fg}[●]{/} Claude',
      mouse: true,
      style: { fg: 'white', bg: 'transparent', hover: { fg: 'cyan' } },
    } as any);

    const codexBtn = blessed.button({
      parent: modal,
      top: 12,
      left: 24,
      width: 11,
      height: 1,
      tags: true,
      content: '{#666-fg}[ ]{/} Codex',
      mouse: true,
      style: { fg: 'white', bg: 'transparent', hover: { fg: 'cyan' } },
    } as any);

    blessed.text({
      parent: modal,
      top: 14,
      left: 2,
      tags: true,
      content: '{#9b5de5-fg}Options:{/}',
    });

    const skipPermBtn = blessed.button({
      parent: modal,
      top: 14,
      left: 11,
      width: 22,
      height: 1,
      tags: true,
      content: '{#00f5d4-fg}[✓]{/} Skip permissions',
      mouse: true,
      style: { fg: 'white', bg: 'transparent', hover: { fg: 'cyan' } },
    } as any);

    function updateAgentButtons(): void {
      claudeBtn.setContent(selectedAgent === 'claude' ? '{#2de2e6-fg}[●]{/} Claude' : '{#666-fg}[ ]{/} Claude');
      codexBtn.setContent(selectedAgent === 'codex' ? '{#2de2e6-fg}[●]{/} Codex' : '{#666-fg}[ ]{/} Codex');
      screen.render();
    }

    function updateSkipPermBtn(): void {
      skipPermBtn.setContent(skipPermissions ? '{#00f5d4-fg}[✓]{/} Skip permissions' : '{#666-fg}[ ]{/} Skip permissions');
      screen.render();
    }

    claudeBtn.on('press', () => {
      selectedAgent = 'claude';
      updateAgentButtons();
    });

    codexBtn.on('press', () => {
      selectedAgent = 'codex';
      updateAgentButtons();
    });

    skipPermBtn.on('press', () => {
      skipPermissions = !skipPermissions;
      updateSkipPermBtn();
    });

    const createBtn = blessed.button({
      parent: modal,
      top: 16,
      left: 2,
      width: 16,
      height: 3,
      content: '  ◆ Create  ',
      align: 'center',
      style: { fg: 'black', bg: 'magenta', bold: true, hover: { bg: 'cyan' } },
      mouse: true,
      shadow: true,
    } as any);

    const cancelBtn = blessed.button({
      parent: modal,
      top: 16,
      left: 20,
      width: 14,
      height: 3,
      content: '  Cancel  ',
      align: 'center',
      style: { fg: 'white', bg: 240, hover: { bg: 'red' } },
      mouse: true,
    } as any);

    const closeModal = (): void => {
      inputManager.deactivate();  // Clean up input state before destroying
      modal.destroy();
      loopListWindow.focus();
      screen.render();
    };

    const handleCreate = async (): Promise<void> => {
      const url = input.getValue().trim();
      if (!url) {
        logWithGlow('{#ff006e-fg}[error]{/} Please enter a GitHub issue URL', 'error');
        screen.render();
        return;
      }

      const repoRootRaw = repoInput.getValue().trim();
      if (!repoRootRaw) {
        logWithGlow('{#ff006e-fg}[error]{/} Please enter the local repo root', 'error');
        screen.render();
        return;
      }
      const repoRoot = path.resolve(repoRootRaw);
      if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
        logWithGlow('{#ff006e-fg}[error]{/} Local repo root is not a directory', 'error');
        screen.render();
        return;
      }

      closeModal();
      logWithGlow(`{#666-fg}[system]{/} Fetching issue from ${url}...`, 'system');
      screen.render();

      const openCriteriaModal = (issue: Issue): void => {
        const originalCriteria = issue.originalAcceptanceCriteria?.map(criterion => ({ ...criterion }))
          ?? issue.acceptanceCriteria.map(criterion => ({ ...criterion }));
        const criteriaDraft = issue.acceptanceCriteria.length > 0
          ? issue.acceptanceCriteria.map(criterion => ({ ...criterion }))
          : [{ text: '', completed: false }];

        const modal = blessed.box({
          parent: screen,
          label: ' {bold}{#ff4fd8-fg}◆ ACCEPTANCE CRITERIA{/} ',
          tags: true,
          top: 'center',
          left: 'center',
          width: 80,
          height: 20,
          border: 'line',
          style: { fg: 'white', bg: 'blue', transparent: true, border: { fg: 'magenta' } },
          shadow: true,
          keys: true,
        } as any);

        blessed.text({
          parent: modal,
          top: 1,
          left: 2,
          tags: true,
          content: '{#eaeaea-fg}↑↓ navigate  Tab = edit  Enter = accept  [+] add  [-] remove{/}',
        });

        // Scrollable list container
        const listBox = blessed.list({
          parent: modal,
          top: 3,
          left: 2,
          width: 74,
          height: 12,
          border: 'line',
          scrollable: true,
          alwaysScroll: true,
          scrollbar: { ch: '│', track: { bg: 'black' }, style: { bg: 'cyan' } },
          keys: true,
          vi: true,
          mouse: true,
          tags: true,
          style: {
            border: { fg: 'cyan' },
            selected: { fg: 'black', bg: 'cyan' },
            item: { fg: 'white' },
          },
        } as any);

        let selectedIndex = 0;
        let editingIndex: number | null = null;
        let editInput: ReturnType<typeof createCursorInput> | null = null;

        const renderList = (): void => {
          const items = criteriaDraft.map((c, i) => {
            const num = `{#666-fg}${String(i + 1).padStart(2)}.{/}`;
            const text = c.text || '{#666-fg}(empty){/}';
            return ` ${num} ${text}`;
          });
          listBox.setItems(items);
          listBox.select(selectedIndex);
          screen.render();
        };

        const startEditing = (index: number): void => {
          if (editInput) {
            // Save current edit first
            criteriaDraft[editingIndex!].text = editInput.getValue().trim();
            editInput.box.destroy();
            editInput = null;
          }

          editingIndex = index;
          selectedIndex = index;

          // Create inline text input overlay
          editInput = createCursorInput({
            parent: modal,
            top: 4 + index - (listBox.getScroll() as number),
            left: 8,
            width: 66,
            height: 1,
            style: {
              fg: 'white',
              bg: 'black',
              focus: { fg: 'white', bg: 'black' },
            },
            value: criteriaDraft[index].text,
          }, screen);

          editInput.focus();
          screen.render();

          // Handle edit completion
          editInput.key(['enter', 'escape'], () => {
            if (editInput) {
              criteriaDraft[editingIndex!].text = editInput.getValue().trim();
              editInput.box.destroy();
              editInput = null;
              editingIndex = null;
              listBox.focus();
              renderList();
            }
          });

          editInput.key(['tab'], () => {
            if (editInput) {
              criteriaDraft[editingIndex!].text = editInput.getValue().trim();
              editInput.box.destroy();
              editInput = null;
              editingIndex = null;
              // Move to next and start editing
              selectedIndex = (selectedIndex + 1) % criteriaDraft.length;
              listBox.select(selectedIndex);
              renderList();
              setTimeout(() => startEditing(selectedIndex), 10);
            }
          });
        };

        const stopEditing = (): void => {
          if (editInput) {
            criteriaDraft[editingIndex!].text = editInput.getValue().trim();
            editInput.box.destroy();
            editInput = null;
            editingIndex = null;
            listBox.focus();
            renderList();
          }
        };

        renderList();

        // List navigation
        listBox.on('select', (_item: any, index: number) => {
          selectedIndex = index;
        });

        // Tab to edit selected item
        listBox.key(['tab', 'e'], () => {
          startEditing(selectedIndex);
        });

        // Add new criterion
        listBox.key(['+', 'a'], () => {
          stopEditing();
          criteriaDraft.push({ text: '', completed: false });
          selectedIndex = criteriaDraft.length - 1;
          renderList();
          setTimeout(() => startEditing(selectedIndex), 10);
        });

        // Remove selected criterion
        listBox.key(['-', 'x', 'delete'], () => {
          stopEditing();
          if (criteriaDraft.length > 1) {
            criteriaDraft.splice(selectedIndex, 1);
            selectedIndex = Math.min(selectedIndex, criteriaDraft.length - 1);
          } else {
            criteriaDraft[0].text = '';
          }
          renderList();
        });

        const closeCriteriaModal = (): void => {
          stopEditing();
          modal.destroy();
          loopListWindow.focus();
          screen.render();
        };

        const finalizeCriteria = (): void => {
          stopEditing();

          const nextCriteria = criteriaDraft
            .filter(criterion => criterion.text.trim().length > 0)
            .map(criterion => ({ ...criterion, text: criterion.text.trim() }));

          const updatedBody = applyAcceptanceCriteriaToIssueBody(issue.body || '', nextCriteria);
          const updatedIssue: Issue = {
            ...issue,
            acceptanceCriteria: nextCriteria,
            originalAcceptanceCriteria: originalCriteria,
            body: updatedBody,
          };

          try {
            updateIssueBody(updatedIssue.url, updatedBody);
          } catch (err: any) {
            logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
          }

          const loop = createLoop(updatedIssue, selectedAgent, skipPermissions, repoRoot);

          state = loadState();
          updateLoopList();
          updateHeader();
          updateTabBar();
          syncSelectionAfterFilter();

          const filteredIndex = loopListData.findIndex(l => l.id === loop.id);
          if (filteredIndex >= 0) {
            loopListWindow.select(filteredIndex);
            loopListWindow.emit('select', null, filteredIndex);
          }

          logWithGlow(`{#00f5d4-fg}[system]{/} Loop created: ${updatedIssue.title}`, 'system');
          logWithGlow(`{#666-fg}[system]{/} Press Enter to start the loop`, 'system');
          closeCriteriaModal();
        };

        // Bottom bar with hints
        blessed.text({
          parent: modal,
          top: 16,
          left: 2,
          tags: true,
          content: '{#2de2e6-fg}Enter{/} Accept  {#ff4fd8-fg}Esc{/} Cancel  {#ffbe0b-fg}+{/} Add  {#ffbe0b-fg}-{/} Remove  {#9b5de5-fg}Tab{/} Edit',
        });

        listBox.key(['enter'], () => {
          if (editingIndex === null) {
            finalizeCriteria();
          }
        });

        modal.key(['escape'], () => {
          if (editingIndex !== null) {
            stopEditing();
          } else {
            closeCriteriaModal();
          }
        });

        listBox.focus();
      };

      try {
        const issue = await fetchIssue(url);
        openCriteriaModal(issue);
      } catch (err: any) {
        logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        screen.render();
      }
    };

    createBtn.on('press', handleCreate);
    cancelBtn.on('press', closeModal);
    input.key(['escape'], closeModal);
    repoInput.key(['escape'], closeModal);
    modal.key(['escape'], closeModal);

    // Shift-tab to go backwards
    input.key(['S-tab'], () => inputManager.activate(repoInput));
    repoInput.key(['S-tab'], () => inputManager.activate(input));

    // Toggle permissions with Space (when not in input)
    modal.key(['space'], () => {
      if (screen.focused === input.box || screen.focused === repoInput.box) {
        return;
      }
      skipPermissions = !skipPermissions;
      updateSkipPermBtn();
    });

    screen.render();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION KEYS
  // ═══════════════════════════════════════════════════════════════════════════

  // Enter - Start queued loop
  screen.key(['enter'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (loop?.status === 'queued') {
      // startLoop is async - fire and forget, errors handled via events
      startLoop(loop.id).catch((err: Error) => {
        logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        screen.render();
      });
      // Immediate UI update
      state = loadState();
      const updatedLoop = state.loops.find(l => l.id === selectedLoopId);
      updateLoopList();
      updateHeader();
      updateTabBar();
      const selectionChanged = syncSelectionAfterFilter();
      if (!selectionChanged && updatedLoop) {
        updateDetailPane(updatedLoop);
        updateStatusBar(updatedLoop);
      }
      // Start tailing logs for the running loop
      loadLogsForLoop(loop.id);
      screen.render();
    }
  });

  // P - Pause/Resume
  screen.key(['p', 'P'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    try {
      if (loop.status === 'running') {
        pauseLoop(loop.id);
        state = loadState();
        const updatedLoop = state.loops.find(l => l.id === selectedLoopId);
        updateLoopList();
        updateHeader();
        updateTabBar();
        const selectionChanged = syncSelectionAfterFilter();
        if (!selectionChanged && updatedLoop) {
          updateDetailPane(updatedLoop);
          updateStatusBar(updatedLoop);
        }
        screen.render();
      } else if (loop.status === 'paused') {
        // Check if this is a cross-session resume (no active process)
        if (canResumeInSession(loop.id)) {
          // Same-session resume with SIGCONT
          resumeLoop(loop.id);
          state = loadState();
          const updatedLoop = state.loops.find(l => l.id === selectedLoopId);
          updateLoopList();
          updateHeader();
          updateTabBar();
          const selectionChanged = syncSelectionAfterFilter();
          if (!selectionChanged && updatedLoop) {
            updateDetailPane(updatedLoop);
            updateStatusBar(updatedLoop);
          }
          screen.render();
        } else {
          // Cross-session resume - spawn new process with context
          logWithGlow('{#ffbe0b-fg}[system]{/} Resuming loop from previous session...', 'system');
          screen.render();
          resumePausedLoop(loop.id).catch((err: Error) => {
            logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
            screen.render();
          });
        }
      }
    } catch (err: any) {
      logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
      screen.render();
    }
  });

  // S - Stop
  screen.key(['s', 'S'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    if (loop.status === 'running' || loop.status === 'paused') {
      try {
        stopLoop(loop.id);
        state = loadState();
        const updatedLoop = state.loops.find(l => l.id === selectedLoopId);
        updateLoopList();
        updateHeader();
        updateTabBar();
        const selectionChanged = syncSelectionAfterFilter();
        if (!selectionChanged && updatedLoop) {
          updateDetailPane(updatedLoop);
          updateStatusBar(updatedLoop);
        }
        screen.render();
      } catch (err: any) {
        logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        screen.render();
      }
    }
  });

  // D - Discard paused loop from previous session
  screen.key(['d', 'D'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    if (loop.status === 'paused' && loop.pausedFromPreviousSession) {
      try {
        discardPausedLoop(loop.id);
        state = loadState();
        // Select next loop or clear selection
        const remainingLoops = state.loops;
        if (remainingLoops.length > 0) {
          selectedLoopId = remainingLoops[0].id;
        } else {
          selectedLoopId = null;
        }
        updateLoopList();
        updateHeader();
        updateTabBar();
        syncSelectionAfterFilter();
        if (selectedLoopId) {
          const newLoop = state.loops.find(l => l.id === selectedLoopId);
          if (newLoop) {
            updateDetailPane(newLoop);
            updateStatusBar(newLoop);
          }
        } else {
          detailWindow.setContent('{#666-fg}No loops.{/}');
          updateStatusBar();
        }
        logWithGlow('{#ffbe0b-fg}[system]{/} Paused loop discarded', 'system');
        screen.render();
      } catch (err: any) {
        logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        screen.render();
      }
    }
  });

  // R - Retry errored/stopped loop
  screen.key(['r', 'R'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    if (loop.status === 'error' || loop.status === 'stopped') {
      retryLoop(loop.id).catch((err: Error) => {
        logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        screen.render();
      });
      // Immediate UI update
      state = loadState();
      const updatedLoop = state.loops.find(l => l.id === selectedLoopId);
      updateLoopList();
      updateHeader();
      updateTabBar();
      const selectionChanged = syncSelectionAfterFilter();
      if (!selectionChanged && updatedLoop) {
        updateDetailPane(updatedLoop);
        updateStatusBar(updatedLoop);
      }
      // Refresh log view to show new retry logs
      loadLogsForLoop(loop.id);
      screen.render();
    }
  });

  // C - Close issue for completed loop (with confirmation)
  screen.key(['c', 'C'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    if (loop.status !== 'completed') {
      logWithGlow('{#ff006e-fg}[error]{/} Can only close issues for completed loops', 'error');
      screen.render();
      return;
    }

    if (loop.issueClosed) {
      logWithGlow('{#ffbe0b-fg}[system]{/} Issue already closed', 'system');
      screen.render();
      return;
    }

    const modal = blessed.box({
      parent: screen,
      label: ' {bold}{#ff4fd8-fg}◆ CLOSE ISSUE{/} ',
      tags: true,
      top: 'center',
      left: 'center',
      width: 70,
      height: 12,
      border: 'line',
      style: { fg: 'white', bg: 'blue', transparent: true, border: { fg: 'magenta' } },
      shadow: true,
    } as any);

    blessed.text({
      parent: modal,
      top: 1,
      left: 2,
      tags: true,
      content: `{#eaeaea-fg}Optional comment for issue #${loop.issue.number}:{/}`,
    });

    const commentInput = createCursorInput({
      parent: modal,
      top: 3,
      left: 2,
      width: 64,
      height: 3,
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' }, focus: { border: { fg: 'magenta' } } },
    }, screen);

    const inputManager = createInputManager<ManagedInput>({
      onActivate: () => screen.render(),
    });

    commentInput.on('click', () => inputManager.activate(commentInput));
    setTimeout(() => inputManager.activate(commentInput), 50);

    const closeModal = (): void => {
      modal.destroy();
      loopListWindow.focus();
      screen.render();
    };

    const showConfirm = (comment?: string): void => {
      const confirm = blessed.box({
        parent: screen,
        label: ' {bold}{#ff4fd8-fg}◆ CONFIRM{/} ',
        tags: true,
        top: 'center',
        left: 'center',
        width: 50,
        height: 7,
        border: 'line',
        style: { fg: 'white', bg: 'blue', transparent: true, border: { fg: 'magenta' } },
        shadow: true,
      } as any);

      blessed.text({
        parent: confirm,
        top: 1,
        left: 2,
        tags: true,
        content: `{#eaeaea-fg}Close issue #${loop.issue.number}?{/}`,
      });

      const yesBtn = blessed.button({
        parent: confirm,
        top: 3,
        left: 2,
        width: 10,
        height: 1,
        content: 'Yes',
        align: 'center',
        style: { fg: 'black', bg: 'magenta', bold: true, hover: { bg: 'cyan' } },
        mouse: true,
      } as any);

      const noBtn = blessed.button({
        parent: confirm,
        top: 3,
        left: 14,
        width: 10,
        height: 1,
        content: 'No',
        align: 'center',
        style: { fg: 'white', bg: 240, hover: { bg: 'red' } },
        mouse: true,
      } as any);

      const closeConfirm = (): void => {
        confirm.destroy();
        screen.render();
      };

      const handleCloseIssue = (): void => {
        closeConfirm();
        closeModal();

        try {
          const result = closeIssue(loop.issue.url, comment);
          let nextState = loadState();
          nextState = updateLoop(nextState, loop.id, { issueClosed: true });
          saveState(nextState);
          state = nextState;

          const updatedLoop = state.loops.find(l => l.id === loop.id);
          updateLoopList();
          updateHeader();
          updateTabBar();
          const selectionChanged = syncSelectionAfterFilter();
          if (!selectionChanged && updatedLoop) {
            updateDetailPane(updatedLoop);
            updateStatusBar(updatedLoop);
          }

          if (result === 'already_closed') {
            logWithGlow(`{#ffbe0b-fg}[system]{/} Issue #${loop.issue.number} was already closed`, 'system');
          } else {
            logWithGlow(`{#00f5d4-fg}[system]{/} Closed issue #${loop.issue.number}`, 'system');
          }
        } catch (err: any) {
          logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        }
        screen.render();
      };

      yesBtn.on('press', handleCloseIssue);
      noBtn.on('press', () => {
        closeConfirm();
        closeModal();
      });

      confirm.key(['y', 'Y', 'enter'], handleCloseIssue);
      confirm.key(['n', 'N', 'escape'], () => {
        closeConfirm();
        closeModal();
      });

      confirm.focus();
      screen.render();
    };

    const closeBtn = blessed.button({
      parent: modal,
      top: 7,
      left: 2,
      width: 12,
      height: 1,
      content: 'Close',
      align: 'center',
      style: { fg: 'black', bg: 'magenta', bold: true, hover: { bg: 'cyan' } },
      mouse: true,
    } as any);

    const cancelBtn = blessed.button({
      parent: modal,
      top: 7,
      left: 16,
      width: 12,
      height: 1,
      content: 'Cancel',
      align: 'center',
      style: { fg: 'white', bg: 240, hover: { bg: 'red' } },
      mouse: true,
    } as any);

    const proceedToConfirm = (): void => {
      const comment = commentInput.getValue().trim();
      showConfirm(comment || undefined);
    };

    closeBtn.on('press', proceedToConfirm);
    cancelBtn.on('press', closeModal);
    modal.key(['escape'], closeModal);
    modal.key(['y', 'Y', 'enter'], proceedToConfirm);

    screen.render();
  });

  // I - Intervene
  screen.key(['i', 'I'], () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (loop?.status !== 'running') {
      logWithGlow('{#ff006e-fg}[error]{/} Can only intervene in running loops', 'error');
      screen.render();
      return;
    }

    const modal = blessed.box({
      parent: screen,
      label: ' {bold}{#ff4fd8-fg}◆ INTERVENE{/} ',
      tags: true,
      top: 'center',
      left: 'center',
      width: 60,
      height: 10,
      border: 'line',
      style: { fg: 'white', bg: 'blue', transparent: true, border: { fg: 'magenta' } },
      shadow: true,
    } as any);

    blessed.text({
      parent: modal,
      top: 1,
      left: 2,
      tags: true,
      content: '{#eaeaea-fg}Send a message to the agent:{/}',
    });

    const input = blessed.textbox({
      parent: modal,
      top: 3,
      left: 2,
      width: 54,
      height: 3,
      border: 'line',
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      inputOnFocus: true,
      mouse: true,
    } as any);

    const closeModal = (): void => {
      modal.destroy();
      loopListWindow.focus();
      screen.render();
    };

    input.key(['enter'], () => {
      const message = (input as any).getValue().trim();
      if (message && selectedLoopId) {
        try {
          sendIntervention(selectedLoopId, message);
        } catch (err: any) {
          logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
        }
      }
      closeModal();
    });

    input.key(['escape'], closeModal);
    input.focus();
    screen.render();
  });

  // L - View full log
  screen.key(['l', 'L'], () => {
    if (isAnyInputActive()) return;
    if (logViewer) {
      closeLogViewer();
      return;
    }
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;
    openLogViewer(loop);
  });

  // T - Refresh issue data
  screen.key(['t', 'T'], async () => {
    if (isAnyInputActive()) return;
    if (!selectedLoopId) return;
    const loop = state.loops.find(l => l.id === selectedLoopId);
    if (!loop) return;

    detailWindow.setContent(
      `{bold}{#fff-fg}${loop.issue.title}{/}{/bold}\n` +
      `{#666-fg}─────────────────────────────────────────────────────{/}\n` +
      `{#ffbe0b-fg}Refreshing issue data...{/}`
    );
    logWithGlow(`{#666-fg}[system]{/} Refreshing issue #${loop.issue.number}...`, 'system');
    screen.render();

    try {
      const issue = await fetchIssue(loop.issue.url);
      let nextState = loadState();
      nextState = updateLoop(nextState, loop.id, { issue });
      saveState(nextState);
      state = nextState;

      updateLoopList();
      updateHeader();
      updateTabBar();
      const selectionChanged = syncSelectionAfterFilter();
      const updatedLoop = state.loops.find(l => l.id === loop.id);
      if (!selectionChanged && updatedLoop) {
        updateDetailPane(updatedLoop);
        updateStatusBar(updatedLoop);
      }

      logWithGlow(`{#00f5d4-fg}[system]{/} Issue refreshed: ${issue.title}`, 'system');
    } catch (err: any) {
      logWithGlow(`{#ff006e-fg}[error]{/} ${err.message}`, 'error');
      const currentLoop = state.loops.find(l => l.id === selectedLoopId);
      if (currentLoop) {
        updateDetailPane(currentLoop);
      }
    }
    screen.render();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LOOP EVENTS - Update UI on state changes
  // ═══════════════════════════════════════════════════════════════════════════
  loopEvents.on('event', () => {
    state = loadState();
    updateLoopList();
    updateHeader();
    updateTabBar();
    const selectionChanged = syncSelectionAfterFilter();
    if (!selectionChanged && selectedLoopId) {
      const loop = state.loops.find(l => l.id === selectedLoopId);
      if (loop) {
        updateDetailPane(loop);
        updateStatusBar(loop);
      }
    }
    screen.render();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP ON EXIT
  // ═══════════════════════════════════════════════════════════════════════════
  screen.on('destroy', () => {
    if (logTailCleanup) logTailCleanup();
    killAll();
  });

  // Initial render
  loopListWindow.focus();
  setActiveTab(activeTabIndex);
  if (state.loops.length > 0) {
    loopListWindow.select(0);
    loopListWindow.emit('select', null, 0);
  }
  screen.render();
}

main();
