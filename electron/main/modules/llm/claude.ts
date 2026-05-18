import { httpsPost } from './utils.js'
import { LLM_MODEL } from '../../llm.config.js'
import type { LLMProvider } from './provider.js'

export class ClaudeProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async complete(prompt: string, systemPrompt: string): Promise<string> {
    const body = {
      model: LLM_MODEL.claude,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }

    const raw = await httpsPost(
      'api.anthropic.com',
      '/v1/messages',
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    )

    const parsed = JSON.parse(raw) as {
      content?: Array<{ type: string; text: string }>
      error?: { message: string }
    }

    if (parsed.error) throw new Error(`Anthropic API error: ${parsed.error.message}`)

    const textBlock = parsed.content?.find(b => b.type === 'text')
    if (!textBlock?.text) throw new Error('Anthropic API returned no text content')

    return textBlock.text
  }
}
