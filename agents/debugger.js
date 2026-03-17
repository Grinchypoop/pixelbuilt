import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Pixel's debugging agent. A Next.js app failed to build. You will receive the plan, the error output, and the current file contents. Identify and fix the issues. Output fixed files using the same ===FILE: path===...===END=== format. Only output files that need to change.`;

async function readAllFiles(dir, baseDir = null) {
  if (!baseDir) baseDir = dir;
  const result = {};
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Skip node_modules and .next
    if (entry.name === 'node_modules' || entry.name === '.next') continue;

    if (entry.isDirectory()) {
      const subFiles = await readAllFiles(fullPath, baseDir);
      Object.assign(result, subFiles);
    } else {
      try {
        result[relativePath] = await fs.readFile(fullPath, 'utf-8');
      } catch {
        // skip unreadable files
      }
    }
  }
  return result;
}

function parseFiles(text) {
  const files = [];
  const regex = /===FILE: (.+?)===\n([\s\S]*?)===END===/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1].trim(), content: match[2] });
  }
  return files;
}

export async function debuggerAgent(plan, workDir, buildError, emit) {
  emit({ type: 'agent_start', agent: 'viper' });
  emit({ type: 'agent_log', agent: 'viper', text: 'Reading current files...\n' });

  let fullResponse = '';

  try {
    const currentFiles = await readAllFiles(workDir);
    const fileContext = Object.entries(currentFiles)
      .map(([filePath, content]) => `===FILE: ${filePath}===\n${content}\n===END===`)
      .join('\n\n');

    const userMessage = `Plan:\n${plan}\n\nBuild Error:\n${buildError}\n\nCurrent Files:\n${fileContext}\n\nPlease fix the issues and output the corrected files.`;

    emit({ type: 'agent_log', agent: 'viper', text: 'Sending to debugger agent...\n' });

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta'
      ) {
        fullResponse += chunk.delta.text;
        emit({ type: 'agent_log', agent: 'viper', text: chunk.delta.text });
      }
    }

    // Parse and overwrite fixed files
    const files = parseFiles(fullResponse);
    emit({ type: 'agent_log', agent: 'viper', text: `\nApplying ${files.length} fixed file(s)...\n` });

    for (const file of files) {
      const filePath = path.join(workDir, file.path);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, file.content, 'utf-8');
      emit({ type: 'file_written', agent: 'viper', file: file.path });
    }

    emit({ type: 'agent_complete', agent: 'viper', success: true });
    return { success: true };
  } catch (err) {
    console.error('Debugger agent error:', err);
    emit({ type: 'agent_complete', agent: 'viper', success: false, error: err.message });
    return { success: false, error: err.message };
  }
}
