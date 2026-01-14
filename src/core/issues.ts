import { execFileSync, execSync } from 'child_process';
import { Issue, AcceptanceCriterion } from './types.js';

// Parse a GitHub issue URL
// Supports: https://github.com/owner/repo/issues/123
export function parseIssueUrl(url: string): { repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return {
    repo: match[1],
    number: parseInt(match[2], 10),
  };
}

// Fetch issue data using gh CLI
export async function fetchIssue(url: string): Promise<Issue> {
  const parsed = parseIssueUrl(url);
  if (!parsed) {
    throw new Error(`Invalid GitHub issue URL: ${url}`);
  }

  const { repo, number } = parsed;

  try {
    // Use gh CLI to fetch issue JSON
    const result = execSync(
      `gh issue view ${number} --repo ${repo} --json title,body,number,url`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    const data = JSON.parse(result);
    const acceptanceCriteria = parseAcceptanceCriteria(data.body || '');
    const originalAcceptanceCriteria = acceptanceCriteria.map(criterion => ({ ...criterion }));

    return {
      url: data.url || url,
      number: data.number,
      title: data.title,
      body: data.body || '',
      repo,
      acceptanceCriteria,
      originalAcceptanceCriteria,
    };
  } catch (err: any) {
    if (err.message?.includes('gh: command not found')) {
      throw new Error('GitHub CLI (gh) not found. Install from https://cli.github.com');
    }
    throw new Error(`Failed to fetch issue: ${err.message}`);
  }
}

export type CloseIssueResult = 'closed' | 'already_closed';

// Close issue using gh CLI with optional comment
export function closeIssue(url: string, comment?: string): CloseIssueResult {
  if (!url) {
    throw new Error('Missing GitHub issue URL');
  }

  const args = ['issue', 'close', url];
  const trimmedComment = comment?.trim();
  if (trimmedComment) {
    args.push('--comment', trimmedComment);
  }

  try {
    execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return 'closed';
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || '';
    const stdout = err?.stdout?.toString?.() || '';
    const message = (stderr || stdout || err?.message || '').trim();

    if (err?.code === 'ENOENT' || message.includes('gh: command not found')) {
      throw new Error('GitHub CLI (gh) not found. Install from https://cli.github.com');
    }

    if (/already\s+closed/i.test(message) || /already\s+been\s+closed/i.test(message)) {
      return 'already_closed';
    }

    const firstLine = message.split('\n')[0] || 'Unknown error';
    throw new Error(`Failed to close issue: ${firstLine}`);
  }
}

const criteriaSectionHeaders = [
  /^#{1,3}\s*acceptance\s*criteria/i,
  /^#{1,3}\s*done\s*when/i,
  /^#{1,3}\s*stop\s*conditions/i,
  /^#{1,3}\s*requirements/i,
  /^\*\*acceptance\s*criteria\*\*/i,
];

function renderAcceptanceCriteriaSection(criteria: AcceptanceCriterion[]): string {
  const lines = ['## Acceptance Criteria'];
  if (criteria.length > 0) {
    for (const ac of criteria) {
      const checkbox = ac.completed ? '[x]' : '[ ]';
      lines.push(`- ${checkbox} ${ac.text}`);
    }
  }
  return lines.join('\n');
}

export function applyAcceptanceCriteriaToIssueBody(body: string, criteria: AcceptanceCriterion[]): string {
  const lines = body.split('\n');
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (criteriaSectionHeaders.some(header => header.test(lines[i].trim()))) {
      start = i;
      break;
    }
  }

  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,3}\s+/.test(line) && !criteriaSectionHeaders.some(header => header.test(line.trim()))) {
        end = i;
        break;
      }
    }
  }

  const section = renderAcceptanceCriteriaSection(criteria).split('\n');

  if (start >= 0) {
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    return [...before, ...section, ...after].join('\n').replace(/\n{3,}/g, '\n\n');
  }

  const trimmed = body.trimEnd();
  const spacer = trimmed.length ? '\n\n' : '';
  return `${trimmed}${spacer}${section.join('\n')}`;
}

