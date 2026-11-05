#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const argv = process.argv.slice(2);
const flag = argv.indexOf("--deployment");
const deployment = flag >= 0 ? argv[flag + 1] : undefined;
if (deployment) process.loadEnvFile(resolve(REPO_ROOT, "deployments", deployment, ".env"));

process.exitCode = await run(argv, {
  env: process.env,
  fetch,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  confirm: async (question) => {
    if (!process.stdin.isTTY) return null;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(question);
    prompt.close();
    return answer.trim().toLowerCase() === "send";
  },
});
