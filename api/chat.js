// ============================================================
// FLORENCIA OS — api/chat.js — Multilingue FR/EN/ES/PT + Plus
// Vercel Node.js · Supabase REST · Plans Free/Pro/Elite
// ============================================================

const PLAN_LIMITS = {
  free:  { messagesPerDay: 50,  webSearch: false, pdf: false, memory: "short", report: false },
  pro:   { messagesPerDay: -1,  webSearch: true,  pdf: true,  memory: "long",  report: false },
  elite: { messagesPerDay: -1,  webSearch: true,  pdf: true,  memory: "long",  report: true  }
};

// ════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════════════

export async function POST(request) {
  try {
    const body    = await safeJson(request);
    const message = String(body.message || "").trim();

    if (!message) {
      return jsonResponse(400, { error: "Message utilisateur manquant." });
    }

    // ── Clés API ──────────────────────────────────────────
    const GEMINI_API_KEY   = process.env.GEMINI_API_KEY            || "";
    const GROQ_API_KEY     = process.env.GROQ_API_KEY              || "";
    const TAVILY_API_KEY   = process.env.TAVILY_API_KEY            || "";
    const IPINFO_API_KEY   = process.env.IPINFO_API_KEY            || "";
    const SUPABASE_URL     = process.env.SUPABASE_URL              || "";
    const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    // ── Détection de langue ───────────────────────────────
    // On détecte la langue du message AVANT tout le reste
    const lang = detectLanguage(message);

    // ── Auth Supabase via REST ────────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const userToken  = authHeader.replace("Bearer ", "").trim();

    let userId   = null;
    let userPlan = "free";

    if (SUPABASE_URL && SUPABASE_SERVICE && userToken) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            "Authorization": `Bearer ${userToken}`,
            "apikey":        SUPABASE_SERVICE
          }
        });

        if (userRes.ok) {
          const userData = await userRes.json();
          userId = userData?.id || null;

          if (userId) {
            const profileRes = await fetch(
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,trial_ends_at`,
              {
                headers: {
                  "Authorization": `Bearer ${SUPABASE_SERVICE}`,
                  "apikey":        SUPABASE_SERVICE,
                  "Content-Type":  "application/json"
                }
              }
            );

            if (profileRes.ok) {
              const profiles = await profileRes.json();
              const profile  = profiles?.[0];
              if (profile) {
                const trialActive = profile.trial_ends_at
                  ? new Date(profile.trial_ends_at) > new Date()
                  : false;
                userPlan = trialActive ? "elite" : (profile.plan || "free");
              }
            }
          }
        }
      } catch (e) {
        console.warn("[Florencia OS] Supabase auth error:", e.message);
      }
    }

    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

    // ── Limite quotidienne (Free) ─────────────────────────
    if (planLimits.messagesPerDay > 0 && userId && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const todayDate = today();
        const usageRes  = await fetch(
          `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&select=messages_today,last_reset_date`,
          { headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE } }
        );

        if (usageRes.ok) {
          const usageArr = await usageRes.json();
          const usage    = usageArr?.[0];

          if (usage) {
            let msgToday = usage.messages_today || 0;

            if (usage.last_reset_date !== todayDate) {
              msgToday = 0;
              await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}`, {
                method: "PATCH",
                headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE, "Content-Type": "application/json" },
                body: JSON.stringify({ messages_today: 0, last_reset_date: todayDate })
              });
            }

            if (msgToday >= planLimits.messagesPerDay) {
              // Message d'erreur dans la langue de l'utilisateur
              const limitMsg = getLimitMessage(lang, planLimits.messagesPerDay);
              return jsonResponse(429, {
                error: "daily_limit_reached", message: limitMsg,
                plan: userPlan, upgradeUrl: "/pricing.html"
              });
            }

            await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}`, {
              method: "PATCH",
              headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE, "Content-Type": "application/json" },
              body: JSON.stringify({ messages_today: msgToday + 1 })
            });
          }
        }
      } catch (e) {
        console.warn("[Florencia OS] Usage limit check error:", e.message);
      }
    }

    // ── Données de la requête ─────────────────────────────
    const userProfile    = body.userProfile    || {};
    const dailyCheckin   = body.dailyCheckin   || {};
    const conversationId = body.conversationId || null;
    const pdfBase64      = body.pdfContent     || null;
    const conversation   = Array.isArray(body.conversation)
      ? body.conversation.slice(-12)
      : [];

    const userIp =
      body.userIp ||
      extractIp(request.headers.get("x-forwarded-for")) ||
      extractIp(request.headers.get("x-real-ip")) ||
      "";

    // ── Mémoire longue (Pro+) ─────────────────────────────
    let memory = body.memory || {};

    if (userId && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const memRes = await fetch(
          `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&select=key,value`,
          { headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE } }
        );
        if (memRes.ok) {
          const memRows = await memRes.json();
          if (memRows?.length > 0) {
            const dbMemory = {};
            memRows.forEach(row => { dbMemory[row.key] = row.value; });
            memory = { ...dbMemory, ...memory };
          }
        }
      } catch (e) { console.warn("[Florencia OS] Memory fetch error:", e.message); }
    }

    // ── Analyse PDF (Pro+) ────────────────────────────────
    let pdfContext = null;
    if (pdfBase64 && planLimits.pdf && GEMINI_API_KEY) {
      pdfContext = await analyzePDF(pdfBase64, GEMINI_API_KEY, lang);
    }

    // ── Intent & contexte ─────────────────────────────────
    const intent   = detectIntent(message, pdfContext);
    const useWeb   = planLimits.webSearch && shouldUseWeb(message, intent);
    const useLocal = shouldUseLocal(message, intent, userProfile);

    let localContext = null;
    if (useLocal) {
      localContext = await getLocalContext({ ip: userIp, token: IPINFO_API_KEY, userProfile });
    }

    let webContext = null;
    if (useWeb) {
      webContext = await searchWeb({
        query:  buildSearchQuery(message, userProfile, localContext),
        apiKey: TAVILY_API_KEY
      });
    }

    // ── Rapport hebdo (Elite) ─────────────────────────────
    const isWeeklyReport = planLimits.report && containsOne(message.toLowerCase(), [
      // FR
      "rapport", "rapport hebdo", "bilan semaine", "résumé semaine", "bilan de la semaine",
      // EN
      "weekly report", "week report", "weekly summary", "week summary",
      // ES
      "informe semanal", "resumen semanal",
      // PT
      "relatório semanal", "resumo semanal"
    ]);

    // ── Extraction mémoire ────────────────────────────────
    const extractedMemory = extractMemoryFromMessage(message, intent);

    // ── Prompt avec langue injectée ───────────────────────
    const florenciaPrompt = buildFlorenciaPrompt({
      message, intent, userProfile, dailyCheckin,
      localContext, webContext, conversation,
      memory, extractedMemory, userPlan,
      pdfContext, isWeeklyReport, lang
    });

    // ── Appel IA ──────────────────────────────────────────
    const isLong = isWeeklyReport || !!pdfContext;
    const result = await runRouter({
      intent, prompt: florenciaPrompt,
      geminiKey: GEMINI_API_KEY,
      groqKey:   GROQ_API_KEY,
      isLong
    });

    // ── Sauvegarde mémoire (Pro+) ─────────────────────────
    if (userId && extractedMemory && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const upserts = Object.entries(extractedMemory).map(([key, value]) => ({
          user_id: userId, key, value: String(value), updated_at: new Date().toISOString()
        }));
        if (upserts.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify(upserts)
          });
        }
      } catch (e) { console.warn("[Florencia OS] Memory save error:", e.message); }
    }

    // ── Sauvegarde conversation ───────────────────────────
    if (userId && conversationId && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE, "Content-Type": "application/json" },
          body: JSON.stringify([
            { conversation_id: conversationId, user_id: userId, role: "user",      content: message },
            { conversation_id: conversationId, user_id: userId, role: "assistant", content: result.reply }
          ])
        });
      } catch (e) { console.warn("[Florencia OS] Message save error:", e.message); }
    }

    return jsonResponse(200, {
      reply:        result.reply,
      provider:     result.provider,
      intent,
      plan:         userPlan,
      lang,
      usedWeb:      !!webContext,
      usedLocal:    !!localContext,
      usedPdf:      !!pdfContext,
      memoryUpdate: extractedMemory
    });

  } catch (error) {
    console.error("[Florencia OS] Erreur backend:", error);
    return jsonResponse(500, {
      error: "Backend error.", details: error?.message || "Unknown error"
    });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ════════════════════════════════════════════════════════════
// DÉTECTION DE LANGUE
// ════════════════════════════════════════════════════════════

function detectLanguage(text) {
  const t = text.toLowerCase();

  // Marqueurs français
  const frMarkers = [
    "je ", "tu ", "il ", "nous ", "vous ", "ils ", "mon ", "ton ", "son ",
    "ma ", "ta ", "sa ", "les ", "des ", "une ", "est ", "pas ", "que ",
    "pour ", "avec ", "dans ", "sur ", "aide", "comment", "quoi",
    "ça ", "mais ", "donc ", "alors ", "bien ", "très ", "aussi "
  ];

  // Marqueurs anglais
  const enMarkers = [
    "i ", "you ", "he ", "she ", "we ", "they ", "my ", "your ",
    "the ", "a ", "an ", "is ", "are ", "was ", "were ", "have ",
    "help ", "how ", "what ", "when ", "where ", "why ", "can ",
    "do ", "don't ", "let's ", "please ", "need ", "want "
  ];

  // Marqueurs espagnol
  const esMarkers = [
    "yo ", "tú ", "él ", "ella ", "nosotros ", "los ", "las ",
    "una ", "como ", "que ", "para ", "con ", "ayuda", "quiero ",
    "necesito ", "cómo ", "qué ", "por favor "
  ];

  // Marqueurs portugais
  const ptMarkers = [
    "eu ", "você ", "ele ", "ela ", "nos ", "os ", "as ",
    "como ", "que ", "para ", "com ", "ajuda", "quero ",
    "preciso ", "como ", "por favor "
  ];

  // Compter les occurrences
  const countMatches = (markers) =>
    markers.reduce((count, m) => count + (t.includes(m) ? 1 : 0), 0);

  const scores = {
    fr: countMatches(frMarkers),
    en: countMatches(enMarkers),
    es: countMatches(esMarkers),
    pt: countMatches(ptMarkers)
  };

  // Caractères spéciaux français
  if (/[àâäéèêëîïôùûüçœæ]/i.test(text)) scores.fr += 3;
  // Caractères spéciaux espagnol
  if (/[áéíóúüñ¿¡]/i.test(text)) scores.es += 3;
  // Caractères spéciaux portugais
  if (/[ãõàáâêéíóúüç]/i.test(text)) scores.pt += 2;

  // Trouver la langue avec le score le plus élevé
  const winner = Object.entries(scores).sort((a,b) => b[1]-a[1])[0];

  // Si aucun score significatif → défaut français
  if (winner[1] === 0) return "fr";

  return winner[0];
}

// Messages de limite par langue
function getLimitMessage(lang, limit) {
  const msgs = {
    fr: `Tu as atteint ta limite de ${limit} messages aujourd'hui. Passe au plan Pro pour des messages illimités.`,
    en: `You've reached your daily limit of ${limit} messages. Upgrade to Pro for unlimited messages.`,
    es: `Has alcanzado tu límite diario de ${limit} mensajes. Actualiza a Pro para mensajes ilimitados.`,
    pt: `Você atingiu seu limite diário de ${limit} mensagens. Atualize para o Pro para mensagens ilimitadas.`
  };
  return msgs[lang] || msgs.fr;
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

