import { gateway } from '../server/ai-gateway.mjs'

export default function explain(request) {
  return gateway(request)
}
