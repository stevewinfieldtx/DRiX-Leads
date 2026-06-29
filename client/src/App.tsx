import { Routes, Route, useLocation } from 'react-router'
import { AnimatePresence, motion } from 'framer-motion'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import HowItWorks from './pages/HowItWorks'
import DrixApp from './pages/DrixApp'
import DashboardLogin from './pages/DashboardLogin'
import Dashboard from './pages/Dashboard'
import OpportunityDetail from './pages/OpportunityDetail'

function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  )
}

export default function App() {
  const location = useLocation()
  const isDashboard = location.pathname.startsWith('/dashboard')

  return (
    <div className="min-h-screen bg-drix-bg text-drix-text">
      {!isDashboard && <Navbar />}
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          {/* Main DRiX app */}
          <Route path="/" element={<PageWrapper><Landing /></PageWrapper>} />
          <Route path="/how-it-works" element={<PageWrapper><HowItWorks /></PageWrapper>} />
          <Route path="/app" element={<PageWrapper><DrixApp /></PageWrapper>} />
          {/* Vendor Dashboard */}
          <Route path="/dashboard/login" element={<PageWrapper><DashboardLogin /></PageWrapper>} />
          <Route path="/dashboard" element={<PageWrapper><Dashboard /></PageWrapper>} />
          <Route path="/dashboard/opp/:id" element={<PageWrapper><OpportunityDetail /></PageWrapper>} />
        </Routes>
      </AnimatePresence>
    </div>
  )
}
