import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { stubModel } from '../agent/llm.ts'
import { App } from './app.tsx'
import { parts } from './parts.ts'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App parts={parts(stubModel())} />
  </StrictMode>,
)
