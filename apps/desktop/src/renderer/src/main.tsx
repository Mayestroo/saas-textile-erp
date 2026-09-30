import './styles/globals.css'
import './assets/main.css'
import './styles/ui.css'
import './styles/tokens.css'
import './styles/hisob.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
