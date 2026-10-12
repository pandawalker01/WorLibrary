import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  let reloadForUpdate = false
  const announceUpdate = () => window.dispatchEvent(new Event('worlibrary:update-ready'))

  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((registration) => {
    if (registration.waiting) announceUpdate()
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) announceUpdate()
      })
    })
    window.addEventListener('online', () => { void registration.update() })
  }).catch(() => {})

  window.addEventListener('worlibrary:activate-update', () => {
    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration?.waiting) {
        reloadForUpdate = true
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      }
    })
  })
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
