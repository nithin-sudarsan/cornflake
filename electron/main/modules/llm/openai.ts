import { httpsPost } from './utils.js'
import { LLM_MODEL } from '../../llm.config.js'
import type { LLMProvider } from './provider.js'

export class OpenAIProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async complete(prompt: string, systemPrompt: string): Promise<string> {
    const body = {
      model: LLM_MODEL.openai,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }

    const raw = await httpsPost(
      'api.openai.com',
      '/v1/chat/completions',
      { Authorization: `Bearer ${this.apiKey}` },
      body,
    )

    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message: { content: string } }>
      error?: { message: string }
    }

    if (parsed.error) throw new Error(`OpenAI API error: ${parsed.error.message}`)

    const content = parsed.choices?.[0]?.message?.content
    if (!content) throw new Error('OpenAI API returned no content')

    return content
  }
}
