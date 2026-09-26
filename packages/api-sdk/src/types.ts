/** Public types — mirror the OpenAI shapes the platform speaks, plus the
 *  rovecode-specific catalog fields (engine, credits, image sizes...). */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  stop?: string | string[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: Role; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: Role; content?: string | null; reasoning_content?: string; tool_calls?: ToolCall[] };
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

export type ModelType = "text" | "image" | "video" | "vision" | "special";

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  type?: ModelType;
  name?: string;
  input?: string[];
  supports_tools?: boolean;
  /** image models */
  engine?: string;
  credits?: number;
  supported_sizes?: string[];
  /** video models */
  image_to_video?: boolean;
  supports_audio?: boolean;
  supported_durations?: string[];
  description?: string;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
}

export interface ImageGenerateResponse {
  created: number;
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}

export interface VideoGenerateRequest {
  prompt: string;
  model: string;
  duration?: string;
  image?: string;
}

export interface VideoJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  url?: string;
  error?: string;
}
