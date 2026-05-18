import { httpsPost } from './utils.js'
import { LLM_MODEL } from '../../llm.config.js'
import type { LLMProvider } from './provider.js'

export class GrokProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async complete(prompt: string, systemPrompt: string): Promise<string> {
    const body = {
      model: LLM_MODEL.grok,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }

    const raw = await httpsPost(
      'api.x.ai',
      '/v1/chat/completions',
      { Authorization: `Bearer ${this.apiKey}` },
      body,
    )

    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message: { content: string } }>
      error?: { message: string }
    }

    if (parsed.error) throw new Error(`Grok API error: ${parsed.error.message}`)

    const content = parsed.choices?.[0]?.message?.content
    if (!content) throw new Error('Grok API returned no content')

    return content
  }
}
