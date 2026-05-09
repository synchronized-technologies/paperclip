import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRealizationRequest } from "./types.js";
import type { GitRunner } from "./git-runner.js";

export interface GitCloneDeps {
  git: GitRunner;
  getGitCredentials(): Promise<{ username: string; password: string }>;
}

export async function executeProjectPrimaryClone(
  request: WorkspaceRealizationRequest,
  root: string,
  deps: GitCloneDeps,
): Promise<void> {
  const { repoUrl, repoRef } = request.source;
  if (!repoUrl) {
    throw new Error(
      "executeWorkspaceStrategy: repoUrl is required for project_primary strategy",
    );
  }
  const ref = repoRef ?? "HEAD";

  const creds = await deps.getGitCredentials();
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_USERNAME: creds.username,
    GIT_PASSWORD: creds.password,
  };

  const isWarm = existsSync(join(root, ".git"));
  if (!isWarm) {
    const url = injectCreds(repoUrl, creds);
    const r = await deps.git.run("git", ["clone", "--branch", ref, url, "."], {
      cwd: root,
      env,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git clone failed (${r.exitCode}): ${r.stderr}`);
    }
    return;
  }

  const fetched = await deps.git.run("git", ["fetch", "origin", ref], { cwd: root, env });
  if (fetched.exitCode !== 0) {
    throw new Error(`git fetch failed (${fetched.exitCode}): ${fetched.stderr}`);
  }
  const reset = await deps.git.run("git", ["reset", "--hard", `origin/${ref}`], {
    cwd: root,
    env,
  });
  if (reset.exitCode !== 0) {
    throw new Error(`git reset --hard origin/${ref} failed: ${reset.stderr}`);
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
