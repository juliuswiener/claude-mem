import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, buildInitPrompt } from '../../src/sdk/prompts.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

describe('buildInitPrompt observation skeleton', () => {
  it('requires a where (location) and a why (rationale) field distinct from narrative', () => {
    const mode = ModeManager.getInstance().loadMode('code');
    const prompt = buildInitPrompt('test-project', 'session-1', 'Fix the bug', mode);

    expect(prompt).toContain('<where>');
    expect(prompt).toContain(mode.prompts.xml_where_placeholder);
    expect(prompt).toContain('<why>');
    expect(prompt).toContain(mode.prompts.xml_why_placeholder);
    // where/why are separate tags from narrative, not folded into it
    expect(prompt.indexOf('<where>')).not.toBe(-1);
    expect(prompt.indexOf('<why>')).toBeGreaterThan(prompt.indexOf('<narrative>'));
  });
});

describe('buildObservationPrompt', () => {
  it('instructs the observer to avoid prose skip responses', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or <skip_summary reason="noise" />');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });
});

describe('buildObservationPrompt oversized field truncation (#2468)', () => {
  it('truncates an oversized outcome field with an elided marker, keeping head and tail', () => {
    const huge = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file: 'big.txt' }),
      tool_output: JSON.stringify({ content: huge }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('<elided');
    expect(prompt).toContain('reason="oversize"');
    // head and tail of the raw value are preserved
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
    // the oversized field is actually shrunk well below its raw 60k size
    expect(prompt.length).toBeLessThan(40_000);
  });

  it('leaves a small field untouched (no elided marker)', () => {
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // The prompt always carries a static "<elided chars=... />" instruction line,
    // so assert on the actual truncation marker (reason="oversize") instead.
    expect(prompt).not.toContain('reason="oversize"');
  });
});
