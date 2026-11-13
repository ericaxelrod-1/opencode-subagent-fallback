import { spawn } from "child_process";

const unit = "The opencode subagent fallback provides transparent resilience. ";
// 35,000 repeats * 64 chars = 2,240,000 chars (~413,500 tokens, exceeding the 400k / 40% compaction point)
const filler = unit.repeat(35000);
const validMessage = "\n\nIn 2 sentences, explain the high-level purpose of the opencode-subagent-fallback plugin.";
const fullPayload = filler + validMessage;

console.log(`Starting run with payload: ${fullPayload.length} chars`);

const proc = spawn("cmd.exe", ["/c", "opencode", "run", "--agent", "developer", "--auto"], {
  stdio: ["pipe", "inherit", "inherit"],
});

proc.stdin.write(fullPayload, "utf8", (err) => {
  if (err) console.error("Write error:", err);
  proc.stdin.end();
});

proc.on("close", (code) => {
  console.log(`Process exited with code ${code}`);
  process.exit(code || 0);
});
