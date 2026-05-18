export const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? 'claude') as 'claude' | 'openai' | 'grok'

export const LLM_MODEL: Record<typeof LLM_PROVIDER, string> = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  grok:   'grok-3',
}
