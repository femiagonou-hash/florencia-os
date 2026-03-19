// ============================================================
// FLORENCIA OS — api/chat.js — Version Supabase + Plans
// Free / Pro / Elite · Mémoire longue · PDF · Rapport Elite
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Variables d'environnement ─────────────────────────────
const SUPABASE_URL     = process.env.SUPABASE_URL             || "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

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
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    const GROQ_API_KEY   = process.env.GROQ_API_KEY   || "";
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
    const IPINFO_API_KEY = process.env.IPINFO_API_KEY || "";

    // ── Authentification Supabase ─────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const userToken  = authHeader.replace("Bearer ", "").trim();

    let userId   = null;
    let userPlan = "free";
    let sbClient = null;

    if (SUPABASE_URL && SUPABASE_SERVICE && userToken) {
      sbClient = createClient(SUPABASE_URL, SUPABASE_SERVICE);

      const { data: authData } = await sbClient.auth.getUser(userToken);
      if (authData?.user) {
        userId = authData.user.id;

        const { data: profile } = await sbClient
          .from("profiles")
          .select("plan, trial_ends_at")
          .eq("id", userId)
          .single();

        if (profile) {
          // Trial Elite actif ?
          const trialActive = profile.trial_ends_at
            ? new Date(profile.trial_ends_at) > new Date()
            : false;

          userPlan = trialActive ? "elite" : (profile.plan || "free");
        }
      }
    }

    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

    // ── Limite quotidienne (Free uniquement) ──────────────
    if (planLimits.messagesPerDay > 0 && userId && sbClient) {
      const todayDate = today();

      const { data: usage } = await sbClient
        .from("usage")
        .select("messages_today, last_reset_date")
        .eq("user_id", userId)
        .single();

      if (usage) {
        // Reset si nouveau jour
        if (usage.last_reset_date !== todayDate) {
          await sbClient
            .from("usage")
            .update({ messages_today: 0, last_reset_date: todayDate })
            .eq("user_id", userId);
          usage.messages_today = 0;
        }

        if (usage.messages_today >= planLimits.messagesPerDay) {
          return jsonResponse(429, {
            error:      "daily_limit_reached",
            message:    `Tu as atteint ta limite de ${planLimits.messagesPerDay} messages aujourd'hui. Passe au plan Pro pour des messages illimités.`,
            plan:       userPlan,
            upgradeUrl: "/pricing.html"
          });
        }

        await sbClient
          .from("usage")
          .update({ messages_today: (usage.messages_today || 0) + 1 })
          .eq("user_id", userId);
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

    if (userId && sbClient && planLimits.memory === "long") {
      const { data: memRows } = await sbClient
        .from("memory")
        .select("key, value")
        .eq("user_id", userId);

      if (memRows?.length > 0) {
        const dbMemory = {};
        memRows.forEach(row => { dbMemory[row.key] = row.value; });
        memory = { ...dbMemory, ...memory }; // DB prime sur local
      }
    }

    // ── Analyse PDF (Pro+) ────────────────────────────────
    let pdfContext = null;
    if (pdfBase64 && planLimits.pdf && GEMINI_API_KEY) {
      pdfContext = await analyzePDF(pdfBase64, GEMINI_API_KEY);
    }

    // ── Détection d'intention ─────────────────────────────
    const intent = detectIntent(message, pdfContext);

    // ── Web & Local ───────────────────────────────────────
    const useWeb   = planLimits.webSearch && shouldUseWeb(message, intent);
    const useLocal = shouldUseLocal(message, intent, userProfile);

    let localContext = null;
    if (useLocal) {
      localContext = await getLocalContext({
        ip: userIp, token: IPINFO_API_KEY, userProfile
      });
    }

    let webContext = null;
    if (useWeb) {
      webContext = await searchWeb({
        query:  buildSearchQuery(message, userProfile, localContext),
        apiKey: TAVILY_API_KEY
      });
    }

    // ── Rapport hebdomadaire (Elite) ──────────────────────
    const isWeeklyReport = planLimits.report && containsOne(message.toLowerCase(), [
      "rapport", "rapport hebdo", "bilan semaine",
      "weekly report", "résumé semaine", "bilan de la semaine"
    ]);

    // ── Extraction mémoire ────────────────────────────────
    const extractedMemory = extractMemoryFromMessage(message, intent);

    // ── Construction du prompt ────────────────────────────
    const florenciaPrompt = buildFlorenciaPrompt({
      message, intent, userProfile, dailyCheckin,
      localContext, webContext, conversation,
      memory, extractedMemory, userPlan,
      pdfContext, isWeeklyReport
    });

    // ── Appel IA ──────────────────────────────────────────
    const isLong = isWeeklyReport || !!pdfContext;
    const result = await runRouter({
      intent, prompt: florenciaPrompt,
      geminiKey: GEMINI_API_KEY,
      groqKey:   GROQ_API_KEY,
      isLong
    });

    // ── Sauvegarde mémoire longue Supabase (Pro+) ─────────
    if (userId && sbClient && extractedMemory && planLimits.memory === "long") {
      const upserts = Object.entries(extractedMemory).map(([key, value]) => ({
        user_id:    userId,
        key,
        value:      String(value),
        updated_at: new Date().toISOString()
      }));

      if (upserts.length > 0) {
        await sbClient
          .from("memory")
          .upsert(upserts, { onConflict: "user_id,key" });
      }
    }

    // ── Sauvegarde conversation Supabase ──────────────────
    if (userId && sbClient && conversationId) {
      await sbClient.from("messages").insert([
        { conversation_id: conversationId, user_id: userId, role: "user",      content: message },
        { conversation_id: conversationId, user_id: userId, role: "assistant", content: result.reply }
      ]);
    }

    return jsonResponse(200, {
      reply:        result.reply,
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
              { text: "Analyse ce document de façon exhaustive. Extrais : les points clés, les chiffres importants, les décisions mentionnées, les actions requises et le contexte business global. Réponds en français, de façon structurée et actionnable." }
            ]
          }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// DÉTECTION D'INTENTION (12 catégories)
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
// WEB & LOCAL
// ═══════════════════════════════════════════════════════════

function shouldUseWeb(message, intent) {
  const t = message.toLowerCase();
  if (containsOne(t, [
    "aujourd'hui", "actuel", "maintenant", "tendance", "prix", "concurrence",
    "concurrent", "marché", "niche", "plateforme", "trouve-moi", "cherche",
    "recherche", "opportunité", "récent", "nouveautés", "2025", "2026"
  ])) return true;
  return ["acquisition_clients", "analyse_business", "generation_offre"].includes(intent);
}

function shouldUseLocal(message, intent, userProfile) {
  const t = message.toLowerCase();
  if (containsOne(t, [
    "dans mon pays", "dans ma ville", "local", "bénin", "france", "sénégal",
    "cotonou", "côte d'ivoire", "cameroun", "canada", "ville", "devise",
    "marché local", "réalité locale", "fcfa"
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
        ? data.results.slice(0, 5).map(r => ({ title: r.title || "", url: r.url || "", content: r.content || "" }))
        : []
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// EXTRACTION MÉMOIRE AUTOMATIQUE
// ═══════════════════════════════════════════════════════════

function extractMemoryFromMessage(message, intent) {
  const t       = message.toLowerCase();
  const updates = {};

  const revenueMatch = message.match(/(\d[\d\s]*)(€|euros?|fcfa|dollars?|k€|k\s*€|\$)/i);
  if (revenueMatch) {
    updates.lastMentionedRevenue = revenueMatch[0];
    updates.lastRevenueDate      = today();
  }

  const projectMatch = message.match(/(?:projet|app|application|service|produit|plateforme|startup)\s+["«]?([^"»\n,.]{3,50})["»]?/i);
  if (projectMatch) updates.lastProjectMentioned = projectMatch[1].trim();

  const nicheMatch = message.match(/(?:ma niche|mon marché|je cible|je travaille avec|mes clients sont)\s+([^.!?\n]{5,60})/i);
  if (nicheMatch) updates.lastNicheMentioned = nicheMatch[1].trim();

  if (containsOne(t, ["bloqué", "je n'arrive pas", "problème", "difficulté", "galère", "j'ai du mal", "coincé"])) {
    updates.lastBlocker     = message.slice(0, 150);
    updates.lastBlockerDate = today();
  }

  if (containsOne(t, ["j'ai décidé", "j'ai choisi", "je vais", "je pars sur", "j'opte pour", "on va faire"])) {
    updates.lastDecision     = message.slice(0, 150);
    updates.lastDecisionDate = today();
  }

  if (containsOne(t, ["j'ai un client", "nouveau client", "prospect intéressé", "j'ai signé", "nouveau contrat"])) {
    updates.lastClientMention = message.slice(0, 150);
    updates.lastClientDate    = today();
  }

  if (intent !== "general") {
    updates.lastIntent     = intent;
    updates.lastIntentDate = today();
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

// ═══════════════════════════════════════════════════════════
// PROMPT BUILDER
// ═══════════════════════════════════════════════════════════

function buildFlorenciaPrompt({
  message, intent, userProfile, dailyCheckin,
  localContext, webContext, conversation,
  memory, extractedMemory, userPlan,
  pdfContext, isWeeklyReport
}) {
  const recentConversation = conversation.length
    ? conversation.map(m => `${m.role === "user" ? "Utilisateur" : "Florencia"}: ${m.content}`).join("\n")
    : "Aucun historique récent.";

  const webBlock = webContext
    ? `CONTEXTE WEB TEMPS RÉEL\nSynthèse: ${webContext.answer || "Non disponible."}\n\nSources:\n${
        webContext.results.map((r, i) => `${i + 1}. ${r.title}\n${r.content}\n${r.url}`).join("\n\n")
      }`
    : "";

  const memKeys = Object.keys(memory);
  const memoryBlock = memKeys.length > 0
    ? `MÉMOIRE LONG TERME — CE QUE TU SAIS DÉJÀ
- Revenu mentionné   : ${memory.lastMentionedRevenue || "—"} (${memory.lastRevenueDate || ""})
- Projet mentionné   : ${memory.lastProjectMentioned || "—"}
- Niche / marché     : ${memory.lastNicheMentioned   || "—"}
- Dernier blocage    : ${memory.lastBlocker          || "—"} (${memory.lastBlockerDate  || ""})
- Dernière décision  : ${memory.lastDecision         || "—"} (${memory.lastDecisionDate || ""})
- Dernier client     : ${memory.lastClientMention    || "—"} (${memory.lastClientDate   || ""})
- Dernière intention : ${memory.lastIntent           || "—"} (${memory.lastIntentDate   || ""})`
    : "MÉMOIRE : Première session — aucune donnée encore mémorisée.";

  const pdfBlock = pdfContext
    ? `\nDOCUMENT ANALYSÉ (PDF)\n${pdfContext}`
    : "";

  const intentGuide = getIntentGuide(intent, userPlan);

  const structureBlock = isWeeklyReport
    ? `════════════════════════════════════════
STRUCTURE DU RAPPORT HEBDOMADAIRE (ELITE)
════════════════════════════════════════
Génère un rapport business complet :

**BILAN DE LA SEMAINE**
Avancées notables, décisions prises, projets avancés.

**POINTS POSITIFS**
Ce qui fonctionne et doit être amplifié.

**POINTS D'ATTENTION**
Ce qui a bloqué ou ralenti — sans complaisance.

**MÉTRIQUES CLÉS**
Objectifs vs réalisé. Prospects contactés. Tâches terminées.

**PRIORITÉS SEMAINE PROCHAINE**
Les 3 actions les plus importantes à venir.

**CONSEIL STRATÉGIQUE**
Un insight business précis sur la situation actuelle.`
    : `════════════════════════════════════════
STRUCTURE DE RÉPONSE
════════════════════════════════════════
Réponds dans cet ordre exact :

**DIAGNOSTIC**
Nomme le vrai enjeu. Ne reformule pas. Chirurgical.

**RÉPONSE**
Direct, utile, adapté au profil. Va droit au but.

**PLAN D'ACTION**
3 à 5 étapes numérotées. Chaque étape = verbe d'action fort.

**PROCHAINE ÉTAPE**
Une seule chose. La plus importante. Dans les prochaines heures.`;

  return `Tu es Florencia OS.

════════════════════════════════════════
IDENTITÉ
════════════════════════════════════════
Florencia OS est un Business Operating System pour freelances, indépendants, créateurs, consultants et solo-entrepreneurs.

Tu n'es pas un chatbot. Tu es un copilote business de haut niveau.
Tu combines quatre rôles :
- Stratège business : tu vois clair là où l'utilisateur est dans le flou
- Système d'aide à la décision : tu priorises ce qui compte vraiment
- Assistant de structuration : tu transformes les idées floues en plans concrets
- Moteur d'action : tu pousses vers l'avancement réel, pas le confort intellectuel

════════════════════════════════════════
RÈGLES — NON NÉGOCIABLES
════════════════════════════════════════
- Tutoiement. Toujours. Sans exception.
- Français naturel, moderne, fluide. Comme un associé brillant qui parle cash.
- Direct, net, précis. Zéro blabla. Zéro remplissage.
- Pas de "Bien sûr !", "Absolument !", "Excellente question !", "Je comprends ta situation".
- Tu ne sonnes jamais comme une IA qui récite un manuel.
- Tu ne répètes pas le contexte que l'utilisateur vient de donner.
- Ton calme, lucide, stratégique, humain et premium.
- Tu ne mentionnes jamais les fournisseurs IA, modèles ou limites techniques.
- Si une info manque : une phrase, puis action.
- Tu utilises la mémoire — jamais des questions déjà répondues.

════════════════════════════════════════
RAISONNEMENT
════════════════════════════════════════
1. Comprendre l'objectif réel — le vrai besoin derrière les mots
2. Identifier le blocage sous-jacent
3. Analyser vite et avec précision
4. Répondre clairement et utilement
5. Transformer en plan concret numéroté
6. Donner la prochaine étape prioritaire

${intentGuide}

════════════════════════════════════════
CONTEXTE OPÉRATIONNEL
════════════════════════════════════════

PLAN : ${userPlan.toUpperCase()}${userPlan === "elite" ? " (trial actif — accès complet)" : ""}

PROFIL
- Métier           : ${userProfile.job          || "non renseigné"}
- Niche            : ${userProfile.niche         || memory.lastNicheMentioned   || "non renseignée"}
- Offre principale : ${userProfile.offer         || "non renseignée"}
- Objectif revenu  : ${userProfile.revenueGoal   || memory.lastMentionedRevenue || "non renseigné"}
- Pays             : ${userProfile.country       || localContext?.country || "non renseigné"}
- Ville            : ${userProfile.city          || localContext?.city    || "non renseignée"}
- Devise           : ${userProfile.currency      || "non renseignée"}

CHECK-IN DU JOUR
- Objectif : ${dailyCheckin.goal    || "non renseigné"}
- Focus    : ${dailyCheckin.focus   || "non renseigné"}
- Blocage  : ${dailyCheckin.blocker || "aucun"}
- Note     : ${dailyCheckin.note    || "—"}

LOCALISATION
- Pays   : ${localContext?.country  || userProfile.country  || "non renseigné"}
- Ville  : ${localContext?.city     || userProfile.city     || "non renseignée"}
- Fuseau : ${localContext?.timezone || "non renseigné"}

${memoryBlock}
${webBlock ? "\n" + webBlock : ""}
${pdfBlock}

HISTORIQUE RÉCENT
${recentConversation}

INTENTION : ${intent}

════════════════════════════════════════
MESSAGE
════════════════════════════════════════
${message}

${structureBlock}`;
}

// ═══════════════════════════════════════════════════════════
// GUIDES PAR INTENTION
// ═══════════════════════════════════════════════════════════

function getIntentGuide(intent) {
  const guides = {
    acquisition_clients: `
GUIDE — ACQUISITION CLIENTS
Aide l'utilisateur à trouver et convaincre des clients réels.
- Scripts de prospection adaptés à son marché et sa cible
- Canaux pertinents selon le contexte local
- Templates directement utilisables
- Objectifs chiffrés (ex: 10 prospects/semaine)
- Relances si besoin`,

    generation_offre: `
GUIDE — GÉNÉRATION D'OFFRE
Structure une offre claire, désirable et vendable.
- Nom, contenu, prix
- Promesse de transformation concrète
- Format adapté au marché local et à la devise
- Objections probables + réponses
- Structure de présentation clé en main`,

    creation_contenu: `
GUIDE — CRÉATION DE CONTENU
Contenu qui attire et convertit, pas juste des vues.
- Sujets adaptés à la niche et l'audience
- Scripts, hooks, titres, structures de posts
- Ton adapté à la plateforme (LinkedIn, TikTok, Instagram...)
- Calendrier éditorial si demandé`,

    gestion_projets: `
GUIDE — GESTION DE PROJETS
Organiser, prioriser, avancer.
- Décomposer en tâches actionnables
- Identifier les blocages et les lever
- Planning réaliste avec deadlines
- Urgent vs important vs délégable`,

    analyse_business: `
GUIDE — ANALYSE BUSINESS
Voir clair et décider mieux.
- Leviers de croissance les plus rapides
- Comparaison d'options avec critères chiffrés
- Métriques simples à suivre
- Avis tranché quand une décision s'impose
- Données web pour contextualiser`,

    analyse_document: `
GUIDE — ANALYSE DE DOCUMENT
Extraire l'essentiel, pas tout reformuler.
- Points clés et chiffres importants
- Décisions et actions requises
- Risques ou opportunités cachés
- Répondre à la question en s'appuyant sur le document
- Plan d'action si pertinent`,

    priorites_jour: `
GUIDE — PRIORITÉS DU JOUR
Les bonnes actions, dans le bon ordre.
- Check-in + mémoire pour prioriser intelligemment
- Max 3 actions prioritaires
- Urgent vs important
- Tâches en retard ou suivis en attente
- Ordre d'exécution logique`,

    memoire: `
GUIDE — MÉMOIRE
Retenir et exploiter.
- Confirmer ce qui est retenu
- Intégrer dans le contexte des prochains échanges
- Proposer comment exploiter cette info concrètement`,

    recap: `
GUIDE — RÉCAPITULATIF
Bilan clair, cap net.
- Synthèse via profil + mémoire
- Points forts, points faibles, priorités
- Vision claire de où il en est et où aller
- 3 actions prioritaires basées sur l'état actuel`,

    decision: `
GUIDE — DÉCISION
Un avis tranché, pas du "ça dépend".
- Questions si info manquante
- Comparaison avec critères concrets
- Recommandation claire et assumée
- Pourquoi cette option
- Risques de chaque choix`,

    redaction: `
GUIDE — RÉDACTION
Texte prêt à copier-coller.
- Rédiger directement, sans introduction
- Ton adapté au contexte
- Objet si email, hook si post
- Variante si pertinent
- Concis et impactant`,

    automatisation: `
GUIDE — AUTOMATISATION (Elite)
Workflow concret, pas théorique.
- Étapes claires du workflow
- Outils à connecter (Make, Zapier, Notion...)
- Logique si/alors précise
- Temps gagné estimé
- Automatisations prioritaires : fort impact, faible complexité`,
  };

  return guides[intent] ? `\n${guides[intent]}\n` : "";
}

// ═══════════════════════════════════════════════════════════
// ROUTER IA — Gemini + Groq avec fallback
// ═══════════════════════════════════════════════════════════

async function runRouter({ intent, prompt, geminiKey, groqKey, isLong }) {
  const complexIntents = [
    "acquisition_clients", "generation_offre", "analyse_business",
    "decision", "recap", "analyse_document", "automatisation"
  ];

  const geminiFirst = complexIntents.includes(intent) || isLong;
  const providers   = geminiFirst ? ["gemini", "groq"] : ["groq", "gemini"];

  let lastError = null;

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
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(lastError?.message || "Aucun fournisseur IA disponible.");
}

// ═══════════════════════════════════════════════════════════
// GEMINI
// ═══════════════════════════════════════════════════════════

async function callGemini(prompt, apiKey, isLong = false) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.72,
          maxOutputTokens: isLong ? 3000 : 1800
        }
      })
    }
  );

  if (res.status === 429) throw new Error("Gemini quota atteint.");
  if (!res.ok)           throw new Error(`Gemini error ${res.status}`);

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ═══════════════════════════════════════════════════════════
// GROQ
// ═══════════════════════════════════════════════════════════

async function callGroq(prompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.72,
      max_tokens:  2000,
      messages:    [{ role: "user", content: prompt }]
    })
  });

  if (res.status === 429) throw new Error("Groq quota atteint.");
  if (!res.ok)           throw new Error(`Groq error ${res.status}`);

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}
