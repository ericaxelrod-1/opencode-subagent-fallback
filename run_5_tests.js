import { spawnSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const logPath = join(homedir(), ".local", "share", "opencode", "log", "fallback.log");
const prompt = "Use your smart_task tool to delegate to subagent_type 'developer' with description 'math test' and prompt 'What is 13 * 17? Return only the number.'. You must use the smart_task tool.";

const results = [];

for (let i = 1; i <= 5; i++) {
  console.log(`\n=== STARTING RUN ${i}/5 ===`);
  const startOffset = statSync(logPath).size;
  const startedAt = Date.now();

  const proc = spawnSync("cmd.exe", ["/c", "opencode", "run", "--agent", "developer", "--auto", prompt], {
    input: "",
    encoding: "utf8",
    timeout: 300000,
  });

  const durationMs = Date.now() - startedAt;
  const endOffset = statSync(logPath).size;

  let newLogs = "";
  if (endOffset > startOffset) {
    const fd = readFileSync(logPath, "utf8");
    newLogs = fd.slice(startOffset);
  }

  const stdout = proc.stdout ? proc.stdout.trim() : "";
  const stderr = proc.stderr ? proc.stderr.trim() : "";
  const exitCode = proc.status;

  // Extract serving model from interceptor log or smart_task log
  let servingModel = "unknown";
  const interceptorMatches = [...newLogs.matchAll(/in-stream fallback to ([^\s]+) succeeded/g)];
  if (interceptorMatches.length > 0) {
    servingModel = interceptorMatches[interceptorMatches.length - 1][1];
  } else if (newLogs.includes("minimax-m3.1-flash:free succeeded")) {
    servingModel = "unorouter-custom/minimax-m3.1-flash:free";
  }

  const success = exitCode === 0 && (stdout.includes("221") || stderr.includes("221"));

  const record = {
    run: i,
    exitCode,
    success,
    durationMs,
    servingModel,
    stdoutSample: stdout.split("\n").slice(-4).join(" | "),
  };
  results.push(record);

  console.log(`RUN ${i} FINISHED: exitCode=${exitCode}, success=${success}, model=${servingModel}, duration=${Math.round(durationMs/1000)}s`);
  console.log(`STDOUT: ${record.stdoutSample}`);
}

console.log("\n=== FINAL RESULTS SUMMARY ===");
console.table(results);
