import fs from 'fs';
import path from 'path';
import os from 'os';
import { coderAgent } from './agents/coder.js';
import { debuggerAgent } from './agents/debugger.js';
import { deployerAgent } from './agents/deployer.js';

const MAX_DEBUG_RETRIES = 3;

export async function runPipeline(plan, sessionId, emit) {
  const baseDir = process.env.PIXEL_WORK_DIR || path.join(os.tmpdir(), '.pixel-work');
  const workDir = path.join(baseDir, sessionId);

  // Create working directory
  fs.mkdirSync(workDir, { recursive: true });
  emit({ type: 'agent_log', agent: 'orchestrator', text: `Working directory: ${workDir}\n` });

  let coderResult = await coderAgent(plan, workDir, emit);

  if (!coderResult.success) {
    // Attempt debug + rebuild cycle
    let debugAttempt = 0;
    let fixed = false;

    while (debugAttempt < MAX_DEBUG_RETRIES && !fixed) {
      debugAttempt++;
      emit({
        type: 'agent_log',
        agent: 'orchestrator',
        text: `\nDebug attempt ${debugAttempt}/${MAX_DEBUG_RETRIES}...\n`,
      });

      await debuggerAgent(plan, workDir, coderResult.error || coderResult.buildOutput, emit);

      // Retry the build step (npm run build) after debugger fixes files
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      emit({ type: 'agent_log', agent: 'orchestrator', text: '\nRetrying npm run build...\n' });

      try {
        const { stdout, stderr } = await execAsync('npm run build', {
          cwd: workDir,
          timeout: 180000,
        });
        const buildOutput = stdout + '\n' + stderr;
        emit({ type: 'agent_log', agent: 'orchestrator', text: buildOutput });
        fixed = true;
        coderResult = { success: true, buildOutput };
      } catch (buildErr) {
        const buildOutput =
          (buildErr.stdout || '') + '\n' + (buildErr.stderr || '') + '\n' + buildErr.message;
        emit({ type: 'agent_log', agent: 'orchestrator', text: `Build still failing:\n${buildOutput}\n` });
        coderResult = { success: false, buildOutput, error: buildOutput };
      }
    }

    if (!coderResult.success) {
      emit({
        type: 'pipeline_error',
        error: `Build failed after ${MAX_DEBUG_RETRIES} debug attempts. Last error:\n${coderResult.error || coderResult.buildOutput}`,
      });
      return;
    }
  }

  // Extract subdomain from plan
  const subdomainMatch = plan.match(/<subdomain>([\w-]+)<\/subdomain>/i);
  const subdomain = subdomainMatch ? subdomainMatch[1].toLowerCase() : null;

  // Deploy
  await deployerAgent(workDir, sessionId, subdomain, emit);
}
