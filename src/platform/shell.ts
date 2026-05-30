import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runFile(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function runFileWithInput(
  file: string,
  args: string[],
  input: string,
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
      } else {
        reject(new Error(`${file} exited with code ${code}: ${stderr.trim()}`));
      }
    });

    child.stdin.end(input);
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await runFile("command", ["-v", command]);
    return true;
  } catch {
    try {
      await runFile("which", [command]);
      return true;
    } catch {
      return false;
    }
  }
}
