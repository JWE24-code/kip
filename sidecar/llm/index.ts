// The sidecar's LLM surface (P7, kip#79): BYOK provider client + optional
// managed-backend usage reporting. Import from here rather than the pieces.

export {
  DEFAULT_ANTHROPIC_MODEL,
  callLLM,
  clearLearnedJsonMode,
  createLLMCompleter,
  isReasoningModel,
  phaseOf,
  testConnection
} from './client.ts'
export type {
  AnthropicClient,
  AnthropicClientCtor,
  ArenaRequest,
  CallOptions,
  CompleteRequest,
  CompleteResult,
  CompleterOptions,
  TestConnectionCandidate,
  Usage
} from './client.ts'

export {
  KIP_BASE_URL_DEFAULT,
  listProviders,
  loadLLMConfig,
  missingRequiredField,
  providerInfo,
  resolveActive,
  resolveConfig,
  saveLLMConfig
} from './config.ts'
export type {
  ActiveProvider,
  LLMFileConfig,
  ProviderConfig,
  ProviderField,
  ProviderId,
  ProviderInfo
} from './config.ts'

export { createUsageReporter } from './usage.ts'
export type { CallUsageReport, UsageReporter, UsageReporterOptions } from './usage.ts'
