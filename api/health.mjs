import { gateway } from '../server/ai-gateway.mjs'

// Lightweight liveness/readiness endpoint for deployment probes.
// It intentionally never exposes provider credentials or user data.
export default function health(request) {
  return gateway(request)
}
