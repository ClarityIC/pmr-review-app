/**
 * STEP 4: Semantic Synthesis for Table 1 (Medical Chronology)
 *
 * Queries BigQuery Table 0 for all text of this case, then calls
 * Vertex AI Gemini 3.1 Pro with the Table 1 prompt.
 * Parses the Markdown table response into structured rows.
 */
import { getGenAI, getEnv } from '../config.js';
import { getCaseText } from '../bigquery.js';
import { DEFAULT_TABLE1_PROMPT } from './prompts.js';
import { Log } from './orchestrator.js';
import { parseMarkdownTable } from './table-parser.js';

export async function step4(
  caseId: string,
  promptOverride: string | undefined,
  log: Log,
): Promise<{ rows: any[]; markdownTable: string }> {
  log('info', '[Step 4] Querying BigQuery Table 0 for case text');
  const table0Text = await getCaseText(caseId);

  if (!table0Text.trim()) throw new Error('[Step 4] No text found in BigQuery Table 0 for this case. Cannot generate Table 1.');

  const modelName = getEnv('GEMINI_MODEL') || 'gemini-3.1-pro-preview';
  log('info', `[Step 4] Calling Gemini (${modelName}) to generate Table 1`);

  const basePrompt = promptOverride || DEFAULT_TABLE1_PROMPT;
  const prompt = basePrompt.replace('{{TABLE0_TEXT}}', table0Text);

  const genai = getGenAI();
  const response = await genai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: 65536,
      temperature: 0.1,   // low temperature for factual extraction
    },
  });

  const markdownTable = response.text || '';
  if (!markdownTable.includes('|')) {
    throw new Error('[Step 4] Gemini response does not contain a Markdown table. Check the prompt and model.');
  }

  log('success', `[Step 4] Table 1 generated (${markdownTable.split('\n').length} lines)`);

  const rows = parseMarkdownTable(markdownTable);
  log('info', `[Step 4] Parsed ${rows.length} rows from Table 1`);

  return { rows, markdownTable };
}