async function safeJson(req) {
  try { return await req.json(); }
  catch { return {}; }
}

function extractIp(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.split(",")[0].trim();
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function containsOne(text, keywords) {
  return keywords.some(w => text.includes(w));
}

// ════════════════════════════════════════════════════════════
// ANALYSE PDF — Gemini Vision (Pro+)
// ════════════════════════════════════════════════════════════

async function analyzePDF(pdfBase64, apiKey, lang = "fr") {
  if (!apiKey || !pdfBase64) return null;

  const instructions = {
    fr: "Analyse ce document de façon exhaustive. Extrais les points clés, les chiffres importants, les décisions mentionnées, les actions requises et le contexte business global. Réponds en français, de façon structurée et actionnable.",
    en: "Analyze this document thoroughly. Extract key points, important figures, mentioned decisions, required actions, and overall business context. Respond in English, in a structured and actionable way.",
    es: "Analiza este documento exhaustivamente. Extrae los puntos clave, cifras importantes, decisiones mencionadas, acciones requeridas y contexto general del negocio. Responde en español de forma estructurada.",
    pt: "Analise este documento detalhadamente. Extraia os pontos principais, números importantes, decisões mencionadas, ações necessárias e contexto do negócio. Responda em português de forma estruturada."
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
              { text: instructions[lang] || instructions.fr }
            ]
          }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// DÉTECTION D'INTENTION — Multilingue
// FR + EN + ES + PT
// ════════════════════════════════════════════════════════════

function detectIntent(message, pdfContext) {
  if (pdfContext) return "analyse_document";

  const t = message.toLowerCase();

  // Acquisition clients (FR/EN/ES/PT)
  if (containsOne(t, [
    // FR
    "client", "prospect", "prospection", "acquisition", "lead", "cold email",
    "trouver des clients", "outreach",
    // EN
    "find clients", "get clients", "prospecting", "outreach", "cold email",
    "customer", "customers", "sales",
    // ES
    "clientes", "prospecto", "conseguir clientes", "ventas",
    // PT
    "clientes", "prospecção", "conseguir clientes", "vendas"
  ])) return "acquisition_clients";

  // Génération d'offre
  if (containsOne(t, [
    // FR
    "offre", "positionnement", "promesse", "proposition de valeur", "tarif", "pricing",
    // EN
    "offer", "positioning", "value proposition", "pricing", "price", "package",
    // ES
    "oferta", "posicionamiento", "propuesta de valor", "precio",
    // PT
    "oferta", "posicionamento", "proposta de valor", "preço"
  ])) return "generation_offre";

  // Création de contenu
  if (containsOne(t, [
    // FR
    "contenu", "youtube", "script", "post", "publication", "calendrier éditorial",
    "idées de contenu", "instagram", "linkedin", "tiktok",
    // EN
    "content", "script", "post", "publish", "editorial calendar",
    "content ideas", "social media",
    // ES
    "contenido", "publicación", "guión", "redes sociales",
    // PT
    "conteúdo", "publicação", "roteiro", "redes sociais"
  ])) return "creation_contenu";

  // Gestion de projets
  if (containsOne(t, [
    // FR
    "projet", "organisation", "tâches", "deadline", "workflow", "plan d'action", "roadmap",
    // EN
    "project", "organize", "tasks", "deadline", "workflow", "action plan", "roadmap",
    // ES
    "proyecto", "organizar", "tareas", "plazo", "hoja de ruta",
    // PT
    "projeto", "organizar", "tarefas", "prazo", "roteiro"
  ])) return "gestion_projets";

  // Analyse business
  if (containsOne(t, [
    // FR
    "revenu", "analyse", "performance", "optimisation", "croissance", "business plan",
    // EN
    "revenue", "analysis", "performance", "optimization", "growth", "business plan",
    "analytics", "metrics",
    // ES
    "ingresos", "análisis", "rendimiento", "optimización", "crecimiento",
    // PT
    "receita", "análise", "desempenho", "otimização", "crescimento"
  ])) return "analyse_business";

  // Priorités du jour
  if (containsOne(t, [
    // FR
    "priorité", "priorités", "aujourd'hui", "cette semaine", "focus", "quoi faire",
    "par où commencer", "urgent",
    // EN
    "priority", "priorities", "today", "this week", "focus", "what to do",
    "where to start", "urgent",
    // ES
    "prioridad", "hoy", "esta semana", "enfoque", "urgente",
    // PT
    "prioridade", "hoje", "esta semana", "foco", "urgente"
  ])) return "priorites_jour";

  // Mémoire
  if (containsOne(t, [
    // FR
    "rappel", "n'oublie pas", "souviens-toi", "retiens", "mémorise", "note bien",
    // EN
    "remember", "don't forget", "keep in mind", "note that", "save this",
    // ES
    "recuerda", "no olvides", "memoriza", "anota",
    // PT
    "lembra", "não esqueça", "memoriza", "anota"
  ])) return "memoire";

  // Récap
  if (containsOne(t, [
    // FR
    "récap", "résumé", "où j'en suis", "bilan", "synthèse", "état des lieux",
    // EN
    "recap", "summary", "where am i", "overview", "status", "catch up",
    // ES
    "resumen", "estado", "resumen de situación",
    // PT
    "resumo", "estado", "situação atual"
  ])) return "recap";

  // Décision
  if (containsOne(t, [
    // FR
    "décision", "je dois choisir", "que faire", "conseil", "ton avis", "recommande",
    // EN
    "decision", "i need to choose", "what to do", "advice", "recommend", "should i",
    // ES
    "decisión", "tengo que elegir", "qué hacer", "consejo", "recomienda",
    // PT
    "decisão", "tenho que escolher", "o que fazer", "conselho", "recomenda"
  ])) return "decision";

  // Rédaction
  if (containsOne(t, [
    // FR
    "email", "message", "rédige", "écris", "lettre", "proposition", "relance",
    // EN
    "email", "write", "draft", "letter", "proposal", "follow up", "compose",
    // ES
    "correo", "escribe", "redacta", "carta", "propuesta",
    // PT
    "email", "escreve", "redigir", "carta", "proposta"
  ])) return "redaction";

  // Automatisation
  if (containsOne(t, [
    // FR
    "automatise", "automatisation", "workflow automatique", "si alors",
    // EN
    "automate", "automation", "automatic workflow", "if then", "trigger",
    // ES
    "automatiza", "automatización", "flujo automático",
    // PT
    "automatiza", "automação", "fluxo automático"
  ])) return "automatisation";

  return "general";
}

// ════════════════════════════════════════════════════════════
// WEB & LOCAL
// ════════════════════════════════════════════════════════════

function shouldUseWeb(message, intent) {
  const t = message.toLowerCase();
  if (containsOne(t, [
    // FR
    "aujourd'hui", "actuel", "maintenant", "tendance", "prix", "concurrence",
    "concurrent", "marché", "plateforme", "cherche", "recherche", "opportunité",
    "récent", "nouveautés",
    // EN
    "today", "current", "now", "trend", "price", "competition", "competitor",
    "market", "platform", "search", "recent", "latest",
    // ES / PT
    "hoy", "actual", "ahora", "tendencia", "mercado", "hoje", "atual"
  ])) return true;
  return ["acquisition_clients", "analyse_business", "generation_offre"].includes(intent);
}

function shouldUseLocal(message, intent, userProfile) {
  const t = message.toLowerCase();
  if (containsOne(t, [
    "dans mon pays", "dans ma ville", "local", "bénin", "france", "sénégal",
    "cotonou", "côte d'ivoire", "cameroun", "canada", "ville", "devise",
    "marché local", "fcfa",
    "in my country", "in my city", "local market", "locally",
    "en mi país", "en mi ciudad", "mercado local",
    "no meu país", "na minha cidade", "mercado local"
  ])) return true;
  if (userProfile.country || userProfile.city || userProfile.currency) return true;
  return ["acquisition_clients", "generation_offre", "analyse_business"].includes(intent);
}

function buildSearchQuery(message, userProfile, localContext) {
  const country = userProfile.country || localContext?.country || "";
  const city    = userProfile.city    || localContext?.city    || "";
  return [message, city, country].filter(Boolean).join(" | ");
}

async function getLocalContext({ ip, token, userProfile }) {
  const fallback = {
    country:  userProfile.country  || "",
    city:     userProfile.city     || "",
    currency: userProfile.currency || "",
    language: userProfile.language || "fr",
    timezone: userProfile.timezone || ""
  };
  if (!token || !ip) return fallback;
  try {
    const res = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!res.ok) return fallback;
    const data = await res.json();
    return {
      country:  fallback.country  || data.country  || "",
      city:     fallback.city     || data.city      || "",
      currency: fallback.currency || "",
      language: fallback.language || "fr",
      timezone: fallback.timezone || data.timezone  || ""
    };
  } catch { return fallback; }
}

