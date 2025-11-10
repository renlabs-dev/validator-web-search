import OpenAI from "openai";
import { env } from "../env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

interface ModelConfig {
  name: string;
}

export const MODELS: Record<string, ModelConfig> = {
  querier: {
    name: "google/gemini-2.5-flash",
  },
  validator: {
    name: "google/gemini-2.5-flash",
  },
};

/**
 * Create a stateful chat function for OpenRouter
 * Maintains conversation history across multiple calls
 */
export function createChat(modelKey: keyof typeof MODELS) {
  const model = MODELS[modelKey];
  if (!model) {
    throw new Error(`Model ${modelKey} not found in MODELS`);
  }
  const messages: ChatMessage[] = [];

  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/renlabs-dev/validator",
      "X-Title": "Torus Validator",
    },
  });

  return async function chat(
    userMessage: string,
    options: {
      system?: string;
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<ChatResponse> {
    const { system, temperature = 0.7, maxTokens = 2048 } = options;

    // Add system message only if provided and not already in history
    if (system && messages.length === 0) {
      messages.push({ role: "system", content: system });
    }

    // Add user message
    messages.push({ role: "user", content: userMessage });

    try {
      const response = await client.chat.completions.create({
        model: model.name,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        temperature,
        max_tokens: maxTokens,
      });

      const choice = response.choices[0];
      if (!choice || !choice.message.content) {
        throw new Error("No response from model");
      }

      const assistantMessage = choice.message.content;
      messages.push({ role: "assistant", content: assistantMessage });

      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;

      return {
        content: assistantMessage,
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      console.error("OpenRouter API error:", error);
      throw error;
    }
  };
}

/**
 * One-shot LLM call without maintaining history
 */
export async function oneShot(
  modelKey: keyof typeof MODELS,
  userMessage: string,
  options: {
    system?: string;
    temperature?: number;
    maxTokens?: number;
  } = {},
): Promise<ChatResponse> {
  const chat = createChat(modelKey);
  return await chat(userMessage, options);
}
