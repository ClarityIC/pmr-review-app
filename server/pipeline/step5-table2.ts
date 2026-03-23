/**
 * STEP 5: Semantic Synthesis for Table 2 (Patient Conditions)
 *
 * Uses both BigQuery Table 0 text AND the pre-generated Table 1 Markdown
 * as context, then calls Vertex AI Gemini 3.1 Pro with the Table 2 prompt.
 */
import { getGenAI, getEnv } from '../config.js';
import { getCaseText } from '../bigquery.js';
import { DEFAULT_TABLE2_PROMPT } from './prompts.js';
import { Log } from './orchestrator.js';
import { parseMarkdownTable } from './table-parser.js';

export async function step5(
  caseId: string,
  table1Markdown: string,
  promptOverride: string | undefined,
  log: Log,
): Promise<{ rows: any[]; markdownTable: string }> {
  log('info', '[Step 5] Querying BigQuery Table 0 for full case text (Table 2 context)');
  const table0Text = await getCaseText(caseId);

  const modelName = getEnv('GEMINI_MODEL') || 'gemini-3.1-pro-preview';
  log('info', `[Step 5] Calling Gemini (${modelName}) to generate Table 2`);

  const basePrompt = promptOverride || DEFAULT_TABLE2_PROMPT;
  const prompt = basePrompt
    .replace('{{TABLE0_TEXT}}', table0Text)
    .replace('{{TABLE1_MARKDOWN}}', table1Markdown);

  const genai = getGenAI();
  const response = await genai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: 65536,
      temperature: 0.1,
    },
  });

  const markdownTable = response.text || '';
  if (!markdownTable.includes('|')) {
    throw new Error('[Step 5] Gemini response does not contain a Markdown table. Check the prompt and model.');
  }

  log('success', `[Step 5] Table 2 generated (${markdownTable.split('\n').length} lines)`);

  const rows = parseMarkdownTable(markdownTable);
  log('info', `[Step 5] Parsed ${rows.length} rows from Table 2`);

  return { rows, markdownTable };
}

