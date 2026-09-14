// The only place the sidecar touches scripts/lib/llm.js. Keeping the adapter
// here means the loop speaks one tiny CompleteFn interface and the tests can
// substitute a scripted completer without an API key or network. Real
// retrieval / BYOK / managed-backend routing stays in lib/llm.js for now
// (kip#79 moves it), exactly as the skeleton issue scopes it.

import { createRequire } from 'node:module'
import type { CompleteFn, CompleteResult, Usage } from './session/turn.ts'

const require = createRequire(import.meta.url)
const { callLLM } = require('../scripts/lib/llm.js') as {
  callLLM: (
    request: {
      system: string
      prompt: string
      maxTokens?: number
      label?: string
      onStream?: ((text: string) => void) | null
    },
    overrides?: { signal?: AbortSignal, vaultRoot?: string }
  ) => Promise<{ text?: string, raw?: unknown }>
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
}

function usageFromRaw (raw: unknown): Usage {
  const usage = (raw && typeof raw === 'object' ? (raw as { usage?: RawUsage }).usage : null) ?? {}
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0
  }
}

export function createLLMCompleter (vaultRoot?: string): CompleteFn {
  return async ({ system, prompt, onDelta, signal, label }) => {
    const result = await callLLM(
      { system, prompt, maxTokens: 4096, label: label ?? 'sidecar:turn', onStream: onDelta ?? null },
      { signal, vaultRoot }
    )
    return { text: result.text ?? '', usage: usageFromRaw(result.raw) } satisfies CompleteResult
  }
}
