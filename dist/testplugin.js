import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
const p = async (input) => ({
    tool: {
        smart_task: tool({
            description: "d",
            args: {
                description: z.string().describe("A short (3-5 words) description of the task"),
                prompt: z.string().describe("The task for the agent to perform"),
                subagent_type: z.string().describe("The type of specialized agent to use"),
                task_id: z.string().optional().describe("Resume a previous task by ID"),
            },
            execute: async (args, context) => ({ title: "t", output: "o" })
        })
    }
});
export default p;
