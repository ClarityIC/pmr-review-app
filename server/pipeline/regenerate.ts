/**
 * Table regeneration — re-runs Step 4 or Step 5 with a custom prompt
 * for a single case, creating a new version entry.
 *
 * Also exports regenerateBothTables() which re-runs both steps sequentially
 * and sets the case status to 'complete' when done (used for error recovery).
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

/**
 * Regenerate both Table 1 and Table 2 sequentially using the case's stored
 * prompts, then set status = 'complete'. Used for error-recovery when
 * ingestion succeeded but table generation failed.
 *
 * The caller must set status = 'processing' before calling this so that the
 * CasePage SSE subscription activates and the processing spinner shows.
 */
export async function regenerateBothTables(caseId: string, userEmail: string): Promise<void> {
  const log = (level: LogLevel, message: string) => emitLog(caseId, level, message);
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ processingLogs: [] }).catch(() => {});

    const caseData = await getCase(caseId);
    if (!caseData) throw new Error('Case not found');

    log('info', 'Regenerating Table 1 (Medical Chronology)…');
    const { rows: table1Rows, markdownTable: table1Md } = await step4(caseId, caseData.table1Prompt, log);
    await updateCase(caseId, { table1: table1Rows, table1Markdown: table1Md });

    log('info', 'Regenerating Table 2 (Patient Conditions)…');
    const { rows: table2Rows, markdownTable: table2Md } = await step5(caseId, table1Md, caseData.table2Prompt, log);

    const now = new Date().toISOString();
    const t1Versions = ensureVersionHistory(caseData, 'table1');
    const t2Versions = ensureVersionHistory(caseData, 'table2');
    const t1NextVer = t1Versions.length > 0 ? t1Versions[0].version + 1 : 1;
    const t2NextVer = t2Versions.length > 0 ? t2Versions[0].version + 1 : 1;

    const t1Version: TableVersion = {
      version: t1NextVer, rows: table1Rows, markdownTable: table1Md,
      prompt: caseData.table1Prompt || 'default', generatedAt: now, generatedBy: userEmail,
    };
    const t2Version: TableVersion = {
      version: t2NextVer, rows: table2Rows, markdownTable: table2Md,
      prompt: caseData.table2Prompt || 'default', generatedAt: now, generatedBy: userEmail,
    };

    await updateCase(caseId, {
      status: 'complete',
      table1: table1Rows, table1Markdown: table1Md,
      table2: table2Rows, table2Markdown: table2Md,
      table1Versions: [t1Version, ...t1Versions],
      table2Versions: [t2Version, ...t2Versions],
      table1ActiveVersion: 0,
      table2ActiveVersion: 0,
      dateProcessed: now,
      errorMessage: null,
    } as any);

    log('success', `Pipeline complete! Table 1: ${table1Rows.length} records, Table 2: ${table2Rows.length} conditions`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    log('error', `Table generation failed: ${msg}`);
    await updateCase(caseId, { status: 'error', errorMessage: msg }).catch(() => {});
    throw err;
  }
}

export async function regenerateTable(
  caseId: string,
  table: 'table1' | 'table2',
  prompt: string,
  userEmail: string,
  table1Version?: number,
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
      let t1Markdown: string | undefined;
      if (table1Version != null && caseData.table1Versions?.length) {
        const v = caseData.table1Versions.find((ver: any) => ver.version === table1Version);
        if (!v?.markdownTable) throw new Error(`Table 1 version ${table1Version} not found or has no markdown.`);
        t1Markdown = v.markdownTable;
        log('info', `Using Table 1 version ${table1Version} as context for Table 2`);
      } else {
        t1Markdown = caseData.table1Markdown;
      }
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