export function updateIssueBody(url: string, body: string): void {
  if (!url) {
    throw new Error('Missing GitHub issue URL');
  }

  try {
    execFileSync('gh', ['issue', 'edit', url, '--body', body], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || '';
    const stdout = err?.stdout?.toString?.() || '';
    const message = (stderr || stdout || err?.message || '').trim();

    if (err?.code === 'ENOENT' || message.includes('gh: command not found')) {
      throw new Error('GitHub CLI (gh) not found. Install from https://cli.github.com');
    }

    const firstLine = message.split('\n')[0] || 'Unknown error';
    throw new Error(`Failed to update issue: ${firstLine}`);
  }
}

// Parse acceptance criteria from issue body
// Looks for headings like "Acceptance Criteria", "Done When", "Stop Conditions"
// Falls back to checkbox items
export function parseAcceptanceCriteria(body: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const lines = body.split('\n');

  // First, try to find a dedicated section
  const sectionHeaders = criteriaSectionHeaders;

  let inSection = false;
  let sectionIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if we're entering an AC section
    if (!inSection) {
      for (const header of sectionHeaders) {
        if (header.test(line.trim())) {
          inSection = true;
          sectionIndent = line.search(/\S/);
          break;
        }
      }
      continue;
    }

    // Check if we're leaving the section (next heading)
    if (inSection && /^#{1,3}\s+/.test(line) && !sectionHeaders.some(h => h.test(line.trim()))) {
      break;
    }

    // Parse checkbox items in section
    const checkboxMatch = line.match(/^[\s]*[-*]\s*\[([ xX])\]\s*(.+)/);
    if (checkboxMatch) {
      criteria.push({
        text: checkboxMatch[2].trim(),
        completed: checkboxMatch[1].toLowerCase() === 'x',
        completedBy: checkboxMatch[1].toLowerCase() === 'x' ? 'operator' : undefined,
      });
      continue;
    }

    // Parse bullet points without checkboxes in section
    const bulletMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (bulletMatch && inSection) {
      criteria.push({
        text: bulletMatch[1].trim(),
        completed: false,
        completedBy: undefined,
      });
    }
  }

  // Fallback: if no section found, look for any checkboxes in the body
  if (criteria.length === 0) {
    for (const line of lines) {
      const checkboxMatch = line.match(/^[\s]*[-*]\s*\[([ xX])\]\s*(.+)/);
      if (checkboxMatch) {
      criteria.push({
        text: checkboxMatch[2].trim(),
        completed: checkboxMatch[1].toLowerCase() === 'x',
        completedBy: checkboxMatch[1].toLowerCase() === 'x' ? 'operator' : undefined,
      });
    }
  }
  }

  return criteria;
}

// Build prompt for agent from issue
export function buildPromptFromIssue(issue: Issue): string {
  let prompt = `# Task: ${issue.title}\n\n`;
  prompt += `GitHub Issue: ${issue.url}\n\n`;

  if (issue.acceptanceCriteria.length > 0) {
    prompt += `## Acceptance Criteria\n`;
    for (const ac of issue.acceptanceCriteria) {
      const checkbox = ac.completed ? '[x]' : '[ ]';
      prompt += `- ${checkbox} ${ac.text}\n`;
    }
    prompt += '\n';
  }

  prompt += `## Issue Description\n${issue.body}\n\n`;
  prompt += `## Instructions\n`;
  prompt += `Complete all acceptance criteria above.\n`;
  prompt += `Mark criteria as you finish them with:\n`;
  prompt += `- <criterion-complete>N</criterion-complete>\n`;
  prompt += `- <criterion-incomplete>N</criterion-incomplete> (if you need to regress)\n`;
  prompt += `Criteria are 1-indexed based on the list above.\n`;
  prompt += `When all criteria are complete, output the exact tag: <promise>TASK COMPLETE</promise>\n`;

  return prompt;
}
