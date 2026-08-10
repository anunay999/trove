import { MODEL, OPENAI_API_KEY, OPENAI_BASE_URL } from "./env.js";

/** A tool the agent can call. `run` returns the string shown back to the model. */
export type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
};

export type TranscriptEntry =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_call"; name: string; args: Record<string, unknown> }
  | { role: "tool_result"; name: string; content: string };

export type AgentResult = {
  finalAnswer: string;
  transcript: TranscriptEntry[];
  toolCalls: number;
  /** Names of tools invoked, in order — used by scoring's rederivation heuristic. */
  toolNames: string[];
  tokensIn: number;
  latencyMs: number;
};

const SYSTEM_PROMPT = [
  "You are an agent doing multi-session work for one team over time.",
  "You have MEMORY TOOLS. Use them deliberately:",
  "- Before answering a question that depends on a previously established fact, RETRIEVE it with your read/recall tools instead of guessing or re-deriving it.",
  "- When you are told a new durable fact, SAVE it so a future session can use it.",
  "- When a previously recorded fact has CHANGED, record the change so the old value is marked outdated — do not silently keep both.",
  "- Always respect the most up-to-date fact. Never act on a value you know has been superseded.",
  "Keep final answers short and direct. When asked where a fact came from, name the recorded decision/source.",
].join("\n");

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

async function callOpenAI(
  messages: ChatMessage[],
  tools: AgentTool[],
  toolChoice: "auto" | "none",
): Promise<{ message: { content: string | null; tool_calls?: ToolCall[] }; promptTokens: number }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = toolChoice;
  }

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
    usage?: { prompt_tokens?: number };
  };
  return {
    message: json.choices[0]!.message,
    promptTokens: json.usage?.prompt_tokens ?? 0,
  };
}

/**
 * Run one bounded session. Memory persistence lives in the tools (the arm),
 * not here — this loop only wires the model to the arm's tools for `task`.
 */
export async function runSession(task: string, tools: AgentTool[], maxToolCalls = 6): Promise<AgentResult> {
  const started = Date.now();
  const transcript: TranscriptEntry[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  let tokensIn = 0;
  let toolCalls = 0;
  const toolNames: string[] = [];
  let finalAnswer = "";

  for (let step = 0; step <= maxToolCalls; step += 1) {
    const budgetExhausted = step === maxToolCalls;
    const { message, promptTokens } = await callOpenAI(
      messages,
      tools,
      budgetExhausted ? "none" : "auto",
    );
    tokensIn += promptTokens;

    const calls = message.tool_calls ?? [];
    if (calls.length === 0 || budgetExhausted) {
      finalAnswer = message.content ?? "";
      transcript.push({ role: "assistant", content: finalAnswer });
      break;
    }

    // Record the assistant turn that requested tools, then satisfy every call.
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    if (message.content) transcript.push({ role: "assistant", content: message.content });

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      toolCalls += 1;
      toolNames.push(call.function.name);
      transcript.push({ role: "tool_call", name: call.function.name, args });

      const tool = toolByName.get(call.function.name);
      let result: string;
      if (!tool) {
        result = `Unknown tool: ${call.function.name}`;
      } else {
        try {
          result = await tool.run(args);
        } catch (error) {
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      transcript.push({ role: "tool_result", name: call.function.name, content: result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return {
    finalAnswer,
    transcript,
    toolCalls,
    toolNames,
    tokensIn,
    latencyMs: Date.now() - started,
  };
}
