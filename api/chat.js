// ============================================================
// FLORENCIA OS — api/chat.js — Vercel Node.js Compatible
// Version avec mémoire conversationnelle, raisonnement, anti-répétition
// ============================================================

// ── Limites par plan ──────────────────────────────────────
const PLAN_LIMITS = {
  free:  { messagesPerDay: 50,  webSearch: false, pdf: false, memory: "short", report: false },
  pro:   { messagesPerDay: -1,  webSearch: true,  pdf: true,  memory: "long",  report: false },
  elite: { messagesPerDay: -1,  webSearch: true,  pdf: true,  memory: "long",  report: true  }
};

// ═══════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════

export async function POST(request) {
  try {
    const body    = await safeJson(request);
    const message = String(body.message || "").trim();

    if (!message) {
      return jsonResponse(400, { error: "Message utilisateur manquant." });
    }

    // ── Clés API ──────────────────────────────────────────
    const GEMINI_API_KEY   = process.env.GEMINI_API_KEY           || "";
    const GROQ_API_KEY     = process.env.GROQ_API_KEY             || "";
    const TAVILY_API_KEY   = process.env.TAVILY_API_KEY           || "";
    const IPINFO_API_KEY   = process.env.IPINFO_API_KEY           || "";
    const SUPABASE_URL     = process.env.SUPABASE_URL             || "";
    const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

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

        const usageRes = await fetch(
          `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&select=messages_today,last_reset_date`,
          {
            headers: {
              "Authorization": `Bearer ${SUPABASE_SERVICE}`,
              "apikey":        SUPABASE_SERVICE
            }
          }
        );

        if (usageRes.ok) {
          const usageArr = await usageRes.json();
          const usage    = usageArr?.[0];

          if (usage) {
            let msgToday = usage.messages_today || 0;

            if (usage.last_reset_date !== todayDate) {
              msgToday = 0;
              await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}`, {
                method:  "PATCH",
                headers: {
                  "Authorization": `Bearer ${SUPABASE_SERVICE}`,
                  "apikey":        SUPABASE_SERVICE,
                  "Content-Type":  "application/json"
                },
                body: JSON.stringify({ messages_today: 0, last_reset_date: todayDate })
              });
            }

            if (msgToday >= planLimits.messagesPerDay) {
              return jsonResponse(429, {
                error:      "daily_limit_reached",
                message:    `Tu as atteint ta limite de ${planLimits.messagesPerDay} messages aujourd'hui. Passe au plan Pro pour des messages illimités.`,
                plan:       userPlan,
                upgradeUrl: "/pricing.html"
              });
            }

            await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}`, {
              method:  "PATCH",
              headers: {
                "Authorization": `Bearer ${SUPABASE_SERVICE}`,
                "apikey":        SUPABASE_SERVICE,
                "Content-Type":  "application/json"
              },
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

    // ── Mémoire longue depuis Supabase (Pro+) ────────────
    let memory = body.memory || {};

    if (userId && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const memRes = await fetch(
          `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&select=key,value`,
          {
            headers: {
              "Authorization": `Bearer ${SUPABASE_SERVICE}`,
              "apikey":        SUPABASE_SERVICE
            }
          }
        );

        if (memRes.ok) {
          const memRows = await memRes.json();
          if (memRows?.length > 0) {
            const dbMemory = {};
            memRows.forEach(row => { dbMemory[row.key] = row.value; });
            memory = { ...dbMemory, ...memory };
          }
        }
      } catch (e) {
        console.warn("[Florencia OS] Memory fetch error:", e.message);
      }
    }

    // ── Analyse PDF (Pro+) ────────────────────────────────
    let pdfContext = null;
    if (pdfBase64 && planLimits.pdf && GEMINI_API_KEY) {
      pdfContext = await analyzePDF(pdfBase64, GEMINI_API_KEY);
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
      "rapport", "rapport hebdo", "bilan semaine",
      "weekly report", "résumé semaine", "bilan de la semaine"
    ]);

    // ── Extraction mémoire ────────────────────────────────
    const extractedMemory = extractMemoryFromMessage(message, intent);

    // ═══════════════════════════════════════════════════════
    // ⭐ CONSTRUCTION DES MESSAGES (HISTORIQUE + CONTEXTE) ⭐
    // ═══════════════════════════════════════════════════════
    const messages = buildMessages({
      message, intent, userProfile, dailyCheckin,
      localContext, webContext, conversation,
      memory, extractedMemory, userPlan,
      pdfContext, isWeeklyReport
    });

    // ═══════════════════════════════════════════════════════
    // APPEL À L'IA
    // ═══════════════════════════════════════════════════════
    const isLong = isWeeklyReport || !!pdfContext;
    const result = await runRouter({
      intent,
      messages,   // ← on passe les messages structurés
      geminiKey: GEMINI_API_KEY,
      groqKey:   GROQ_API_KEY,
      isLong
    });

    // ═══════════════════════════════════════════════════════
    // ⭐ EXTRACTION DU RAISONNEMENT ET DE LA RÉPONSE FINALE ⭐
    // ═══════════════════════════════════════════════════════
    let replyText = result.reply;
    let reasoning = null;

    try {
      // Nettoyer la réponse (parfois entourée de ```json ... ```)
      const cleaned = replyText.replace(/```json\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      reasoning = parsed.reasoning || null;
      replyText = parsed.answer || replyText;
    } catch (e) {
      // Si le parsing échoue, on garde la réponse brute
      console.warn("[Florencia OS] Impossible de parser le JSON, utilisation brute");
    }

    // ── Sauvegarde mémoire (Pro+) ─────────────────────────
    if (userId && extractedMemory && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const upserts = Object.entries(extractedMemory).map(([key, value]) => ({
          user_id:    userId,
          key,
          value:      String(value),
          updated_at: new Date().toISOString()
        }));

        if (upserts.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
            method:  "POST",
            headers: {
              "Authorization": `Bearer ${SUPABASE_SERVICE}`,
              "apikey":        SUPABASE_SERVICE,
              "Content-Type":  "application/json",
              "Prefer":        "resolution=merge-duplicates"
            },
            body: JSON.stringify(upserts)
          });
        }
      } catch (e) {
        console.warn("[Florencia OS] Memory save error:", e.message);
      }
    }

    // ── Sauvegarde conversation ───────────────────────────
    if (userId && conversationId && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
          method:  "POST",
          headers: {
            "Authorization": `Bearer ${SUPABASE_SERVICE}`,
            "apikey":        SUPABASE_SERVICE,
            "Content-Type":  "application/json"
          },
          body: JSON.stringify([
            { conversation_id: conversationId, user_id: userId, role: "user",      content: message },
            { conversation_id: conversationId, user_id: userId, role: "assistant", content: replyText }
          ])
        });
      } catch (e) {
        console.warn("[Florencia OS] Message save error:", e.message);
      }
    }

    // ⭐ RÉPONSE AVEC RAISONNEMENT
    return jsonResponse(200, {
      reply:        replyText,
      reasoning:    reasoning,    // ← pour l'onglet repliable
      provider:     result.provider,
      intent,
      plan:         userPlan,
      usedWeb:      !!webContext,
      usedLocal:    !!localContext,
      usedPdf:      !!pdfContext,
      memoryUpdate: extractedMemory
    });

  } catch (error) {
    console.error("[Florencia OS] Erreur backend:", error);
    return jsonResponse(500, {
      error:   "Erreur backend Florencia.",
      details: error?.message || "Erreur inconnue"
    });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

// ═══════════════════════════════════════════════════════════
// HELPERS GÉNÉRAUX
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// ANALYSE PDF — Gemini Vision (Pro+)
// ═══════════════════════════════════════════════════════════

async function analyzePDF(pdfBase64, apiKey) {
  if (!apiKey || !pdfBase64) return null;
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
              { text: "Analyse ce document de façon exhaustive. Extrais les points clés, les chiffres importants, les décisions mentionnées, les actions requises et le contexte business global. Réponds en français, de façon structurée et actionnable." }
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

// ═══════════════════════════════════════════════════════════
// DÉTECTION D'INTENTION (inchangée)
// ═══════════════════════════════════════════════════════════

function detectIntent(message, pdfContext) {
  if (pdfContext) return "analyse_document";
  const t = message.toLowerCase();

  if (containsOne(t, ["client", "prospect", "prospection", "acquisition", "lead", "cold email", "trouver des clients", "outreach"])) return "acquisition_clients";
  if (containsOne(t, ["offre", "positionnement", "promesse", "proposition de valeur", "prix", "tarif", "pricing", "package"])) return "generation_offre";
  if (containsOne(t, ["contenu", "youtube", "script", "post", "publication", "calendrier éditorial", "idées de contenu", "instagram", "linkedin", "tiktok"])) return "creation_contenu";
  if (containsOne(t, ["projet", "organisation", "tâches", "deadline", "workflow", "plan d'action", "roadmap", "planning"])) return "gestion_projets";
  if (containsOne(t, ["revenu", "analyse", "performance", "optimisation", "croissance", "business plan", "chiffres", "résultats"])) return "analyse_business";
  if (containsOne(t, ["priorité", "priorités", "aujourd'hui", "cette semaine", "focus", "quoi faire", "par où commencer", "urgent"])) return "priorites_jour";
  if (containsOne(t, ["rappel", "n'oublie pas", "souviens-toi", "retiens", "mémorise", "note bien", "rappelle-moi"])) return "memoire";
  if (containsOne(t, ["récap", "résumé", "où j'en suis", "bilan", "synthèse", "état des lieux", "rapport", "semaine"])) return "recap";
  if (containsOne(t, ["décision", "je dois choisir", "que faire", "conseil", "ton avis", "recommande", "compare", "lequel"])) return "decision";
  if (containsOne(t, ["email", "message", "rédige", "écris", "rédiger", "lettre", "proposition", "relance"])) return "redaction";
  if (containsOne(t, ["automatise", "automatisation", "workflow automatique", "si alors", "déclenche", "zapier", "make"])) return "automatisation";

  return "general";
}

// ═══════════════════════════════════════════════════════════
// WEB & LOCAL (inchangés)
// ═══════════════════════════════════════════════════════════

function shouldUseWeb(message, intent) {
  const t = message.toLowerCase();
  if (containsOne(t, ["aujourd'hui", "actuel", "maintenant", "tendance", "prix", "concurrence", "concurrent", "marché", "niche", "plateforme", "cherche", "recherche", "opportunité", "récent", "nouveautés", "2025", "2026"])) return true;
  return ["acquisition_clients", "analyse_business", "generation_offre"].includes(intent);
}

function shouldUseLocal(message, intent, userProfile) {
  const t = message.toLowerCase();
  if (containsOne(t, ["dans mon pays", "dans ma ville", "local", "bénin", "france", "sénégal", "cotonou", "côte d'ivoire", "cameroun", "canada", "ville", "devise", "marché local", "fcfa"])) return true;
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
        ? data.results.slice(0, 5).map(r => ({ title: r.title || "", url: r.url || "", content: r.content || "" }))
        : []
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// EXTRACTION MÉMOIRE (inchangée)
// ═══════════════════════════════════════════════════════════

function extractMemoryFromMessage(message, intent) {
  const t       = message.toLowerCase();
  const updates = {};

  const revenueMatch = message.match(/(\d[\d\s]*)(€|euros?|fcfa|dollars?|k€|k\s*€|\$)/i);
  if (revenueMatch) { updates.lastMentionedRevenue = revenueMatch[0]; updates.lastRevenueDate = today(); }

  const projectMatch = message.match(/(?:projet|app|application|service|produit|plateforme|startup)\s+["«]?([^"»\n,.]{3,50})["»]?/i);
  if (projectMatch) updates.lastProjectMentioned = projectMatch[1].trim();

  const nicheMatch = message.match(/(?:ma niche|mon marché|je cible|je travaille avec|mes clients sont)\s+([^.!?\n]{5,60})/i);
  if (nicheMatch) updates.lastNicheMentioned = nicheMatch[1].trim();

  if (containsOne(t, ["bloqué", "je n'arrive pas", "problème", "difficulté", "galère", "j'ai du mal", "coincé"])) {
    updates.lastBlocker = message.slice(0, 150); updates.lastBlockerDate = today();
  }

  if (containsOne(t, ["j'ai décidé", "j'ai choisi", "je vais", "je pars sur", "j'opte pour", "on va faire"])) {
    updates.lastDecision = message.slice(0, 150); updates.lastDecisionDate = today();
  }

  if (containsOne(t, ["j'ai un client", "nouveau client", "prospect intéressé", "j'ai signé", "nouveau contrat"])) {
    updates.lastClientMention = message.slice(0, 150); updates.lastClientDate = today();
  }

  if (intent !== "general") { updates.lastIntent = intent; updates.lastIntentDate = today(); }

  return Object.keys(updates).length > 0 ? updates : null;
}

// ═══════════════════════════════════════════════════════════
// ⭐ NOUVEAU : CONSTRUCTION DES MESSAGES POUR L'IA ⭐
// ═══════════════════════════════════════════════════════════

function buildMessages({
  message, intent, userProfile, dailyCheckin,
  localContext, webContext, conversation,
  memory, extractedMemory, userPlan,
  pdfContext, isWeeklyReport
}) {
  // 1. Prompt système principal
  const systemPrompt = buildSystemPrompt(intent, userPlan, isWeeklyReport);

  // 2. Contexte additionnel (profil, mémoire, web, etc.)
  const contextBlocks = buildContextBlocks({
    userProfile, dailyCheckin, localContext, webContext,
    memory, extractedMemory, pdfContext, intent
  });

  // 3. Historique récent (les derniers messages)
  const historyMessages = conversation.map(msg => ({
    role: msg.role === "user" ? "user" : "assistant",
    content: msg.content
  }));

  // 4. Message utilisateur actuel
  const userMessage = message;

  // Assemblage final
  const messages = [
    { role: "system", content: systemPrompt }
  ];

  if (contextBlocks) {
    messages.push({ role: "system", content: contextBlocks });
  }

  messages.push(...historyMessages);
  messages.push({ role: "user", content: userMessage });

  return messages;
}

function buildSystemPrompt(intent, userPlan, isWeeklyReport) {
  const base = `Tu es Florencia OS, un Business Operating System pour freelances et indépendants.
Tu tutoies l'utilisateur. Tu es directe, précise, sans blabla.
Tu ne répètes jamais la même chose qu'une précédente réponse.
Si l'utilisateur repose une question similaire, tu changes de formulation et apportes un nouvel angle.
Tu es naturelle, moderne, avec un ton humain et stratégique.
Tu n’indiques jamais que tu es une IA, ni ne mentionnes des providers techniques.
Tu réponds toujours en français, sauf si l’utilisateur écrit en anglais (alors tu réponds en anglais).`;

  const intentGuide = getIntentGuide(intent); // la fonction existante
  const structure = isWeeklyReport
    ? `Structure ta réponse en JSON avec deux champs :
- "reasoning" : ton analyse interne (3-5 lignes, ce que tu as pris en compte)
- "answer" : la réponse finale pour l'utilisateur (avec le format demandé)`
    : `Structure ta réponse en JSON avec deux champs :
- "reasoning" : ton raisonnement (3-5 lignes, explique ce que tu as analysé)
- "answer" : la réponse finale à l'utilisateur (format libre, selon l'intention)`;

  return `${base}\n\n${intentGuide}\n\n${structure}`;
}

function buildContextBlocks({
  userProfile, dailyCheckin, localContext, webContext,
  memory, extractedMemory, pdfContext, intent
}) {
  const blocks = [];

  if (userProfile && Object.keys(userProfile).length) {
    blocks.push(`PROFIL UTILISATEUR\n${JSON.stringify(userProfile, null, 2)}`);
  }
  if (dailyCheckin && Object.keys(dailyCheckin).length) {
    blocks.push(`CHECK-IN DU JOUR\n${JSON.stringify(dailyCheckin, null, 2)}`);
  }
  if (localContext && Object.keys(localContext).length) {
    blocks.push(`CONTEXTE LOCAL\n${JSON.stringify(localContext, null, 2)}`);
  }
  if (webContext) {
    blocks.push(`RECHERCHE WEB\nRésumé : ${webContext.answer || "Non disponible"}\nSources : ${webContext.results.map(r => r.title).join(", ")}`);
  }
  if (memory && Object.keys(memory).length) {
    blocks.push(`MÉMOIRE LONG TERME\n${JSON.stringify(memory, null, 2)}`);
  }
  if (pdfContext) {
    blocks.push(`ANALYSE PDF\n${pdfContext}`);
  }

  return blocks.length ? blocks.join("\n\n") : null;
}

// ═══════════════════════════════════════════════════════════
// GUIDES PAR INTENTION (inchangés)
// ═══════════════════════════════════════════════════════════

function getIntentGuide(intent) {
  const guides = {
    acquisition_clients: `GUIDE — ACQUISITION CLIENTS\n- Scripts de prospection adaptés au marché et à la cible\n- Canaux pertinents selon le contexte local\n- Templates directement utilisables\n- Objectifs chiffrés (ex: 10 prospects/semaine)`,
    generation_offre:    `GUIDE — GÉNÉRATION D'OFFRE\n- Nom, contenu, prix\n- Promesse de transformation concrète\n- Format adapté au marché local et à la devise\n- Objections probables + réponses`,
    creation_contenu:    `GUIDE — CRÉATION DE CONTENU\n- Sujets adaptés à la niche et l'audience\n- Scripts, hooks, titres, structures de posts\n- Ton adapté à la plateforme (LinkedIn, TikTok, Instagram...)\n- Calendrier éditorial si demandé`,
    gestion_projets:     `GUIDE — GESTION DE PROJETS\n- Décomposer en tâches actionnables\n- Identifier les blocages et les lever\n- Planning réaliste avec deadlines\n- Urgent vs important vs délégable`,
    analyse_business:    `GUIDE — ANALYSE BUSINESS\n- Leviers de croissance les plus rapides\n- Comparaison d'options avec critères chiffrés\n- Métriques simples à suivre\n- Avis tranché quand une décision s'impose`,
    analyse_document:    `GUIDE — ANALYSE DE DOCUMENT\n- Points clés et chiffres importants\n- Décisions et actions requises\n- Risques ou opportunités cachés\n- Plan d'action si pertinent`,
    priorites_jour:      `GUIDE — PRIORITÉS DU JOUR\n- Max 3 actions prioritaires\n- Urgent vs important\n- Tâches en retard ou suivis en attente\n- Ordre d'exécution logique`,
    memoire:             `GUIDE — MÉMOIRE\n- Confirmer ce qui est retenu\n- Intégrer dans le contexte des prochains échanges\n- Proposer comment exploiter cette info concrètement`,
    recap:               `GUIDE — RÉCAPITULATIF\n- Synthèse via profil + mémoire\n- Points forts, points faibles, priorités\n- 3 actions prioritaires basées sur l'état actuel`,
    decision:            `GUIDE — DÉCISION\n- Comparaison avec critères concrets\n- Recommandation claire et assumée\n- Pourquoi cette option · Risques de chaque choix`,
    redaction:           `GUIDE — RÉDACTION\n- Texte prêt à copier-coller\n- Ton adapté au contexte\n- Objet si email, hook si post · Concis et impactant`,
    automatisation:      `GUIDE — AUTOMATISATION\n- Étapes claires du workflow\n- Outils à connecter (Make, Zapier, Notion...)\n- Logique si/alors précise · Temps gagné estimé`,
  };
  return guides[intent] ? `\n${guides[intent]}\n` : "";
}

// ═══════════════════════════════════════════════════════════
// ⭐ ROUTER IA MODIFIÉ POUR UTILISER LES MESSAGES ⭐
// ═══════════════════════════════════════════════════════════

async function runRouter({ intent, messages, geminiKey, groqKey, isLong }) {
  const complexIntents = ["acquisition_clients", "generation_offre", "analyse_business", "decision", "recap", "analyse_document", "automatisation"];
  const geminiFirst    = complexIntents.includes(intent) || isLong;
  const providers      = geminiFirst ? ["gemini", "groq"] : ["groq", "gemini"];
  let lastError        = null;

  for (const p of providers) {
    try {
      if (p === "gemini" && geminiKey) {
        const reply = await callGemini(messages, geminiKey, isLong);
        if (reply) return { reply, provider: "gemini" };
      }
      if (p === "groq" && groqKey) {
        const reply = await callGroq(messages, groqKey);
        if (reply) return { reply, provider: "groq" };
      }
    } catch (err) { lastError = err; }
  }

  throw new Error(lastError?.message || "Aucun fournisseur IA disponible.");
}

// ═══════════════════════════════════════════════════════════
// ⭐ APPEL GEMINI AVEC MESSAGES ⭐
// ═══════════════════════════════════════════════════════════

async function callGemini(messages, apiKey, isLong = false) {
  // Gemini attend un tableau "contents" avec role user/model
  const contents = messages.map(msg => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }]
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: isLong ? 3000 : 1800
        }
      })
    }
  );

  if (res.status === 429) throw new Error("Gemini quota atteint.");
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ═══════════════════════════════════════════════════════════
// ⭐ APPEL GROQ AVEC MESSAGES ⭐
// ═══════════════════════════════════════════════════════════

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.85,
      max_tokens: 2000,
      messages: messages
    })
  });

  if (res.status === 429) throw new Error("Groq quota atteint.");
  if (!res.ok) throw new Error(`Groq error ${res.status}`);

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}