// LLM provider interface — all LLM calls go through this abstraction.
// Implementations live alongside this file; the factory in index.ts reads LLM_PROVIDER env var.

export interface LLMProvider {
  complete(prompt: string, systemPrompt: string): Promise<string>
}
