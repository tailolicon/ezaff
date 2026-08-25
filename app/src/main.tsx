import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// Self-hosted Be Vietnam Pro (mockup typeface). Bundled locally so the app
// works offline and satisfies the renderer CSP (default-src 'self').
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import '@fontsource/be-vietnam-pro/600.css'
import '@fontsource/be-vietnam-pro/700.css'
import './styles/global.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Không tìm thấy phần tử #root')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
