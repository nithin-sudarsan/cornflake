// All LLM calls in the Electron client are proxied through the cornflake-api
// backend (see ../api-client and llm/extraction.ts). No provider API keys are
// read or instantiated client-side. The type re-export below is kept so other
// modules can still reference the LLMProvider interface for typing.

export type { LLMProvider } from './provider.js'
