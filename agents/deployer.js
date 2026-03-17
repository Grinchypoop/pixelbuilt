import fs from 'fs/promises';
import path from 'path';

const VERCEL_API = 'https://api.vercel.com';
const GITHUB_API = 'https://api.github.com';
const GITHUB_ORG = 'pixelbuilder-bit';

async function readAllFilesForDeploy(dir, baseDir = null) {
  if (!baseDir) baseDir = dir;
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.name === 'node_modules' || entry.name === '.next') continue;

    if (entry.isDirectory()) {
      const subFiles = await readAllFilesForDeploy(fullPath, baseDir);
      result.push(...subFiles);
    } else {
      try {
        const content = await fs.readFile(fullPath);
        result.push({
          file: relativePath,
          data: content.toString('base64'),
          encoding: 'base64',
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return result;
}

async function pushToGitHub(files, repoName, githubToken, emit) {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Create repo under the org/user
  emit({ type: 'agent_log', agent: 'deployer', text: `Creating GitHub repo ${GITHUB_ORG}/${repoName}...\n` });
  const createRes = await fetch(`${GITHUB_API}/orgs/${GITHUB_ORG}/repos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: repoName, private: false, auto_init: false }),
  });

  // Fall back to user repos if org fails (e.g. it's a personal account)
  if (!createRes.ok) {
    const userCreateRes = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: repoName, private: false, auto_init: false }),
    });
    if (!userCreateRes.ok) {
      const err = await userCreateRes.text();
      throw new Error(`GitHub repo creation failed: ${userCreateRes.status} ${err}`);
    }
  }

  emit({ type: 'agent_log', agent: 'deployer', text: `Pushing ${files.length} files to GitHub...\n` });

  // Create blobs for each file
  const treeItems = [];
  for (const f of files) {
    const blobRes = await fetch(`${GITHUB_API}/repos/${GITHUB_ORG}/${repoName}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: f.data, encoding: 'base64' }),
    });
    if (!blobRes.ok) continue;
    const blob = await blobRes.json();
    treeItems.push({ path: f.file, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create tree
  const treeRes = await fetch(`${GITHUB_API}/repos/${GITHUB_ORG}/${repoName}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tree: treeItems }),
  });
  if (!treeRes.ok) throw new Error(`GitHub tree creation failed: ${treeRes.status}`);
  const tree = await treeRes.json();

  // Create commit
  const commitRes = await fetch(`${GITHUB_API}/repos/${GITHUB_ORG}/${repoName}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Initial commit from Pixel', tree: tree.sha }),
  });
  if (!commitRes.ok) throw new Error(`GitHub commit creation failed: ${commitRes.status}`);
  const commit = await commitRes.json();

  // Set main branch ref
  await fetch(`${GITHUB_API}/repos/${GITHUB_ORG}/${repoName}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
  });

  emit({ type: 'agent_log', agent: 'deployer', text: `GitHub: https://github.com/${GITHUB_ORG}/${repoName}\n` });
  return `https://github.com/${GITHUB_ORG}/${repoName}`;
}

async function pollDeployment(deploymentId, token, emit) {
  const maxAttempts = 60;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    await new Promise((r) => setTimeout(r, 5000));

    const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to poll deployment: ${res.status} ${text}`);
    }

    const data = await res.json();
    emit({ type: 'agent_log', agent: 'deployer', text: `Deployment status: ${data.readyState} (attempt ${attempt})\n` });

    if (data.readyState === 'READY') {
      return `https://${data.url}`;
    } else if (data.readyState === 'ERROR' || data.readyState === 'CANCELED') {
      throw new Error(`Deployment failed with state: ${data.readyState}`);
    }
  }

  throw new Error('Deployment timed out after 5 minutes');
}

export async function deployerAgent(workDir, sessionId, emit) {
  emit({ type: 'agent_start', agent: 'deployer' });

  const vercelToken = process.env.VERCEL_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;

  try {
    emit({ type: 'agent_log', agent: 'deployer', text: 'Reading project files...\n' });
    const files = await readAllFilesForDeploy(workDir);
    const projectName = `pixel-app-${sessionId.slice(0, 8)}`;

    // Push to GitHub if token is set
    if (githubToken) {
      try {
        await pushToGitHub(files, projectName, githubToken, emit);
      } catch (ghErr) {
        emit({ type: 'agent_log', agent: 'deployer', text: `GitHub push failed (continuing): ${ghErr.message}\n` });
      }
    } else {
      emit({ type: 'agent_log', agent: 'deployer', text: 'No GITHUB_TOKEN set, skipping GitHub push.\n' });
    }

    // Deploy to Vercel
    if (!vercelToken) {
      emit({ type: 'agent_log', agent: 'deployer', text: 'No VERCEL_TOKEN set. Skipping deployment.\n' });
      emit({ type: 'pipeline_error', error: 'VERCEL_TOKEN not configured. Set it in your .env file to enable deployment.' });
      return { success: false, error: 'VERCEL_TOKEN not set' };
    }

    emit({ type: 'agent_log', agent: 'deployer', text: `Uploading ${files.length} files to Vercel...\n` });

    const deployRes = await fetch(`${VERCEL_API}/v13/deployments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        files,
        projectSettings: { framework: 'nextjs' },
        target: 'production',
      }),
    });

    if (!deployRes.ok) {
      const errText = await deployRes.text();
      throw new Error(`Vercel API error: ${deployRes.status} ${errText}`);
    }

    const deployData = await deployRes.json();
    emit({ type: 'agent_log', agent: 'deployer', text: `Deployment created: ${deployData.id}\nPolling for ready state...\n` });

    const deployUrl = await pollDeployment(deployData.id, vercelToken, emit);
    emit({ type: 'agent_log', agent: 'deployer', text: `Deployed successfully: ${deployUrl}\n` });
    emit({ type: 'pipeline_complete', deployUrl });

    return { success: true, deployUrl };
  } catch (err) {
    console.error('Deployer error:', err);
    emit({ type: 'agent_log', agent: 'deployer', text: `Deployment error: ${err.message}\n` });
    emit({ type: 'pipeline_error', error: err.message });
    return { success: false, error: err.message };
  }
}
