import { gateway } from '../server/ai-gateway.mjs'

export default function translate(request) {
  return gateway(request)
}
