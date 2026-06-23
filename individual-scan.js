// individual-scan.js — DRiX Individual Intelligence v2
// Multi-stage pipeline: Apollo enrichment → Brave deep research → LLM psychographic inference
//
// REPLACES: the old "ask the LLM to remember things" approach.
// NOW: enriches with REAL data from APIs, then asks the LLM to ANALYZE real facts.
//
// Environment variables used:
//   APOLLO_API_KEY       — Apollo.io person/company enrichment
//   BRAVE_API_KEY        — Brave Search for deep web research (podcasts, talks, news, etc.)
//   OPENROUTER_API_KEY   — LLM for psychographic inference + brief generation
//   OPENROUTER_MODEL_ID  — Model to use (default: anthropic/claude-sonnet-4.5)

const { runOsintEnrichment } = require('./osint-enrichment');

const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
// Individual scan uses a faster model for the synthesis call (latency-sensitive).
// Override with INDIVIDUAL_MODEL_ID; falls back to the main model if needed.
const INDIVIDUAL_MODEL_ID = process.env.INDIVIDUAL_MODEL_ID || 'anthropic/claude-haiku-4.5';
const APOLLO_API_KEY      = process.env.APOLLO_API_KEY || '';
const BRAVE_API_KEY       = process.env.BRAVE_API_KEY || '';
const CULTURESYNC_API_URL = process.env.CULTURESYNC_API_URL || 'https://theculturalsync.com';

// =============================================================================
// THECULTURALSYNC — CULTURAL INTELLIGENCE
// =============================================================================

/**
 * Fetch a cultural sales brief from TheCultureSync API.
 * Tries email-based country detection first; falls back to Apollo country data.
 * Returns null gracefully if the API is unreachable or the country can't be resolved.
 */
