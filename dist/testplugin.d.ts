import { z } from "zod";
declare const p: (input: any) => Promise<{
    tool: {
        smart_task: {
            description: string;
            args: {
                description: z.ZodString;
                prompt: z.ZodString;
                subagent_type: z.ZodString;
                task_id: z.ZodOptional<z.ZodString>;
            };
            execute(args: {
                description: string;
                prompt: string;
                subagent_type: string;
                task_id?: string | undefined;
            }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
        };
    };
}>;
export default p;
