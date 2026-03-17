import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Pixel's coding agent. You will receive a plan for a Next.js + Tailwind app. Write all the necessary files to implement it. For each file, output it in this exact format:

===FILE: path/to/file===
<file contents here>
===END===

Start by creating: package.json (with next, react, react-dom, tailwindcss), tailwind.config.js, next.config.js, app/layout.tsx, app/page.tsx, and any other needed pages/components. Make the app fully functional and beautiful. Use Tailwind for all styling.

IMPORTANT: Always include this in next.config.js to allow the app to be embedded in iframes:
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Content-Security-Policy', value: "frame-ancestors *" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;`;

function parseFiles(text) {
  const files = [];
  const regex = /===FILE: (.+?)===\n([\s\S]*?)===END===/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1].trim(), content: match[2] });
  }
  return files;
}

export async function coderAgent(plan, workDir, emit) {
  emit({ type: 'agent_start', agent: 'cipher' });

  let fullResponse = '';
  const writtenFiles = new Set();

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is the plan for the app to build:\n\n${plan}\n\nPlease write all the necessary files now.`,
        },
      ],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta'
      ) {
        fullResponse += chunk.delta.text;
        emit({ type: 'agent_log', agent: 'cipher', text: chunk.delta.text });
      }
    }

    // Parse and write files
    const files = parseFiles(fullResponse);
    emit({ type: 'agent_log', agent: 'cipher', text: `\nParsed ${files.length} files from response.\n` });

    for (const file of files) {
      const filePath = path.join(workDir, file.path);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, file.content, 'utf-8');

      if (!writtenFiles.has(file.path)) {
        writtenFiles.add(file.path);
        emit({ type: 'file_written', agent: 'cipher', file: file.path });
      }
    }

    if (files.length === 0) {
      throw new Error('No files were parsed from coder response');
    }

    // Run npm install
    emit({ type: 'agent_log', agent: 'cipher', text: '\nRunning npm install...\n' });
    try {
      const { stdout: installOut, stderr: installErr } = await execAsync('npm install', {
        cwd: workDir,
        timeout: 120000,
      });
      emit({ type: 'agent_log', agent: 'cipher', text: installOut || installErr || 'npm install complete.\n' });
    } catch (installErr) {
      emit({ type: 'agent_log', agent: 'cipher', text: `npm install error: ${installErr.message}\n` });
      throw installErr;
    }

    // Run npm run build
    emit({ type: 'agent_log', agent: 'cipher', text: '\nRunning npm run build...\n' });
    let buildOutput = '';
    try {
      const { stdout, stderr } = await execAsync('npm run build', {
        cwd: workDir,
        timeout: 180000,
      });
      buildOutput = stdout + '\n' + stderr;
      emit({ type: 'agent_log', agent: 'cipher', text: buildOutput });
    } catch (buildErr) {
      buildOutput = buildErr.stdout + '\n' + buildErr.stderr + '\n' + buildErr.message;
      emit({ type: 'agent_log', agent: 'cipher', text: `Build failed:\n${buildOutput}\n` });
      emit({ type: 'agent_complete', agent: 'cipher', success: false, error: buildOutput });
      return { success: false, buildOutput, error: buildOutput };
    }

    emit({ type: 'agent_complete', agent: 'cipher', success: true });
    return { success: true, buildOutput };
  } catch (err) {
    console.error('Coder agent error:', err);
    emit({ type: 'agent_complete', agent: 'cipher', success: false, error: err.message });
    return { success: false, buildOutput: '', error: err.message };
  }
}
