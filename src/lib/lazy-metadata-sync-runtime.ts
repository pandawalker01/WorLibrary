import type { MetadataSyncRuntime, MetadataSyncRuntimeDependencies } from './metadata-sync-runtime'

/** Defer the cloud coordinator until a stable account actually needs it. */
export function createLazyMetadataSyncRuntime(
  dependencies: MetadataSyncRuntimeDependencies = {},
  load: () => Promise<{ createMetadataSyncRuntime: typeof import('./metadata-sync-runtime').createMetadataSyncRuntime }> = () => import('./metadata-sync-runtime'),
): MetadataSyncRuntime {
  let runtime: MetadataSyncRuntime | undefined
  let loading: Promise<MetadataSyncRuntime> | undefined
  let epoch = 0
  const generations = new Map<string, number>()
  return {
    async run(session) {
      if (!session || session.user.isAnonymous || !session.user.id.trim()) return { status: 'no-stable-account' }
      const userId = session.user.id
      const startEpoch = epoch
      const generation = generations.get(userId) ?? 0
      if (!loading) {
        loading = load().then((module) => {
          runtime = module.createMetadataSyncRuntime(dependencies)
          return runtime
        }).catch((error) => { loading = undefined; throw error })
      }
      const loaded = await loading
      if (startEpoch !== epoch || generation !== (generations.get(userId) ?? 0)) return { status: 'invalidated' }
      return loaded.run(session)
    },
    invalidate(userId) {
      if (userId) generations.set(userId, (generations.get(userId) ?? 0) + 1)
      else epoch += 1
      runtime?.invalidate(userId)
    },
  }
}
