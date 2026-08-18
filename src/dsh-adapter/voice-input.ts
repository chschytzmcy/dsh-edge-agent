/**
 * voice-input — optional voice input channel. Wraps Whisper-tiny (or
 * equivalent). Streams PCM in, emits text out, and feeds the result
 * into the prompt-guard pipeline before landing in the agent inbox.
 *
 * @module dsh-edge-agent/voice-input
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'voice-input'

export const inject = ['sessions', 'auditLog'] as const

export interface Config {
  modelPath: string
  /** VAD silence threshold in seconds. */
  vadSilenceThreshold: number
  /** Sample rate. */
  sampleRate: number
}

export const Config: Schema<Config> = Schema.object({
  modelPath: Schema.string().required(),
  vadSilenceThreshold: Schema.number().default(0.6),
  sampleRate: Schema.natural().default(16000),
})

export interface VoiceInputService {
  transcribe(audio: Uint8Array): Promise<string>
  transcribeStream(stream: AsyncIterable<Uint8Array>): Promise<string>
}

export class VoiceInputServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'voiceInput')
  }
  async transcribe(audio: Uint8Array): Promise<string> {
    void audio
    return ''
  }
  async transcribeStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
    void stream
    return ''
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(VoiceInputServiceImpl)
  void config
  return async () => {}
}
