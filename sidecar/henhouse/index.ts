// The henhouse module (P6, kip#77): skill manifests, mounts, hostcalls, and the
// capability-limited executor that replaces `scripts/lib/skills.js`'s
// unsandboxed `execFile`.

export {
  BUILTIN_SKILLS_DIR,
  DEFAULT_LIMITS,
  KNOWN_HOSTCALLS,
  LIMIT_CAPS,
  MOUNT_NAMES,
  NAME_RE,
  describeSkills,
  discoverSkills,
  loadSkillPolicy,
  parseLimits,
  parseManifestData,
  parseMemMb,
  parseMounts,
  parseNetwork,
  parseOutputBytes,
  parseWallMs,
  readSkillManifest
} from './manifest.ts'
export type {
  ApprovalState,
  DiscoveredSkill,
  MountMode,
  MountName,
  MountSpec,
  NetworkMode,
  NetworkPolicy,
  SkillLimits,
  SkillManifest,
  SkillParameter,
  SkillSource
} from './manifest.ts'

export {
  MOUNT_ESCAPE,
  MountEscapeError,
  createRunMounts,
  isInside,
  materializeSnapshot,
  resolveMountPath
} from './mounts.ts'
export type { RunMounts, SkillSnapshot, SnapshotEntry } from './mounts.ts'

export {
  CapabilityError,
  HOSTCALL_ERRORS,
  HOSTCALL_NAMES,
  hostAllowed,
  invokeHostcall
} from './hostcalls.ts'
export type {
  HostcallContext,
  HostcallErrorCode,
  HostcallName,
  InternalActionFn,
  InternalActionRequest,
  LlmCompleteFn,
  LlmCompleteRequest,
  LlmCompleteResult,
  ReadVaultFileRequest,
  ReadVaultFileResult,
  WebSearchFn,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult
} from './hostcalls.ts'

export { createSkillExecutor } from './executor.ts'
export type {
  SkillBackend,
  SkillExecutor,
  SkillExecutorOptions,
  SkillRunReason,
  SkillRunRequest,
  SkillRunResult
} from './executor.ts'

export { createSkillTool, formatSkillResult, skillParametersSchema } from './tools.ts'
export type { SkillToolDeps } from './tools.ts'

export { MIGRATED_BUILTIN_SKILLS, createBuiltinSkillTools } from './skills.ts'
export type { BuiltinSkillToolsDeps } from './skills.ts'
