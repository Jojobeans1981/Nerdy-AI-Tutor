import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode removed: it double-invokes effects in dev, which kills the Simli WebRTC
// handshake mid-connection (CONNECTION TIMED OUT) and wastes ~2s on every page load.
// The app is sufficiently tested; strict-mode warnings are not needed for the demo.
createRoot(document.getElementById('root')!).render(<App />)
