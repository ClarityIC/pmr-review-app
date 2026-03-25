/**
 * Table regeneration — re-runs Step 4 or Step 5 with a custom prompt
 * for a single case, creating a new version entry.
 *
 * Reuses existing step4/step5 functions and the SSE log mechanism.
 * Case stays 'complete' even on error (regen failures are non-destructive).
 */
import { step4 } from './step4-table1.js';
import { step5 } from './step5-table2.js';
import { getCase, updateCase, TableVersion } from '../cases.js';
import { emitLog, LogLevel } from './orchestrator.js';
import { getFirestore } from '../config.js';

/**
 * Ensure a case has version history for the given table.
 * If the case already has table data but no versions array,
 * creates a retroactive Version 1 from the existing data.
 */
function ensureVersionHistory(
  caseData: any,
  table: 'table1' | 'table2',
): TableVersion[] {
  const versionsKey = `${table}Versions` as const;
  const existing = caseData[versionsKey];
  if (existing && existing.length > 0) return existing;

  const rows = caseData[table];
  if (!rows || rows.length === 0) return [];

  // Retroactively create Version 1 from existing data
  const markdownKey = `${table}Markdown` as const;
  return [{
    version: 1,
    rows,
    markdownTable: caseData[markdownKey] || '',
    prompt: 'initial pipeline',
    generatedAt: caseData.dateProcessed || caseData.updatedAt || new Date().toISOString(),
    generatedBy: caseData.createdBy || 'unknown',
  }];
}

export async function regenerateTable(
  caseId: string,
  table: 'table1' | 'table2',
  prompt: string,
  userEmail: string,
): Promise<void> {
  const log = (level: LogLevel, message: string) => emitLog(caseId, level, message);

  try {
    // Clear previous logs and mark regeneration in progress
    try {
      await getFirestore().collection('cases').doc(caseId)
        .update({ processingLogs: [] });
    } catch {}
    await updateCase(caseId, { regeneratingTable: table });

    const tableLabel = table === 'table1' ? 'Table 1 (Medical Chronology)' : 'Table 2 (Patient Conditions)';
    log('info', `Starting regeneration of ${tableLabel}`);

    const caseData = await getCase(caseId);
    if (!caseData) throw new Error('Case not found');

    // Build version history (lazy migration for existing cases)
    const versions = ensureVersionHistory(caseData, table);
    const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1;

    let rows: any[];
    let markdownTable: string;

    if (table === 'table1') {
      const result = await step4(caseId, prompt, log);
      rows = result.rows;
      markdownTable = result.markdownTable;
    } else {
      // Table 2 needs Table 1 markdown as context
      const t1Markdown = caseData.table1Markdown;
      if (!t1Markdown) {
        throw new Error('Table 1 markdown is not available. Please regenerate Table 1 first so Table 2 can reference it.');
      }
      const result = await step5(caseId, t1Markdown, prompt, log);
      rows = result.rows;
      markdownTable = result.markdownTable;
    }

    // Create new version entry
    const newVersion: TableVersion = {
      version: nextVersion,
      rows,
      markdownTable,
      prompt,
      generatedAt: new Date().toISOString(),
      generatedBy: userEmail,
    };

    // Prepend to versions array (newest first)
    const updatedVersions = [newVersion, ...versions];

    // Build the update patch
    const patch: Record<string, any> = {
      [table]: rows,
      [`${table}Markdown`]: markdownTable,
      [`${table}Versions`]: updatedVersions,
      [`${table}ActiveVersion`]: 0,
      regeneratingTable: null,
    };

    await updateCase(caseId, patch);
    log('success', `Regeneration complete! ${tableLabel}: ${rows.length} ${table === 'table1' ? 'records' : 'conditions'}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    log('error', `Regeneration failed: ${msg}`);
    // Clear the regeneration lock but do NOT change case status.
    // Retry once if the first clear fails — a stuck lock blocks all future regenerations.
    try {
      await updateCase(caseId, { regeneratingTable: null });
    } catch {
      try { await updateCase(caseId, { regeneratingTable: null }); } catch {}
    }
    throw err;
  }
}
