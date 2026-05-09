import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRealizationRequest } from "./types.js";
import type { GitRunner } from "./git-runner.js";

export interface GitWorktreeDeps {
  git: GitRunner;
  getGitCredentials(): Promise<{ username: string; password: string }>;
}

export async function executeGitWorktree(
  request: WorkspaceRealizationRequest,
  root: string,
  deps: GitWorktreeDeps,
): Promise<void> {
  const { repoUrl, repoRef, worktreePath } = request.source;
  if (!repoUrl) {
    throw new Error(
      "executeWorkspaceStrategy: repoUrl is required for git_worktree strategy",
    );
  }
  const ref = repoRef ?? "HEAD";
  const worktreeName = worktreePath ?? "default";

  const creds = await deps.getGitCredentials();
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_USERNAME: creds.username,
    GIT_PASSWORD: creds.password,
  };
  const bareDir = join(root, ".bare");
  const worktreeDir = join(root, worktreeName);

  if (!existsSync(bareDir)) {
    const url = injectCreds(repoUrl, creds);
    const r = await deps.git.run("git", ["clone", "--bare", url, bareDir], { env });
    if (r.exitCode !== 0) {
      throw new Error(`git clone --bare failed: ${r.stderr}`);
    }
  } else {
    const r = await deps.git.run("git", ["fetch", "origin"], { cwd: bareDir, env });
    if (r.exitCode !== 0) {
      throw new Error(`git fetch failed: ${r.stderr}`);
    }
  }

  if (!existsSync(worktreeDir)) {
    const r = await deps.git.run("git", ["worktree", "add", "-f", worktreeDir, ref], {
      cwd: bareDir,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${r.stderr}`);
    }
  } else {
    const r = await deps.git.run("git", ["reset", "--hard", `origin/${ref}`], {
      cwd: worktreeDir,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git reset --hard failed: ${r.stderr}`);
    }
  }
}

function injectCreds(
  url: string,
  creds: { username: string; password: string },
): string {
  if (!url.startsWith("https://")) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(creds.username);
  u.password = encodeURIComponent(creds.password);
  return u.toString();
}
