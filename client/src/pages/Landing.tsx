import { useRef } from 'react'
import { Link } from 'react-router'
import { motion, useInView, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, Sparkles, Target, TrendingUp, Repeat, Brain, Layers } from 'lucide-react'
import ParticleCanvas from '../components/ParticleCanvas'

function FadeInSection({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {children}
    </motion.div>
  )
}

export default function Landing() {
  const heroRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const heroOpacity = useTransform(scrollYProgress, [0, 0.8], [1, 0])
  const heroScale = useTransform(scrollYProgress, [0, 0.8], [1, 0.95])

  // ── The two promises (what the customer actually gets) ──
  const promises = [
    {
      icon: <TrendingUp className="w-6 h-6" />,
      title: 'More wins, more often',
      desc: 'Not the occasional lucky hit. DRiX puts the right move in front of you on every deal, so good outcomes become the pattern — not the exception.',
    },
    {
      icon: <Target className="w-6 h-6" />,
      title: 'More data, made actionable',
      desc: "We don't hand you a report to read. You get more signal about your buyer turned into the exact next step — written, specific, and ready to use.",
    },
  ]

  // ── Why this beats doing it yourself (addressed subtly, as differentiators) ──
  const edges = [
    {
      icon: <Repeat className="w-6 h-6" />,
      title: 'Consistent, not random',
      desc: 'Ask a chatbot the same thing twice and you get two different answers. DRiX gives you the same answer every time — so you can build a plan on it, not just a one-off reply.',
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: 'Sharper every pass',
      desc: 'A typed prompt is one-and-done. DRiX learns from its own results and improves itself, so the intelligence gets better the more it works your deals.',
    },
    {
      icon: <Layers className="w-6 h-6" />,
      title: 'Sees the whole account',
      desc: 'A prompt answers in a vacuum. DRiX weighs every past touch across your entire company, so nothing about the relationship gets dropped or repeated.',
    },
  ]

  return (
    <div className="relative">
      {/* ─── HERO ─── */}
      <motion.section
        ref={heroRef}
        style={{ opacity: heroOpacity, scale: heroScale }}
        className="relative min-h-screen flex items-center justify-center overflow-hidden"
      >
        {/* Background image with overlay */}
        <div className="absolute inset-0 z-0">
          <img src="/hero-bg.jpg" alt="" className="w-full h-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-drix-bg/60 via-drix-bg/40 to-drix-bg" />
          <div className="absolute inset-0 bg-gradient-to-r from-drix-bg/50 via-transparent to-drix-bg/50" />
        </div>

        <ParticleCanvas />

        <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-24 pb-16">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-drix-accent/10 border border-drix-accent/20 mb-8"
          >
            <Sparkles size={14} className="text-drix-accent" />
            <span className="text-xs font-semibold tracking-widest uppercase text-drix-accent">
              Sales Intelligence, Reimagined
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15 }}
            className="text-5xl sm:text-6xl lg:text-7xl font-black tracking-tight leading-[1.05] mb-6"
          >
            <span className="gradient-text glow-text">More wins.</span>
            <br />
            <span className="text-drix-text">More often.</span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="text-lg sm:text-xl text-drix-dim max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            DRiX turns everything you know about a buyer — and everything you don't —
            into the next move, ready to use. More signal, less guessing, more deals closed.
          </motion.p>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.45 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-14"
          >
            <Link
              to="/app"
              className="group inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all duration-300 hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
            >
              Launch DRiX
              <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link
              to="/how-it-works"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all duration-300"
            >
              See How It Works
            </Link>
          </motion.div>

          {/* Two-promise band (replaces invented stats) */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto"
          >
            <div className="glass rounded-xl px-5 py-4 text-left">
              <div className="text-sm font-bold gradient-text">More wins, more often</div>
              <div className="text-xs text-drix-muted mt-1">Outcomes that repeat — not luck.</div>
            </div>
            <div className="glass rounded-xl px-5 py-4 text-left">
              <div className="text-sm font-bold gradient-text">Data made actionable</div>
              <div className="text-xs text-drix-muted mt-1">The next step, not another report.</div>
            </div>
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10"
        >
          <div className="w-6 h-10 rounded-full border-2 border-drix-border flex items-start justify-center p-2">
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-1 h-2 rounded-full bg-drix-accent"
            />
          </div>
        </motion.div>
      </motion.section>

      {/* ─── WHAT YOU GET ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="text-center mb-16">
              <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-accent mb-4 block">
                What You Get
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-4">
                Two things, every time
              </h2>
              <p className="text-drix-dim max-w-xl mx-auto">
                Everything DRiX does comes back to these.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-2 gap-6">
            {promises.map((p, i) => (
              <FadeInSection key={i} delay={i * 0.15}>
                <div className="group glass rounded-2xl p-8 sm:p-10 hover:border-drix-accent/30 transition-all duration-500 hover:-translate-y-1 h-full">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-accent/15 to-drix-purple/15 text-drix-accent mb-6 group-hover:shadow-glow transition-shadow duration-300">
                    {p.icon}
                  </div>
                  <h3 className="text-xl font-bold text-drix-text mb-3">{p.title}</h3>
                  <p className="text-sm text-drix-dim leading-relaxed">{p.desc}</p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* ─── WHY DRiX (addresses "I could just prompt it myself") ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-drix-accent/[0.02] to-transparent" />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="text-center mb-16">
              <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-purple mb-4 block">
                More Than a Prompt
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-4">
                Anyone can ask AI a question
              </h2>
              <p className="text-drix-dim max-w-xl mx-auto">
                Getting an answer you can build a strategy on is a different thing entirely.
              </p>
            </div>
          </FadeInSection>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {edges.map((e, i) => (
              <FadeInSection key={i} delay={i * 0.1}>
                <div className="group glass rounded-xl p-7 hover:border-drix-accent/20 transition-all duration-300 hover:-translate-y-0.5 h-full">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-drix-accent/10 to-drix-purple/10 flex items-center justify-center mb-4 text-drix-accent group-hover:shadow-glow transition-shadow duration-300">
                    {e.icon}
                  </div>
                  <h3 className="text-base font-bold text-drix-text mb-2">{e.title}</h3>
                  <p className="text-sm text-drix-dim leading-relaxed">{e.desc}</p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA SECTION ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="relative glass rounded-3xl p-10 sm:p-16 text-center overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-drix-accent/5 via-transparent to-drix-purple/5" />
              <div className="relative z-10">
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-6">
                  Win more. More often.
                </h2>
                <p className="text-drix-dim max-w-lg mx-auto mb-8 text-lg">
                  Point DRiX at your next deal and see the move it hands you.
                </p>
                <Link
                  to="/app"
                  className="inline-flex items-center gap-2 px-10 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all duration-300 hover:-translate-y-0.5"
                  style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
                >
                  Launch DRiX
                  <ArrowRight size={16} />
                </Link>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer className="border-t border-drix-border/50 py-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src="/DRiX-Logo.jpg" alt="DRiX" className="h-7 w-auto" />
            </div>
            <div className="text-xs text-drix-muted tracking-widest uppercase">
              by WinTech Partners
            </div>
          </div>
          {/* Standalone tools: plain anchors trigger a full page load to the server-rendered pages, not react-router routes */}
          <div className="mt-8 pt-6 border-t border-drix-border/30 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a href="/investor" className="text-xs text-drix-muted hover:text-drix-text tracking-wide uppercase transition-colors">Investor</a>
            <a href="/comparison" className="text-xs text-drix-muted hover:text-drix-text tracking-wide uppercase transition-colors">Comparison</a>
            <a href="/atomize" className="text-xs text-drix-muted hover:text-drix-text tracking-wide uppercase transition-colors">Atomize</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
