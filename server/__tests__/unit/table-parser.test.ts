/**
 * Unit tests for parseMarkdownTable.
 *
 * These tests will FAIL until server/pipeline/table-parser.ts is created
 * and step4/step5 are updated to import from it.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownTable } from '../../pipeline/table-parser.js';

describe('parseMarkdownTable', () => {
  // ── Basic structure ────────────────────────────────────────────────────────

  it('parses a simple 2-column table', () => {
    const md = [
      '| Name | Value |',
      '|------|-------|',
      '| foo  | bar   |',
      '| baz  | qux   |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: 'foo', Value: 'bar' });
    expect(rows[1]).toEqual({ Name: 'baz', Value: 'qux' });
  });

  it('parses a multi-column table', () => {
    const md = [
      '| Date | Provider | Diagnosis | Citation |',
      '|------|----------|-----------|----------|',
      '| 2024-01-15 | Dr. Smith | Lumbar strain | Record p. 5 |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('Date', '2024-01-15');
    expect(rows[0]).toHaveProperty('Provider', 'Dr. Smith');
    expect(rows[0]).toHaveProperty('Diagnosis', 'Lumbar strain');
    expect(rows[0]).toHaveProperty('Citation', 'Record p. 5');
  });

  it('trims whitespace from headers and cells', () => {
    const md = [
      '|  Header A  |  Header B  |',
      '|------------|------------|',
      '|  value 1   |  value 2   |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows[0]).toEqual({ 'Header A': 'value 1', 'Header B': 'value 2' });
  });

  it('returns an empty array when there are no data rows', () => {
    const md = [
      '| Col1 | Col2 |',
      '|------|------|',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(0);
  });

  // ── Invalid inputs ─────────────────────────────────────────────────────────

  it('returns an empty array for a string with no pipe characters', () => {
    expect(parseMarkdownTable('no table here')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseMarkdownTable('')).toEqual([]);
  });

  it('returns an empty array when there is only one pipe row (no separator)', () => {
    const md = '| Header |';
    expect(parseMarkdownTable(md)).toEqual([]);
  });

  // ── Real-world Gemini output patterns ─────────────────────────────────────

  it('handles a table preceded by narrative text', () => {
    const md = [
      'Here is the medical chronology:',
      '',
      '| Date | Event |',
      '|------|-------|',
      '| 2023-05-01 | Initial exam |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0].Date).toBe('2023-05-01');
  });

  it('handles a table followed by narrative text', () => {
    const md = [
      '| Date | Event |',
      '|------|-------|',
      '| 2023-05-01 | Initial exam |',
      '',
      'Note: This table represents...',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(1);
  });

  it('handles cells containing long text with internal spaces', () => {
    const md = [
      '| Date | Summary |',
      '|------|---------|',
      '| 2022-03-10 | Patient presented with complaints of lower back pain radiating down the left leg |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0].Summary).toContain('lower back pain');
  });

  it('handles empty cells (missing values) without throwing', () => {
    const md = [
      '| Date | Provider | Note |',
      '|------|----------|------|',
      '| 2023-01-01 |  | Follow-up |',
      '| 2023-02-01 | Dr. Jones |  |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(2);
    expect(rows[0].Provider).toBe('');
    expect(rows[1].Note).toBe('');
  });

  it('assigns empty string when a row has fewer cells than headers', () => {
    const md = [
      '| A | B | C |',
      '|---|---|---|',
      '| 1 | 2 |',   // missing third cell
    ].join('\n');
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0].C).toBe('');
  });

  // ── Table 1 / Table 2 schema assertions ───────────────────────────────────

  it('produces objects with string values for all cells', () => {
    const md = [
      '| Date | Provider | Diagnosis |',
      '|------|----------|-----------|',
      '| 2024-01-01 | Dr. A | Condition X |',
      '| 2024-02-01 | Dr. B | Condition Y |',
    ].join('\n');
    const rows = parseMarkdownTable(md);
    for (const row of rows) {
      for (const val of Object.values(row)) {
        expect(typeof val).toBe('string');
      }
    }
  });
});
