import { gateway } from './gateway.mjs'

export default function translate(request) {
  return gateway(request)
}
