import { createAiGateway } from '../server/ai-gateway.mjs'

// Vercel injects deployment configuration through process.env. Keep this
// adapter at the API boundary so the shared gateway stays independently
// testable in other runtimes, while every serverless route sees the same
// configured instance and in-memory request cache for its warm invocation.
export function createRuntimeGateway(env = process.env) {
  return createAiGateway({ env })
}

export const gateway = createRuntimeGateway()