async function fetchCulturalBrief(email, apolloCountry, sellerCountry = 'United States') {
  try {
    let country = null;

    // Step 1: Try email-based country detection
    if (email) {
      const emailRes = await fetch(`${CULTURESYNC_API_URL}/api/resolve/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fallback_country: apolloCountry || null }),
        signal: AbortSignal.timeout(10000),
      });
      if (emailRes.ok) {
        const emailData = await emailRes.json();
        if (emailData.resolved) {
          country = emailData.country;
          console.log(`  ✓ CultureSync: resolved country from email → ${country} (${emailData.detection_method})`);
        }
      }
    }

    // Step 2: Fall back to Apollo-provided country
    if (!country && apolloCountry) {
      country = apolloCountry;
      console.log(`  ✓ CultureSync: using Apollo country → ${country}`);
    }

    if (!country) {
      console.log('  ✗ CultureSync: no country detected — skipping cultural brief');
      return null;
    }

    // Step 3: Fetch the sales brief
    const briefRes = await fetch(
      `${CULTURESYNC_API_URL}/api/sales-brief/${encodeURIComponent(country)}?seller_country=${encodeURIComponent(sellerCountry)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!briefRes.ok) {
      console.log(`  ✗ CultureSync: sales-brief ${briefRes.status} for ${country}`);
      return null;
    }

    const brief = await briefRes.json();
    console.log(`  ✓ CultureSync: sales brief for ${country} (${brief.baseline} baseline, ${brief.region} region)`);
    return brief;

  } catch (err) {
    console.log(`  ✗ CultureSync: ${err.message} (non-fatal — skipping cultural intel)`);
    return null;
  }
}

// =============================================================================
// APOLLO ENRICHMENT
// =============================================================================

async function apolloEnrichPerson(linkedinUrl, email) {
  if (!APOLLO_API_KEY) {
    console.log('[individual-scan] No APOLLO_API_KEY — skipping person enrichment');
    return null;
  }

  // NOTE: reveal_personal_emails / reveal_phone_number cause a 400 on non-master
  // keys. We omit them — the match still returns title, org, and cached email.
  const payload = {};
  if (linkedinUrl) payload.linkedin_url = linkedinUrl;
  if (email) payload.email = email;

  try {
    const response = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'X-Api-Key': APOLLO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.log(`[individual-scan] Apollo person: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.person || null;
  } catch (err) {
    console.error('[individual-scan] Apollo person enrichment failed:', err.message);
    return null;
  }
}

async function apolloEnrichCompany(domain) {
  if (!APOLLO_API_KEY || !domain) return null;

  try {
    const response = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
      headers: {
        'X-Api-Key': APOLLO_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.organization || null;
  } catch (err) {
    console.error('[individual-scan] Apollo company enrichment failed:', err.message);
    return null;
  }
}

// =============================================================================
// BRAVE SEARCH — DEEP WEB RESEARCH
// =============================================================================

async function braveSearch(query, count = 10) {
  if (!BRAVE_API_KEY) return [];

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      offset: '0',
      mkt: 'en-US',
      safesearch: 'off',
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      date: r.age || '',
    }));
  } catch (err) {
    console.error(`[individual-scan] Brave search failed for "${query.slice(0, 40)}":`, err.message);
    return [];
  }
}

async function braveNewsSearch(query, count = 10) {
  if (!BRAVE_API_KEY) return [];

  try {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const response = await fetch(`https://api.search.brave.com/res/v1/news/search?${params}`, {
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      date: r.age || '',
      source: r.meta_url?.hostname || '',
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Deep web research on an individual.
 * PHASE 1: Discovery — figure out who this person actually is (bio pages, LinkedIn, org charts, announcements)
 * PHASE 2: Deep dive — podcasts, talks, news, content, certifications, awards
 *
 * Does NOT depend on having the right company name upfront. Searches with and without it.
 */
async function deepResearch(name, company, title, companyDomain) {
  if (!BRAVE_API_KEY || !name) {
    console.log('[individual-scan] No BRAVE_API_KEY or no name — skipping deep research');
    return { discovery: [], profile_pages: [], certifications: [], podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  }

  console.log(`[individual-scan] Deep research: "${name}" (title: ${title || 'unknown'}) at ${company || 'unknown'} (domain: ${companyDomain || 'none'})`);

  const results = { discovery: [], profile_pages: [], certifications: [], podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  const seen = new Set();

  function dedup(items) {
    return items.filter(item => {
      const key = item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Classification helpers
  const isPodcast = (r) => /podcast|episode|ep\.|listen|spotify|apple.podcast/i.test(r.title + r.url + r.description);
  const isVideo = (r) => /youtube\.com|vimeo|video|webinar|recording/i.test(r.title + r.url);
  const isConference = (r) => /conference|summit|forum|keynote|panel|speaker|fireside/i.test(r.title + r.description);
  const isPR = (r) => /press.release|newswire|announces|appointed|promoted|named|hired|joins/i.test(r.title + r.url + r.description);
  const isContent = (r) => /author|written.by|blog|medium\.com|linkedin\.com\/pulse|contributed/i.test(r.title + r.url + r.description);
  const isAward = (r) => /award|winner|recognized|honored|top.40|influential|rising.star/i.test(r.title + r.description);
  const isVolunteer = (r) => /volunteer|nonprofit|board.member|advisory|mentor|charity|foundation/i.test(r.title + r.description);
  const isProfile = (r) => /linkedin\.com|theorg\.com|zoominfo|rocketreach|apollo|crunchbase|about|leadership|team|bio/i.test(r.url + r.title);
  const isCert = (r) => /certif|cissp|ccsp|ccna|cism|cisa|pmp|aws.cert|azure.cert|comptia/i.test(r.title + r.description);

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: DISCOVERY — figure out who they are, find their full bio
  // ═══════════════════════════════════════════════════════════════════════

  // 1a. Pure name + title search (no company dependency — catches everything)
  const discoveryResults1 = await braveSearch(`"${name}" ${title || ''}`, 10);
  results.discovery.push(...dedup(discoveryResults1));
  await delay(500);

  // Name + company name
  if (company) {
    const discoveryResults2 = await braveSearch(`"${name}" "${company}"`, 10);
    results.discovery.push(...dedup(discoveryResults2));
    await delay(500);
  }

  // Company's own site (bio / leadership pages)
  if (companyDomain) {
    const siteResults = await braveSearch(`"${name}" site:${companyDomain}`, 10);
    results.profile_pages.push(...dedup(siteResults));
    await delay(500);
  }

  // Profile pages (LinkedIn, TheOrg, ZoomInfo, team pages)
  const profileResults = await braveSearch(`"${name}" ${title || ''} site:linkedin.com OR site:theorg.com OR site:zoominfo.com OR leadership OR "about us"`, 10);
  results.profile_pages.push(...dedup(profileResults.filter(isProfile)));
  await delay(500);

  // Hiring / appointment announcements - GOLD for career history
  const appointResults = await braveSearch(`"${name}" appointed OR hired OR joins OR named OR promoted ${title || ''}`, 10);
  results.pr.push(...dedup(appointResults.filter(isPR)));
  results.discovery.push(...dedup(appointResults));
  await delay(500);

  // News mentions
  const newsResults1 = await braveNewsSearch(`"${name}" ${title || ''}`, 10);
  results.news.push(...dedup(newsResults1));

  // Dedup discovery results one final time
  const discoveryUrls = new Set();
  results.discovery = results.discovery.filter(item => {
    const key = item.url || item.title;
    if (discoveryUrls.has(key)) return false;
    discoveryUrls.add(key);
    return true;
  });

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Deep research complete: ${total} findings`);
  console.log(`  Discovery: ${results.discovery.length}, Profiles: ${results.profile_pages.length}, Certs: ${results.certifications.length}`);
  console.log(`  Podcasts: ${results.podcasts.length}, Talks: ${results.talks.length}, News: ${results.news.length}`);
  console.log(`  PR: ${results.pr.length}, Content: ${results.content.length}, Awards: ${results.awards.length}`);

  return results;
}

/**
 * Deep web research on a COMPANY.
 * Pulls recent filings, PR, earnings, strategic moves, leadership changes, partnerships.
 */
async function deepCompanyResearch(companyName, domain) {
  if (!BRAVE_API_KEY || (!companyName && !domain)) {
    console.log('[individual-scan] No BRAVE_API_KEY or no company info — skipping company research');
    return { about: [], sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [], investor_relations: [] };
  }

  // Use domain as search term if company name is garbage (short abbreviations, etc.)
  // e.g. "ndbt" is useless but "ndbt.com" will find "North Dallas Bank and Trust"
  const searchName = companyName || domain;
  const altSearchName = domain && domain !== companyName ? domain : null;

  console.log(`[individual-scan] Company deep research: "${searchName}" (domain: ${domain || 'none'}, alt: ${altSearchName || 'none'})`);

  const results = { about: [], sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [], investor_relations: [] };
  const seen = new Set();

  function dedup(items) {
    return items.filter(item => {
      const key = item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Company website (about / leadership / products)
  if (domain) {
    const siteResults = await braveSearch(`site:${domain} about OR leadership OR services OR products OR "about us"`, 10);
    results.about.push(...dedup(siteResults));
    await delay(500);
  }

  // General overview
  const overviewResults = await braveSearch(`"${searchName}" company overview OR about OR history`, 10);
  results.about.push(...dedup(overviewResults));
  await delay(500);

  // Recent news
  const newsResults = await braveNewsSearch(`"${searchName}"`, 10);
  results.news.push(...dedup(newsResults));
  await delay(500);

  // Leadership & strategic moves
  const leaderResults = await braveNewsSearch(`"${searchName}" CEO OR CTO OR CFO OR CIO OR VP appointed OR hired OR joins OR partnership OR acquisition`, 8);
  results.leadership = dedup(leaderResults);

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Company research complete: ${total} findings`);
  console.log(`  About: ${results.about.length}, IR: ${results.investor_relations.length}, SEC: ${results.sec_filings.length}`);
  console.log(`  PR: ${results.press_releases.length}, News: ${results.news.length}, Earnings: ${results.earnings.length}`);
  console.log(`  Leadership: ${results.leadership.length}, Partnerships: ${results.partnerships.length}, Products: ${results.product_launches.length}`);

  return results;
}

// =============================================================================
// LLM PSYCHOGRAPHIC INFERENCE — Analyzes REAL data, doesn't guess
// =============================================================================

const PSYCHOGRAPHIC_PROMPT = `You are an elite B2B sales intelligence analyst. Your job: produce a CONFIDENCE-SCORED psychographic profile that tells a sales rep exactly what they KNOW vs. what they're GUESSING about this person.

YOU HAVE THREE SOURCES — each with different reliability:

1. ENRICHED DATA (Apollo, web searches, company filings) — HIGHEST confidence. Real API data with employment history, certifications, education, company financials. Cite directly.
2. YOUR OWN KNOWLEDGE — what you already know about this person, their company, their industry, their certifications, their role type. This is STRONG when the person/company is well-known. Label it clearly (e.g. "Based on known banking CIO priorities...").
3. OSINT DIGITAL FOOTPRINT (if present) — LOWEST confidence. These are UNVERIFIED username matches. A platform check found an account matching a derived username — but it could be a DIFFERENT person with the same name. NEVER build core profile conclusions on OSINT alone. Treat as "possible digital presence — unverified" unless corroborated by other data (e.g., a GitHub profile that mentions the same company).

CONFIDENCE SCALE (use percentages):
- 95-100%: Directly verified from authoritative source (Apollo employment record, public filing, official company page)
- 80-94%: Strongly supported by multiple data points or well-known facts about the company/person
- 60-79%: Reasonable professional inference from role + industry + company type
- 40-59%: Speculative but plausible based on patterns for this role/industry
- Below 40%: Weak inference — acknowledge it and say WHY you're guessing

THE GOLDEN RULE: A rep who knows what they DON'T know is better prepared than one who thinks they know everything. NEVER present a 60% inference as a fact. Label everything.

CRITICAL RULES ON OSINT:
- OSINT username matches are 30-50% confidence AT BEST unless corroborated
- Do NOT build archetype classification primarily on OSINT platform presence
- A "PyPI account found" does NOT mean this CIO writes Python packages — it means SOMEONE with a similar username has an account
- Only elevate OSINT confidence if: the profile bio mentions the same company/role, OR multiple OSINT signals align with verified employment data
- When OSINT contradicts verified data (e.g., OSINT suggests "developer-influencer" but Apollo shows "security-focused banking CIO with CISSP"), TRUST THE VERIFIED DATA

ARCHETYPE CLASSIFICATION (must be grounded in VERIFIED data, not OSINT):
- DEFENDER: Protective of what works, risk-averse, long tenure, security-focused, values stability. Evidence: long tenures, security certifications, regulated industry, conservative company.
- GROWER: Ambitious, ascending trajectory, wants bigger scope. Evidence: frequent moves up, expanding responsibilities, growth-stage companies.
- OPTIMIZER: Efficiency-focused, data-driven, iterates. Evidence: operations background, process certifications, cost-center leadership.
- PIONEER: Cutting-edge seeker, early adopter, thought leader. Evidence: VERIFIED conference talks, published articles, emerging-tech certifications.
- BUILDER: Creates from scratch, entrepreneurial, long-term thinker. Evidence: startup experience, greenfield projects, architect-level certifications.

DECISION STYLES:
- Analytical: Needs data, proof, methodology — common with security/compliance backgrounds
- Intuitive: Goes with gut after initial validation — common with serial entrepreneurs
- Consensus: Needs team buy-in — common in matrixed orgs
- Directive: Decides fast and alone — common with founder-CIOs

USING ENRICHMENT DATA SECTIONS:
- APOLLO DATA: Employment history, certifications, education — this is your highest-confidence source. Build the core profile from this.
- WEB RESEARCH: Podcasts, talks, articles, news — verify these are about THIS person (check name + company match). Conference talks and published content are gold for hooks.
- COMPANY INTELLIGENCE: Filings, press releases, earnings, leadership changes, hiring signals — use to understand company context and timing. A company hiring aggressively = different sale than one in cost-cutting mode.
- OSINT (if present): Username matches across platforms. TREAT WITH EXTREME CAUTION. Only reference if corroborated. If you include OSINT-based inferences, explicitly mark them as "unverified — possible digital presence."

OUTPUT (JSON only, no markdown fences) — keep it TIGHT and FAST. Return ONLY these fields:
{
  "recognized": true,
  "overall_confidence": "<percentage for the total profile>",
  "individual": {
    "name": "<full name>",
    "title": "<current role>",
    "company": "<current company — FULL correct name, not abbreviations>",
    "linkedin_url": "<as provided>",
    "key_insight": "<the single most important thing a salesperson should know>",
    "key_insight_confidence": "<percentage>"
  },
  "psychographic": {
    "archetype": "<defender|grower|optimizer|pioneer|builder>",
    "archetype_confidence": "<percentage>",
    "decision_style": "<analytical|intuitive|consensus|directive>"
  },
  "summary": "<3-4 sentence profile — who they are, career arc, what they care about>",
  "sales_strategy": {
    "opening_hook": "<exact words to open — must reference something VERIFIED about them>",
    "conversation_starters": [
      { "topic": "<specific topic>", "confidence": "<percentage>", "basis": "<why it lands>" }
    ],
    "pitch_angles": [
      { "angle": "<specific angle>", "confidence": "<percentage>", "basis": "<why it resonates>" }
    ],
    "objections": [
      { "objection": "<likely objection>", "confidence": "<percentage>", "response": "<specific counter>", "basis": "<why you expect it>" }
    ]
  },
  "company_situation": {
    "company_full_name": "<correct full company name>",
    "industry": "<specific industry>",
    "strategic_direction": "<what the company is focused on>",
    "financial_health": "<growing|stable|contracting|restructuring>"
  },
  "atoms": [
    {
      "type": "<career_history|certification|public_statement|thought_leadership|leadership_style|professional_focus|pain_signal|decision_pattern|company_strategic|company_leadership|osint_unverified>",
      "claim": "<one clear sentence>",
      "evidence": "<specific data point>",
      "confidence_pct": <number 1-100>,
      "source": "<apollo|web_search|company_intel|osint_unverified|personal_knowledge>"
    }
  ]
}

DISCIPLINE (optimized for a fast, focused brief — brevity is REQUIRED):
- Build the profile from VERIFIED data (Apollo + web) and your own knowledge; stay accurate. Treat OSINT username matches as unverified — never build core conclusions on them.
- key_insight: one sharp sentence. summary: 3-4 tight sentences.
- conversation_starters: exactly 3. pitch_angles: exactly 3. objections: exactly 3 (each with a response).
- atoms: 4-6 of the MOST important — never return an empty atoms array.
- Ground archetype in verified evidence, not OSINT. If you would not bet money on a claim, do not put it above 70%.
- MANDATORY: always fully populate individual, summary, sales_strategy (opening_hook + exactly 3 conversation_starters + 3 pitch_angles + 3 objections), company_situation, and atoms. Never return empty/missing fields for these — a thin profile is a failure.
- Keep every field tight and punchy — a rep skims this in 30 seconds.`;

// =============================================================================
// MAIN PIPELINE
// =============================================================================

// =============================================================================
// PERSON VERIFICATION — verify name+title at company before researching
// =============================================================================

/**
 * Verify that a named person actually holds the stated title at the stated company.
 * Uses Apollo people search to cross-reference.
 * Returns { verified, actual_name, actual_title, mismatch_details, confidence }
 */
async function verifyPerson({ name, title, company_url }) {
  if (!APOLLO_API_KEY || !name || !company_url) {
    return { verified: null, reason: 'Insufficient data for verification (need name + company_url + Apollo API key)' };
  }

  const domain = company_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
  if (!domain) return { verified: null, reason: 'Could not extract domain from company_url' };

  try {
    // Search Apollo for this person at this company
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'X-Api-Key': APOLLO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        person_titles: title ? [title] : undefined,
        q_organization_domains: domain,
        q_keywords: name,
        per_page: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.log(`[verify-person] Apollo search failed: ${response.status}`);
      return { verified: null, reason: `Apollo search returned ${response.status}` };
    }

    const data = await response.json();
    const people = data.people || [];

    if (people.length === 0) {
      // Nobody found at that company matching the name
      return {
        verified: false,
        mismatch: 'not_found',
        mismatch_details: `No person named "${name}" found at ${domain}. The person may have left, or the name may be incorrect.`,
        confidence: 70,
        suggestions: [],
      };
    }

    // Check for exact or close name match
    const nameLower = name.toLowerCase().trim();
    const exactMatch = people.find(p =>
      (p.name || '').toLowerCase().trim() === nameLower ||
      (p.first_name + ' ' + p.last_name).toLowerCase().trim() === nameLower
    );

    if (exactMatch) {
      // Name found — now check title match
      const actualTitle = exactMatch.title || '';
      const titleMatch = title && actualTitle.toLowerCase().includes(title.toLowerCase().split(/[,\/]/)[0].trim());

      if (!title || titleMatch) {
        return {
          verified: true,
          actual_name: exactMatch.name || `${exactMatch.first_name} ${exactMatch.last_name}`,
          actual_title: actualTitle,
          actual_email: exactMatch.email || null,
          actual_linkedin: exactMatch.linkedin_url || null,
          confidence: 90,
        };
      } else {
        return {
          verified: false,
          mismatch: 'title_mismatch',
          actual_name: exactMatch.name || `${exactMatch.first_name} ${exactMatch.last_name}`,
          actual_title: actualTitle,
          expected_title: title,
          mismatch_details: `"${name}" is at ${domain}, but their title is "${actualTitle}" — not "${title}".`,
          confidence: 85,
        };
      }
    }

    // Partial matches — flag for review
    const closestPeople = people.slice(0, 3).map(p => ({
      name: p.name || `${p.first_name} ${p.last_name}`,
      title: p.title || '',
      email: p.email || null,
      linkedin_url: p.linkedin_url || null,
    }));

    return {
      verified: false,
      mismatch: 'name_mismatch',
      mismatch_details: `Exact name "${name}" not found at ${domain}. Closest matches found.`,
      suggestions: closestPeople,
      confidence: 60,
    };

  } catch (err) {
    console.error('[verify-person] Verification failed:', err.message);
    return { verified: null, reason: `Verification error: ${err.message}` };
  }
}

/**
 * When only a title is given (no name), try to find the real person at the company.
 * Returns { found, name, title, email, linkedin_url, confidence }
 */
async function resolvePersonByTitle({ title, company_url }) {
  if (!APOLLO_API_KEY || !title || !company_url) {
    return { found: false, reason: 'Need title + company_url + Apollo API key' };
  }

  const domain = company_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
  if (!domain) return { found: false, reason: 'Could not extract domain' };

  try {
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'X-Api-Key': APOLLO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        person_titles: [title],
        q_organization_domains: domain,
        per_page: 3,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return { found: false, reason: `Apollo returned ${response.status}` };
    }

    const data = await response.json();
    const people = data.people || [];

    if (people.length === 0) {
      return { found: false, reason: `No one with title "${title}" found at ${domain}` };
    }

    const best = people[0];
    return {
      found: true,
      name: best.name || `${best.first_name} ${best.last_name}`,
      title: best.title || title,
      email: best.email || null,
      linkedin_url: best.linkedin_url || null,
      confidence: people.length === 1 ? 85 : 65, // Higher confidence if only one match
      alternatives: people.length > 1 ? people.slice(1).map(p => ({
        name: p.name || `${p.first_name} ${p.last_name}`,
        title: p.title || '',
      })) : [],
    };

  } catch (err) {
    console.error('[resolve-by-title] Resolution failed:', err.message);
    return { found: false, reason: err.message };
  }
}

/**
 * Run complete individual intelligence pipeline.
 *
 * @param {Object} opts
 * @param {string} opts.linkedin_url - LinkedIn URL
 * @param {string} opts.email - Email address
 * @param {string} opts.title - Job title (hint)
 * @param {string} opts.name - Name (hint)
 * @param {string} opts.company_url - Company website URL (e.g. ndbt.com)
 * @param {number} opts.tier - 1=full, 2=quick (reserved for future)
 * @param {string} opts.solution_url - Solution being sold (for closing intel)
 */
async function scanIndividual({ linkedin_url, email, title, name, company_url, tier = 1, supplementalDocs = null, solution_url = null }) {
  const startTime = Date.now();

  // ─── STAGE 0: PERSON VERIFICATION ──────────────────────────────────────────
  // Before any research, verify the person is who the user says they are.
  let verification = null;
  const hasName = name && name.trim().length > 0;
  const hasTitle = title && title.trim().length > 0;
  const hasCompanyUrl = company_url && company_url.trim().length > 0;

  if (hasName && hasCompanyUrl) {
    // ── Named person: verify name+title at company ──
    console.log(`\n[0/6] VERIFICATION: Confirming "${name}" is "${title || 'unknown title'}" at ${company_url}...`);
    verification = await verifyPerson({ name, title, company_url });
    if (verification.verified === true) {
      console.log(`  ✓ VERIFIED: ${verification.actual_name}, ${verification.actual_title}`);
      // Use verified data going forward
      if (verification.actual_name) name = verification.actual_name;
      if (verification.actual_title) title = verification.actual_title;
      if (verification.actual_email && !email) email = verification.actual_email;
      if (verification.actual_linkedin && !linkedin_url) linkedin_url = verification.actual_linkedin;
    } else if (verification.verified === false) {
      console.log(`  ⚠ MISMATCH: ${verification.mismatch_details}`);
      // Don't stop — flag it and continue with best available data
    } else {
      console.log(`  ? Could not verify: ${verification.reason}`);
    }
  } else if (!hasName && hasTitle && hasCompanyUrl) {
    // ── Title only (no name): try to find the real person ──
    console.log(`\n[0/6] TITLE RESOLUTION: Finding the "${title}" at ${company_url}...`);
    const resolution = await resolvePersonByTitle({ title, company_url });
    if (resolution.found) {
      console.log(`  ✓ RESOLVED: ${resolution.name} (${resolution.title}) — ${resolution.confidence}% confidence`);
      name = resolution.name;
      title = resolution.title;
      if (resolution.email && !email) email = resolution.email;
      if (resolution.linkedin_url && !linkedin_url) linkedin_url = resolution.linkedin_url;
      verification = {
        verified: true,
        resolved_from_title: true,
        actual_name: resolution.name,
        actual_title: resolution.title,
        confidence: resolution.confidence,
        alternatives: resolution.alternatives || [],
      };
    } else {
      console.log(`  ✗ Could not resolve: ${resolution.reason}`);
      verification = {
        verified: null,
        resolved_from_title: false,
        reason: resolution.reason,
      };
    }
  }
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;

  // Extract domain from company_url if provided (strip protocol, www, trailing paths)
  let inputCompanyDomain = '';
  if (company_url) {
    inputCompanyDomain = company_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[individual-scan] STARTING PIPELINE`);
  console.log(`  LinkedIn: ${linkedin_url || 'N/A'}`);
  console.log(`  Email: ${email || 'N/A'}`);
  console.log(`  Name hint: ${name || 'N/A'}`);
  console.log(`  Title hint: ${title || 'N/A'}`);
  console.log(`  Company URL: ${company_url || 'N/A'} (domain: ${inputCompanyDomain || 'N/A'})`);
  console.log(`${'═'.repeat(60)}`);

  // ─── STAGE 1: APOLLO ENRICHMENT ────────────────────────────────────────────
  console.log('\n[1/5] Apollo Person Enrichment...');
  const apolloPerson = await apolloEnrichPerson(linkedin_url, email);

  let personName = name;
  let personTitle = title;
  let personCompany = '';
  let companyDomain = inputCompanyDomain; // Start with what the user gave us
  let apolloCompany = null;

  if (apolloPerson) {
    personName = apolloPerson.name || name || nameFromSlug(linkedinSlug);
    personTitle = apolloPerson.title || title;
    personCompany = apolloPerson.organization?.name || '';
    // Use Apollo's domain if we don't already have one, or if Apollo's is more specific
    if (!companyDomain) {
      companyDomain = apolloPerson.organization?.primary_domain || '';
    }
    console.log(`  ✓ Found: ${personName}, ${personTitle} @ ${personCompany}`);
  } else {
    personName = name || nameFromSlug(linkedinSlug);
    // Try to derive company name from the domain the user provided
    if (inputCompanyDomain) {
      personCompany = domainToCompanyName(inputCompanyDomain);
      console.log(`  ✗ No Apollo data — derived company name from URL: "${personCompany}"`);
    } else {
      personCompany = companyFromEmail(email) || '';
      console.log(`  ✗ No Apollo data — using hints: ${personName}, ${personCompany}`);
    }
  }

  // Company enrichment via Apollo — try with the domain we have
  if (companyDomain && !apolloCompany) {
    console.log(`  [1b] Apollo Company Enrichment (${companyDomain})...`);
    apolloCompany = await apolloEnrichCompany(companyDomain);
    if (apolloCompany) {
      // Apollo gave us the real company name — use it
      if (!personCompany || personCompany.length < (apolloCompany.name || '').length) {
        personCompany = apolloCompany.name;
      }
      console.log(`  ✓ Company: ${apolloCompany.name}, ~${apolloCompany.estimated_num_employees || '?'} employees, ${apolloCompany.industry || 'unknown industry'}`);
    }
  }

  // ─── STAGE 2: DEEP WEB RESEARCH + OSINT + CULTURAL INTEL (PARALLEL) ────────
  // Run all four in parallel: web research, company research, OSINT, and cultural brief
  console.log('\n[2/6] Deep Research + OSINT + Cultural Intelligence (parallel)...');
  console.log('       → Individual web research (podcasts, talks, news, content)');
  console.log('       → Company research (filings, PR, earnings, strategy)');
  console.log('       → OSINT enrichment (username discovery + email intelligence)');
  console.log('       → TheCultureSync cultural sales brief');

  // Detect the prospect's country from Apollo data for cultural brief
  const apolloCountry = apolloPerson?.country || apolloCompany?.country || apolloPerson?.organization?.country || null;

  const [webResearch, companyResearch, osintResults, culturalBrief] = await Promise.all([
    deepResearch(personName, personCompany, personTitle, companyDomain),
    deepCompanyResearch(personCompany, companyDomain),
    Promise.race([
      runOsintEnrichment({ name: personName, linkedinUrl: linkedin_url, email }),
      new Promise(resolve => setTimeout(() => { console.log('[individual-scan] OSINT time-boxed at 9s — proceeding with partial/none'); resolve(null); }, 9000)),
    ]).catch(err => {
      console.error('[individual-scan] OSINT enrichment failed (non-fatal):', err.message);
      return null;
    }),
    fetchCulturalBrief(email, apolloCountry).catch(err => {
      console.error('[individual-scan] Cultural brief failed (non-fatal):', err.message);
      return null;
    }),
  ]);

  if (osintResults) {
    console.log(`  ✓ OSINT: ${osintResults.digitalFootprint?.accountsFound || 0} accounts, ${osintResults.emailIntelligence?.registeredOn?.length || 0} email services`);
  }

  // ─── STAGE 3: BUILD ENRICHMENT PACKAGE FOR LLM ────────────────────────────
  console.log('\n[3/6] Assembling enrichment data...');

  const enrichmentPackage = buildEnrichmentPackage({
    apolloPerson,
    apolloCompany,
    webResearch,
    companyResearch,
    osintResults,
    culturalBrief,
    personName,
    personTitle,
    personCompany,
    linkedin_url,
    email,
    supplementalDocs,
  });

  // ─── STAGE 4: LLM PSYCHOGRAPHIC ANALYSIS ──────────────────────────────────
  console.log('\n[4/6] LLM Psychographic Analysis...');

  if (!OPENROUTER_API_KEY) {
    console.log('  ✗ No OPENROUTER_API_KEY — returning raw enrichment only');
    return {
      scan: { total_found: 0, accounts: [], web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0) },
      atoms: [],
      individual: { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      summary: 'LLM not configured — returning raw enrichment data.',
      pitch_angles: [],
      enrichment: enrichmentPackage,
      web_research: webResearch,
      verification: verification || null,
      pipeline_time_ms: Date.now() - startTime,
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3100',
        'X-Title': 'DRiX Individual Intelligence v2',
      },
      body: JSON.stringify({
        model: INDIVIDUAL_MODEL_ID,
        provider: { sort: 'throughput' }, // route to the fastest provider for this model
        messages: [
          { role: 'system', content: PSYCHOGRAPHIC_PROMPT },
          { role: 'user', content: `Analyze this individual and produce a CONFIDENCE-SCORED psychographic intelligence profile. Every claim must have a confidence percentage and basis.\n\nENRICHED DATA:\n\n${JSON.stringify(enrichmentPackage, null, 2)}\n\nINSTRUCTIONS:\n1. Start with VERIFIED FACTS from Apollo/web data. These are your foundation (85-100% confidence).\n2. Build STRONG INFERENCES from verified facts + your knowledge of the person/company/industry (70-84%).\n3. Add MODERATE INFERENCES where role + industry patterns suggest likely behaviors (50-69%).\n4. Be HONEST about SPECULATIVE claims — label them clearly (25-49%).\n5. If OSINT data is present, note the _WARNING field. Username matches are UNVERIFIED. Do not treat them as confirmed identity.\n6. Use your own knowledge FREELY but label it. If you know this company is a community bank in Texas, say so and use it.\n7. The reliability_summary at the end is MANDATORY — tell the rep what's solid and what's a guess.\n8. NEVER present an inference as a fact. A rep who walks in calibrated beats one who walks in overconfident.${enrichmentPackage.cultural_intelligence ? `\n9. CULTURAL INTELLIGENCE is available from TheCultureSync. The prospect is in ${enrichmentPackage.cultural_intelligence.target_country} (${enrichmentPackage.cultural_intelligence.cultural_baseline} baseline, ${enrichmentPackage.cultural_intelligence.region} region). Factor cultural norms into your sales_strategy: adapt pitch_angles for their communication style, adjust conversation_starters for cultural appropriateness, note phrases_to_use/avoid that respect their cultural context, and tailor meeting/negotiation advice. Include a "cultural_sales_guidance" section in your output with: country, baseline, key_adaptations (3-5 specific things to do differently), email_approach, meeting_approach, and trust_building_strategy. ${enrichmentPackage.cultural_intelligence.cross_culture_warning ? 'WARNING: ' + enrichmentPackage.cultural_intelligence.cross_culture_warning : ''}` : ''}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 5000,
      }),
      signal: AbortSignal.timeout(90000), // 90s cap — output is now bounded for speed
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    const elapsed = Date.now() - startTime;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[individual-scan] PIPELINE COMPLETE in ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`  Overall confidence: ${parsed.overall_confidence || 'unknown'}`);
    console.log(`  Archetype: ${parsed.psychographic?.archetype?.toUpperCase() || 'unknown'} (${parsed.psychographic?.archetype_confidence || '?'})`);
    console.log(`  Decision style: ${parsed.psychographic?.decision_style || 'unknown'}`);
    console.log(`  Verified facts: ${(parsed.verified_facts || []).length}`);
    console.log(`  Atoms: ${(parsed.atoms || []).length}`);
    console.log(`${'═'.repeat(60)}\n`);

    return {
      scan: {
        total_found: Object.values(webResearch).reduce((s, a) => s + a.length, 0),
        accounts: [],
        web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0),
        recognized: parsed.recognized ?? true,
        confidence: parsed.overall_confidence || 'medium',
      },
      atoms: parsed.atoms || [],
      individual: parsed.individual || { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      psychographic: parsed.psychographic || null,
      summary: parsed.summary || '',
      // Confidence-scored intelligence tiers
      verified_facts: parsed.verified_facts || [],
      strong_inferences: parsed.strong_inferences || [],
      moderate_inferences: parsed.moderate_inferences || [],
      speculative: parsed.speculative || [],
      // Sales strategy (replaces flat pitch_angles/conversation_starters)
      sales_strategy: parsed.sales_strategy || null,
      key_insight: parsed.individual?.key_insight || null,
      key_insight_confidence: parsed.individual?.key_insight_confidence || null,
      opening_hook: parsed.sales_strategy?.opening_hook || null,
      conversation_starters: parsed.sales_strategy?.conversation_starters || [],
      pitch_angles: parsed.sales_strategy?.pitch_angles || [],
      phrases_to_use: parsed.sales_strategy?.phrases_to_use || [],
      phrases_to_avoid: parsed.sales_strategy?.phrases_to_avoid || [],
      objections: parsed.sales_strategy?.objections || [],
      // Company & technology
      company_situation: parsed.company_situation || null,
      technology_interests: parsed.technology_interests || [],
      digital_presence: parsed.digital_presence || null,
      // Reliability meta
      reliability_summary: parsed.reliability_summary || null,
      // Cultural intelligence from TheCultureSync
      cultural_brief: culturalBrief || null,
      cultural_sales_guidance: parsed.cultural_sales_guidance || null,
      // Raw data (for debugging / display)
      enrichment: enrichmentPackage,
      web_research: webResearch,
      company_research: companyResearch,
      osint_results: osintResults || null,
      company_url: company_url || null,
      company_domain: companyDomain || null,
      verification: verification || null,
      pipeline_time_ms: elapsed,
    };

  } catch (err) {
    console.error(`[individual-scan] LLM analysis failed:`, err.message);
    // Still return what we have from enrichment
    return {
      scan: { total_found: 0, accounts: [], web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0) },
      atoms: [],
      individual: { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      summary: `LLM analysis failed (${err.message}) — raw enrichment data available.`,
      pitch_angles: [],
      enrichment: enrichmentPackage,
      web_research: webResearch,
      osint_results: osintResults || null,
      verification: verification || null,
      pipeline_time_ms: Date.now() - startTime,
    };
  }
}

// =============================================================================
// ENRICHMENT PACKAGE BUILDER
// =============================================================================

function buildEnrichmentPackage({ apolloPerson, apolloCompany, webResearch, companyResearch, osintResults, culturalBrief, personName, personTitle, personCompany, linkedin_url, email, supplementalDocs }) {
  // Compact search results for the LLM: title + short description only (drop urls/dates)
  // to shrink the prompt and speed up the synthesis call.
  const compact = (arr, n = 5, dlen = 160) => (arr || []).slice(0, n).map(r => ({ title: r.title || '', desc: (r.description || '').slice(0, dlen) }));
  const pkg = {
    person: {
      name: personName,
      title: personTitle,
      company: personCompany,
      email: email || apolloPerson?.email || null,
      phone: apolloPerson?.phone_numbers?.[0]?.number || null,
      linkedin_url,
      location: apolloPerson ? `${apolloPerson.city || ''}, ${apolloPerson.state || ''}`.replace(/^, |, $/, '') : null,
      photo_url: apolloPerson?.photo_url || null,
    },
    employment_history: [],
    education: [],
    skills: [],
    company_context: null,
    company_intelligence: null,
    web_research: {
      discovery: compact(webResearch.discovery, 6),
      profile_pages: compact(webResearch.profile_pages, 5),
      certifications: compact(webResearch.certifications, 4),
      news_mentions: compact(webResearch.news, 5),
      pr_announcements: compact(webResearch.pr, 4),
    },
  };

  // Employment history from Apollo (already structured — no text parsing!)
  if (apolloPerson?.employment_history) {
    pkg.employment_history = apolloPerson.employment_history.map(job => ({
      title: job.title || '',
      company: job.organization_name || '',
      start_date: job.start_date || '',
      end_date: job.end_date || '',
      is_current: job.current || !job.end_date,
      description: job.description || '',
    }));
  }

  // Education from Apollo
  if (apolloPerson?.education) {
    pkg.education = apolloPerson.education.map(edu => ({
      school: edu.school_name || edu.school || '',
      degree: edu.degree || '',
      field: edu.field_of_study || edu.major || '',
      start_year: edu.start_date || '',
      end_year: edu.end_date || '',
    }));
  }

  // Skills
  pkg.skills = apolloPerson?.skills || [];

  // Company context (static profile from Apollo)
  if (apolloCompany || apolloPerson?.organization) {
    const org = apolloCompany || apolloPerson.organization || {};
    pkg.company_context = {
      name: org.name || personCompany,
      industry: org.industry || '',
      sub_industry: org.sub_industry || org.industry_tag_name || '',
      size: org.estimated_num_employees || '',
      revenue: org.annual_revenue_printed || '',
      founded: org.founded_year || '',
      website: org.website_url || org.primary_domain || '',
      location: [org.city, org.state, org.country].filter(Boolean).join(', ') || '',
      description: org.short_description || org.description || '',
      technologies: (org.current_technologies || []).slice(0, 20),
      keywords: (org.keywords || []).slice(0, 15),
    };
  }

  // Company intelligence (LIVE research — filings, PR, earnings, strategy)
  if (companyResearch) {
    const hasData = Object.values(companyResearch).some(arr => arr.length > 0);
    if (hasData) {
      pkg.company_intelligence = {
        about_pages: compact(companyResearch.about, 5),
        recent_news: compact(companyResearch.news, 5),
        leadership_changes: compact(companyResearch.leadership, 5),
      };
    }
  }

  // OSINT digital footprint (username discovery + email intelligence)
  // ⚠️ IMPORTANT: These are UNVERIFIED username matches. A 200 HTTP response at a URL
  // like pypi.org/user/shaneharkins does NOT confirm this is the same person.
  // The LLM prompt instructs the model to treat these as low-confidence signals.
  if (osintResults?.digitalFootprint) {
    const df = osintResults.digitalFootprint;
    pkg.osint_digital_footprint = {
      _WARNING: "UNVERIFIED USERNAME MATCHES. These accounts matched a derived username but have NOT been confirmed to belong to this person. A different person with the same or similar name may own these accounts. Do NOT build core profile conclusions on this data alone.",
      accounts_found: df.accountsFound || 0,
      platforms: df.platforms || [],
      tech_presence: df.techPresence || [],
      social_presence: df.socialPresence || [],
      content_presence: df.contentPresence || [],
      business_presence: df.businessPresence || [],
      email_registrations: df.emailRegistrations || [],
      is_work_email: df.isWorkEmail,
      breach_exposure: df.breachExposure,
      github_url: df.githubUrl || null,
    };
  }
  if (osintResults?.emailIntelligence) {
    const ei = osintResults.emailIntelligence;
    pkg.osint_email_intelligence = {
      _WARNING: "Email service checks indicate this email address may be registered on these platforms, but registration alone does not confirm active use or identity.",
      registered_on: ei.registeredOn || [],
      not_found_on: ei.notFoundOn || [],
      errors: ei.errors || [],
    };
  }

  // Cultural intelligence from TheCultureSync API
  if (culturalBrief) {
    pkg.cultural_intelligence = {
      source: 'TheCultureSync API (theculturalsync.com)',
      target_country: culturalBrief.target_country,
      seller_country: culturalBrief.seller_country,
      cultural_baseline: culturalBrief.baseline,
      region: culturalBrief.region,
      dimension_guidance: culturalBrief.dimension_guidance || {},
      digital_communication: culturalBrief.digital_communication || null,
      offline_behavioral: culturalBrief.offline_behavioral || null,
      cross_culture_warning: culturalBrief.cross_culture_warning || null,
    };
  }

  // Uploaded documents (first-party intel from the sales rep)
  if (supplementalDocs && supplementalDocs.length > 0) {
    pkg.uploaded_documents = supplementalDocs.map(doc => ({
      filename: doc.filename,
      content: doc.text.slice(0, 30000), // Cap each doc at 30k chars to stay in context
      source: 'uploaded_doc',
    }));
  }

  return pkg;
}

// =============================================================================
// HELPERS
// =============================================================================

function nameFromSlug(slug) {
  if (!slug) return null;
  const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '').replace(/\d+$/, '');
  return cleaned.split(/[-_]/).filter(p => p.length > 1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function companyFromEmail(email) {
  if (!email) return null;
  const domain = email.split('@')[1];
  if (!domain) return null;
  return domainToCompanyName(domain);
}

/** Convert a domain like "ndbt.com" to a rough company name like "Ndbt" */
function domainToCompanyName(domain) {
  if (!domain) return '';
  return domain
    .replace(/^www\./i, '')
    .replace(/\.(com|io|co|net|org|edu|gov|bank|finance|tech)$/i, '')
    .replace(/\./g, ' ')
    .split(' ')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = { scanIndividual };