async function searchWeb({ query, apiKey }) {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 5 })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      answer:  data.answer || "",
      results: Array.isArray(data.results)
        ? data.results.slice(0, 5).map(r => ({ title: r.title||"", url: r.url||"", content: r.content||"" }))
        : []
    };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// EXTRACTION MÉMOIRE (multilingue)
// ════════════════════════════════════════════════════════════

function extractMemoryFromMessage(message, intent) {
  const t       = message.toLowerCase();
  const updates = {};

  // Revenus (toutes devises)
  const revenueMatch = message.match(/(\d[\d\s]*)(€|euros?|fcfa|dollars?|k€|k\s*€|\$|£|xof|cfa)/i);
  if (revenueMatch) { updates.lastMentionedRevenue = revenueMatch[0]; updates.lastRevenueDate = today(); }

  // Projets (FR/EN)
  const projectMatch = message.match(/(?:projet|project|app|application|service|produit|product|plateforme|platform|startup)\s+["«]?([^"»\n,.]{3,50})["»]?/i);
  if (projectMatch) updates.lastProjectMentioned = projectMatch[1].trim();

  // Niche / marché (FR/EN)
  const nicheMatch = message.match(/(?:ma niche|my niche|mon marché|my market|je cible|i target|je travaille avec|i work with|mes clients sont|my clients are)\s+([^.!?\n]{5,60})/i);
  if (nicheMatch) updates.lastNicheMentioned = nicheMatch[1].trim();

  // Blocages (FR/EN/ES/PT)
  if (containsOne(t, [
    "bloqué", "je n'arrive pas", "problème", "difficulté", "galère", "j'ai du mal", "coincé",
    "stuck", "can't", "problem", "issue", "struggling", "blocked",
    "bloqueado", "problema", "dificultad",
    "bloqueado", "problema", "dificuldade"
  ])) {
    updates.lastBlocker = message.slice(0, 150); updates.lastBlockerDate = today();
  }

  // Décisions (FR/EN)
  if (containsOne(t, [
    "j'ai décidé", "j'ai choisi", "je vais", "je pars sur", "j'opte pour",
    "i decided", "i chose", "i'm going to", "i'll", "i will", "i've chosen"
  ])) {
    updates.lastDecision = message.slice(0, 150); updates.lastDecisionDate = today();
  }

  // Clients (FR/EN)
  if (containsOne(t, [
    "j'ai un client", "nouveau client", "j'ai signé", "nouveau contrat",
    "i have a client", "new client", "i signed", "new contract", "new deal"
  ])) {
    updates.lastClientMention = message.slice(0, 150); updates.lastClientDate = today();
  }

  if (intent !== "general") { updates.lastIntent = intent; updates.lastIntentDate = today(); }

  return Object.keys(updates).length > 0 ? updates : null;
}

// ════════════════════════════════════════════════════════════
// PROMPT BUILDER — Multilingue
// ════════════════════════════════════════════════════════════

function buildFlorenciaPrompt({
  message, intent, userProfile, dailyCheckin,
  localContext, webContext, conversation,
  memory, extractedMemory, userPlan,
  pdfContext, isWeeklyReport, lang
}) {
  const recentConversation = conversation.length
    ? conversation.map(m => `${m.role === "user" ? "User" : "Florencia"}: ${m.content}`).join("\n")
    : "No recent history.";

  const webBlock = webContext
    ? `WEB CONTEXT (real-time)\nSummary: ${webContext.answer || "N/A"}\n\nSources:\n${webContext.results.map((r,i) => `${i+1}. ${r.title}\n${r.content}\n${r.url}`).join("\n\n")}`
    : "";

  const memoryBlock = Object.keys(memory).length > 0
    ? `LONG-TERM MEMORY
- Revenue mentioned   : ${memory.lastMentionedRevenue || "—"} (${memory.lastRevenueDate  || ""})
- Project mentioned   : ${memory.lastProjectMentioned || "—"}
- Niche / market      : ${memory.lastNicheMentioned   || "—"}
- Last blocker        : ${memory.lastBlocker          || "—"} (${memory.lastBlockerDate  || ""})
- Last decision       : ${memory.lastDecision         || "—"} (${memory.lastDecisionDate || ""})
- Last client         : ${memory.lastClientMention    || "—"} (${memory.lastClientDate   || ""})
- Last intent         : ${memory.lastIntent           || "—"} (${memory.lastIntentDate   || ""})`
    : "MEMORY: First session — no data yet.";

  const pdfBlock = pdfContext ? `\nDOCUMENT ANALYZED (PDF)\n${pdfContext}` : "";

  // Instructions de langue claires et précises
  const langInstructions = {
    fr: "LANGUE : L'utilisateur écrit en FRANÇAIS. Tu DOIS répondre en français. Tutoiement obligatoire. Ton naturel, direct, premium.",
    en: "LANGUAGE : The user writes in ENGLISH. You MUST respond in English. Use informal but professional tone.",
    es: "IDIOMA : El usuario escribe en ESPAÑOL. DEBES responder en español. Tono directo, informal y profesional.",
    pt: "IDIOMA : O usuário escreve em PORTUGUÊS. DEVE responder em português. Tom direto, informal e profissional.",
  };

  const langRule = langInstructions[lang] || langInstructions.fr;

  // Structure de réponse traduite selon la langue
  const structures = {
    fr: isWeeklyReport
      ? buildWeeklyStructure("fr")
      : `**DIAGNOSTIC** — Nomme le vrai enjeu. Chirurgical.\n**RÉPONSE** — Direct, utile, adapté au profil.\n**PLAN D'ACTION** — 3 à 5 étapes numérotées. Verbe d'action fort.\n**PROCHAINE ÉTAPE** — Une seule chose. La plus importante maintenant.`,
    en: isWeeklyReport
      ? buildWeeklyStructure("en")
      : `**DIAGNOSIS** — Name the real issue. Sharp.\n**RESPONSE** — Direct, useful, profile-adapted.\n**ACTION PLAN** — 3 to 5 numbered steps. Strong action verb.\n**NEXT STEP** — One thing only. The most important right now.`,
    es: isWeeklyReport
      ? buildWeeklyStructure("es")
      : `**DIAGNÓSTICO** — Nombra el problema real. Directo.\n**RESPUESTA** — Directa, útil, adaptada al perfil.\n**PLAN DE ACCIÓN** — 3 a 5 pasos numerados. Verbo de acción fuerte.\n**PRÓXIMO PASO** — Solo una cosa. La más importante ahora.`,
    pt: isWeeklyReport
      ? buildWeeklyStructure("pt")
      : `**DIAGNÓSTICO** — Nomeia o problema real. Cirúrgico.\n**RESPOSTA** — Direta, útil, adaptada ao perfil.\n**PLANO DE AÇÃO** — 3 a 5 etapas numeradas. Verbo de ação forte.\n**PRÓXIMA ETAPA** — Apenas uma coisa. A mais importante agora.`
  };

  const structureBlock = structures[lang] || structures.fr;
  const intentGuide    = getIntentGuide(intent, lang);

  return `You are Florencia OS.

════════════════════════════════════════
IDENTITY
════════════════════════════════════════
Florencia OS is a Business Operating System for freelancers, independent consultants, creators and solo entrepreneurs.
You are not a chatbot. You are a high-level business copilot.
You combine four roles:
- Business strategist: you see clearly where the user is confused
- Decision support system: you prioritize what truly matters
- Structuring assistant: you transform vague ideas into concrete plans
- Action engine: you push toward real progress, not intellectual comfort

════════════════════════════════════════
LANGUAGE — CRITICAL RULE
════════════════════════════════════════
${langRule}
NEVER switch languages mid-response.
If unsure of the language, default to French.
Detected language code: ${lang}

════════════════════════════════════════
COMMUNICATION RULES
════════════════════════════════════════
- Be direct, sharp, precise. Zero filler. Zero padding.
- No "Of course!", "Absolutely!", "Great question!", "I understand your situation".
- Never sound like a generic AI reading from a manual.
- Don't repeat context the user just gave you.
- Calm, lucid, strategic, human, premium tone.
- Never mention AI providers, models, or technical limitations.
- If info is missing: one sentence, then act on what you have.
- Use memory — never ask questions already answered.

${intentGuide}

════════════════════════════════════════
OPERATIONAL CONTEXT
════════════════════════════════════════

PLAN: ${userPlan.toUpperCase()}${userPlan === "elite" ? " (trial active — full access)" : ""}

PROFILE
- Role/Job         : ${userProfile.job         || "—"}
- Niche            : ${userProfile.niche        || memory.lastNicheMentioned   || "—"}
- Main offer       : ${userProfile.offer        || "—"}
- Revenue goal     : ${userProfile.revenueGoal  || memory.lastMentionedRevenue || "—"}
- Country          : ${userProfile.country      || localContext?.country || "—"}
- City             : ${userProfile.city         || localContext?.city    || "—"}
- Currency         : ${userProfile.currency     || "—"}

DAILY CHECK-IN
- Goal    : ${dailyCheckin.goal    || "—"}
- Focus   : ${dailyCheckin.focus   || "—"}
- Blocker : ${dailyCheckin.blocker || "none"}
- Note    : ${dailyCheckin.note    || "—"}

LOCATION
- Country  : ${localContext?.country  || userProfile.country  || "—"}
- City     : ${localContext?.city     || userProfile.city     || "—"}
- Timezone : ${localContext?.timezone || "—"}

${memoryBlock}
${webBlock ? "\n" + webBlock : ""}
${pdfBlock}

RECENT CONVERSATION HISTORY
${recentConversation}

DETECTED INTENT: ${intent}

════════════════════════════════════════
USER MESSAGE
════════════════════════════════════════
${message}

════════════════════════════════════════
RESPONSE STRUCTURE
════════════════════════════════════════
${structureBlock}`;
}

// Structure rapport hebdomadaire multilingue
function buildWeeklyStructure(lang) {
  const s = {
    fr: `**BILAN DE LA SEMAINE** — Avancées notables, décisions prises, projets avancés.\n**POINTS POSITIFS** — Ce qui fonctionne et doit être amplifié.\n**POINTS D'ATTENTION** — Ce qui a bloqué ou ralenti — sans complaisance.\n**MÉTRIQUES CLÉS** — Objectifs vs réalisé.\n**PRIORITÉS SEMAINE PROCHAINE** — Les 3 actions les plus importantes.\n**CONSEIL STRATÉGIQUE** — Un insight business précis.`,
    en: `**WEEK RECAP** — Key achievements, decisions made, projects advanced.\n**POSITIVES** — What's working and should be amplified.\n**WATCH POINTS** — What blocked or slowed down — no sugar coating.\n**KEY METRICS** — Goals vs actual.\n**NEXT WEEK PRIORITIES** — The 3 most important actions.\n**STRATEGIC INSIGHT** — A precise business insight.`,
    es: `**RESUMEN SEMANAL** — Avances notables, decisiones tomadas, proyectos avanzados.\n**PUNTOS POSITIVOS** — Lo que funciona y debe amplificarse.\n**PUNTOS DE ATENCIÓN** — Lo que bloqueó o ralentizó.\n**MÉTRICAS CLAVE** — Objetivos vs realizado.\n**PRÓXIMA SEMANA** — Las 3 acciones más importantes.\n**CONSEJO ESTRATÉGICO** — Un insight de negocio preciso.`,
    pt: `**RESUMO SEMANAL** — Avanços notáveis, decisões tomadas, projetos avançados.\n**PONTOS POSITIVOS** — O que está funcionando e deve ser amplificado.\n**PONTOS DE ATENÇÃO** — O que bloqueou ou atrasou.\n**MÉTRICAS CHAVE** — Metas vs realizado.\n**PRÓXIMA SEMANA** — As 3 ações mais importantes.\n**CONSELHO ESTRATÉGICO** — Um insight de negócios preciso.`
  };
  return s[lang] || s.fr;
}

// ════════════════════════════════════════════════════════════
// GUIDES PAR INTENTION — Multilingue (EN de base car prompt en EN)
// ════════════════════════════════════════════════════════════

function getIntentGuide(intent, lang) {
  // Les guides sont en anglais car le prompt système est en anglais
  // L'IA adapte le contenu dans la langue de l'utilisateur grâce à la règle de langue
  const guides = {
    acquisition_clients: `GUIDE — CLIENT ACQUISITION\n- Prospecting scripts adapted to market and target\n- Relevant channels for the local context\n- Ready-to-use templates\n- Quantified goals (e.g. 10 prospects/week)`,
    generation_offre:    `GUIDE — OFFER CREATION\n- Name, content, price\n- Concrete transformation promise\n- Format adapted to local market and currency\n- Probable objections + answers`,
    creation_contenu:    `GUIDE — CONTENT CREATION\n- Topics adapted to niche and audience\n- Scripts, hooks, titles, post structures\n- Tone adapted to the platform (LinkedIn, TikTok, Instagram...)\n- Editorial calendar if requested`,
    gestion_projets:     `GUIDE — PROJECT MANAGEMENT\n- Break down into actionable tasks\n- Identify blockers and resolve them\n- Realistic planning with deadlines\n- Urgent vs important vs delegatable`,
    analyse_business:    `GUIDE — BUSINESS ANALYSIS\n- Fastest growth levers\n- Option comparison with quantified criteria\n- Simple metrics to track\n- Decisive opinion when needed`,
    analyse_document:    `GUIDE — DOCUMENT ANALYSIS\n- Key points and important figures\n- Decisions and required actions\n- Hidden risks or opportunities\n- Action plan if relevant`,
    priorites_jour:      `GUIDE — DAILY PRIORITIES\n- Max 3 priority actions\n- Urgent vs important\n- Overdue tasks or pending follow-ups\n- Logical execution order`,
    memoire:             `GUIDE — MEMORY\n- Confirm what was retained\n- Integrate into next conversation context\n- Suggest how to use this info concretely`,
    recap:               `GUIDE — RECAP\n- Synthesis via profile + memory\n- Strengths, weaknesses, priorities\n- 3 priority actions based on current status`,
    decision:            `GUIDE — DECISION\n- Comparison with concrete criteria\n- Clear and confident recommendation\n- Why this option · Risks of each choice`,
    redaction:           `GUIDE — WRITING\n- Text ready to copy-paste\n- Tone adapted to context\n- Subject if email, hook if post · Concise and impactful`,
    automatisation:      `GUIDE — AUTOMATION\n- Clear workflow steps\n- Tools to connect (Make, Zapier, Notion...)\n- Precise if/then logic · Estimated time saved`,
  };

  return guides[intent] ? `\nGUIDE\n${guides[intent]}\n` : "";
}

// ════════════════════════════════════════════════════════════
// ROUTER IA
// ════════════════════════════════════════════════════════════

async function runRouter({ intent, prompt, geminiKey, groqKey, isLong }) {
  const complexIntents = [
    "acquisition_clients", "generation_offre", "analyse_business",
    "decision", "recap", "analyse_document", "automatisation"
  ];
  const geminiFirst = complexIntents.includes(intent) || isLong;
  const providers   = geminiFirst ? ["gemini", "groq"] : ["groq", "gemini"];
  let lastError     = null;

  for (const p of providers) {
    try {
      if (p === "gemini" && geminiKey) {
        const reply = await callGemini(prompt, geminiKey, isLong);
        if (reply) return { reply, provider: "gemini" };
      }
      if (p === "groq" && groqKey) {
        const reply = await callGroq(prompt, groqKey);
        if (reply) return { reply, provider: "groq" };
      }
    } catch (err) { lastError = err; }
  }

  throw new Error(lastError?.message || "No AI provider available.");
}

async function callGemini(prompt, apiKey, isLong = false) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.72, maxOutputTokens: isLong ? 3000 : 1800 }
      })
    }
  );
  if (res.status === 429) throw new Error("Gemini quota reached.");
  if (!res.ok)           throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.72,
      max_tokens:  2000,
      messages:    [{ role: "user", content: prompt }]
    })
  });
  if (res.status === 429) throw new Error("Groq quota reached.");
  if (!res.ok)           throw new Error(`Groq error ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}
