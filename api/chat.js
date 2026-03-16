// ============================================================
// FLORENCIA OS — api/chat.js — Version Business OS Complète
// ============================================================

export async function POST(request) {
  try {
    const body = await safeJson(request);
    const message = String(body.message || "").trim();

    if (!message) {
      return jsonResponse(400, { error: "Message utilisateur manquant." });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    const GROQ_API_KEY   = process.env.GROQ_API_KEY   || "";
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
    const IPINFO_API_KEY = process.env.IPINFO_API_KEY || "";

    const userProfile  = body.userProfile  || {};
    const dailyCheckin = body.dailyCheckin || {};
    const memory       = body.memory       || {};
    const conversation = Array.isArray(body.conversation)
      ? body.conversation.slice(-10)
      : [];

    const userIp =
      body.userIp ||
      extractIp(request.headers.get("x-forwarded-for")) ||
      extractIp(request.headers.get("x-real-ip")) ||
      "";

    const intent   = detectIntent(message);
    const useWeb   = shouldUseWeb(message, intent);
    const useLocal = shouldUseLocal(message, intent, userProfile);

    let localContext = null;
    if (useLocal) {
      localContext = await getLocalContext({
        ip: userIp,
        token: IPINFO_API_KEY,
        userProfile
      });
    }

    let webContext = null;
    if (useWeb) {
      webContext = await searchWeb({
        query: buildSearchQuery(message, userProfile, localContext),
        apiKey: TAVILY_API_KEY
      });
    }

    const extractedMemory = extractMemoryFromMessage(message, intent);

    const florenciaPrompt = buildFlorenciaPrompt({
      message,
      intent,
      userProfile,
      dailyCheckin,
      localContext,
      webContext,
      conversation,
      memory,
      extractedMemory
    });

    const result = await runRouter({
      intent,
      prompt:    florenciaPrompt,
      geminiKey: GEMINI_API_KEY,
      groqKey:   GROQ_API_KEY
    });

    return jsonResponse(200, {
      reply:        result.reply,
      provider:     result.provider,
      intent,
      usedWeb:      !!webContext,
      usedLocal:    !!localContext,
      memoryUpdate: extractedMemory
    });

  } catch (error) {
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

// =========================
// OUTILS GÉNÉRAUX
// =========================

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

async function safeJson(request) {
  try { return await request.json(); }
  catch { return {}; }
}

function extractIp(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.split(",")[0].trim();
}

// =========================
// ANALYSE D'INTENTION
// =========================

function detectIntent(message) {
  const text = message.toLowerCase();

  if (containsOne(text, [
    "client", "prospect", "prospection", "acquisition", "lead",
    "cold email", "trouver des clients", "messages de prospection"
  ])) return "acquisition_clients";

  if (containsOne(text, [
    "offre", "positionnement", "promesse", "proposition de valeur",
    "prix", "tarif", "pricing"
  ])) return "generation_offre";

  if (containsOne(text, [
    "contenu", "youtube", "script", "post", "publication",
    "calendrier éditorial", "idées de contenu"
  ])) return "creation_contenu";

  if (containsOne(text, [
    "projet", "organisation", "tâches", "deadline",
    "workflow", "plan d'action"
  ])) return "gestion_projets";

  if (containsOne(text, [
    "revenu", "analyse", "performance", "optimisation",
    "croissance", "business plan"
  ])) return "analyse_business";

  if (containsOne(text, [
    "priorité", "priorités", "aujourd'hui", "cette semaine",
    "focus", "quoi faire", "par où commencer"
  ])) return "priorites_jour";

  if (containsOne(text, [
    "rappel", "n'oublie pas", "souviens-toi", "retiens",
    "mémorise", "note bien"
  ])) return "memoire";

  if (containsOne(text, [
    "récap", "résumé", "où j'en suis", "bilan",
    "synthèse", "état des lieux"
  ])) return "recap";

  if (containsOne(text, [
    "décision", "je dois choisir", "que faire", "conseil",
    "ton avis", "recommande"
  ])) return "decision";

  return "general";
}

function containsOne(text, keywords) {
  return keywords.some((word) => text.includes(word));
}

// =========================
// DÉCISIONS WEB / LOCAL
// =========================

function shouldUseWeb(message, intent) {
  const text = message.toLowerCase();
  if (containsOne(text, [
    "aujourd'hui", "actuel", "actuelle", "maintenant", "tendance",
    "prix", "concurrence", "concurrent", "marché", "niche",
    "plateforme", "trouve-moi", "cherche", "recherche", "opportunité"
  ])) return true;
  return ["acquisition_clients", "analyse_business"].includes(intent);
}

function shouldUseLocal(message, intent, userProfile) {
  const text = message.toLowerCase();
  if (containsOne(text, [
    "dans mon pays", "dans ma ville", "local", "bénin", "france",
    "sénégal", "cotonou", "ville", "devise", "marché local", "réalité locale"
  ])) return true;
  if (userProfile.country || userProfile.city || userProfile.currency) return true;
  return ["acquisition_clients", "generation_offre", "analyse_business"].includes(intent);
}

// =========================
// EXTRACTION MÉMOIRE
// =========================

function extractMemoryFromMessage(message, intent) {
  const text = message.toLowerCase();
  const updates = {};

  // Détection revenus / objectifs financiers
  const revenueMatch = message.match(/(\d[\d\s]*)(€|euros?|fcfa|dollars?|k€|k\s*€)/i);
  if (revenueMatch) {
    updates.lastMentionedRevenue = revenueMatch[0];
    updates.lastRevenueDate = new Date().toISOString().split("T")[0];
  }

  // Détection de projets mentionnés
  if (containsOne(text, ["projet", "app", "application", "service", "produit", "plateforme"])) {
    const projectMatch = message.match(/(?:projet|app|application|service|produit|plateforme)\s+["«]?([^"»\n,.]{3,40})["»]?/i);
    if (projectMatch) {
      updates.lastProjectMentioned = projectMatch[1].trim();
    }
  }

  // Détection de blocages
  if (containsOne(text, ["bloqué", "je n'arrive pas", "problème", "difficulté", "galère", "j'ai du mal"])) {
    updates.lastBlocker = message.slice(0, 120);
    updates.lastBlockerDate = new Date().toISOString().split("T")[0];
  }

  // Détection de décisions prises
  if (containsOne(text, ["j'ai décidé", "j'ai choisi", "je vais", "je pars sur", "j'opte pour"])) {
    updates.lastDecision = message.slice(0, 120);
    updates.lastDecisionDate = new Date().toISOString().split("T")[0];
  }

  // Détection de clients / prospects
  if (containsOne(text, ["j'ai un client", "nouveau client", "prospect intéressé", "j'ai signé"])) {
    updates.lastClientMention = message.slice(0, 120);
    updates.lastClientDate = new Date().toISOString().split("T")[0];
  }

  // Tag d'intention pour suivi
  if (intent !== "general") {
    updates.lastIntent = intent;
    updates.lastIntentDate = new Date().toISOString().split("T")[0];
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

// =========================
// CONTEXTE LOCAL
// =========================

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
    const response = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!response.ok) return fallback;
    const data = await response.json();
    return {
      country:  fallback.country  || data.country  || "",
      city:     fallback.city     || data.city      || "",
      currency: fallback.currency || "",
      language: fallback.language || "fr",
      timezone: fallback.timezone || data.timezone  || ""
    };
  } catch {
    return fallback;
  }
}

// =========================
// WEB TEMPS RÉEL
// =========================

function buildSearchQuery(message, userProfile, localContext) {
  const country = userProfile.country || localContext?.country || "";
  const city    = userProfile.city    || localContext?.city    || "";
  return [message, city, country].filter(Boolean).join(" | ");
}

async function searchWeb({ query, apiKey }) {
  if (!apiKey) return null;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key:      apiKey,
        query,
        search_depth: "basic",
        max_results:  5
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      answer:  data.answer || "",
      results: Array.isArray(data.results)
        ? data.results.slice(0, 5).map((item) => ({
            title:   item.title   || "",
            url:     item.url     || "",
            content: item.content || ""
          }))
        : []
    };
  } catch {
    return null;
  }
}

// =========================
// PROMPT BUILDER
// =========================

function buildFlorenciaPrompt({
  message,
  intent,
  userProfile,
  dailyCheckin,
  localContext,
  webContext,
  conversation,
  memory,
  extractedMemory
}) {
  // Historique conversation
  const recentConversation = conversation.length
    ? conversation
        .map((msg) => `- ${msg.role || "user"}: ${msg.content || ""}`)
        .join("\n")
    : "Aucun historique récent.";

  // Bloc web
  const webBlock = webContext
    ? `CONTEXTE WEB TEMPS RÉEL\nSynthèse : ${webContext.answer || "Non disponible."}\n\nSources :\n${
        webContext.results
          .map((r, i) => `${i + 1}. ${r.title}\n${r.content}\n${r.url}`)
          .join("\n\n")
      }`
    : "CONTEXTE WEB : Aucune donnée web pour cette requête.";

  // Bloc mémoire long terme
  const memoryBlock = Object.keys(memory).length > 0
    ? `MÉMOIRE LONG TERME — CE QUE TU SAIS DÉJÀ SUR CET UTILISATEUR
- Dernier revenu mentionné : ${memory.lastMentionedRevenue || "non renseigné"} (${memory.lastRevenueDate || ""})
- Dernier projet mentionné : ${memory.lastProjectMentioned || "non renseigné"}
- Dernier blocage signalé : ${memory.lastBlocker || "aucun"} (${memory.lastBlockerDate || ""})
- Dernière décision prise : ${memory.lastDecision || "aucune"} (${memory.lastDecisionDate || ""})
- Dernier client mentionné : ${memory.lastClientMention || "aucun"} (${memory.lastClientDate || ""})
- Dernière intention détectée : ${memory.lastIntent || "non renseignée"} (${memory.lastIntentDate || ""})`
    : "MÉMOIRE LONG TERME : Première session — aucune donnée mémorisée encore.";

  // Bloc intention spéciale
  const intentGuide = getIntentGuide(intent);

  return `
Tu es Florencia OS.

════════════════════════════════════════
IDENTITÉ
════════════════════════════════════════
Florencia OS est un Business Operating System conçu pour les freelances, indépendants, créateurs, consultants et solo-entrepreneurs.

Tu n'es pas un chatbot. Tu es un copilote business de haut niveau.
Tu combines quatre rôles :
- Stratège business : tu vois clair là où l'utilisateur est dans le flou
- Système d'aide à la décision : tu priorises ce qui compte vraiment
- Assistant de structuration : tu transformes les idées floues en plans concrets
- Moteur d'action : tu pousses vers l'avancement réel, pas le confort intellectuel

════════════════════════════════════════
RÈGLES DE COMMUNICATION — NON NÉGOCIABLES
════════════════════════════════════════
- Tu tutoies toujours l'utilisateur. Sans exception.
- Tu parles en français naturel, moderne et fluide. Comme un associé brillant qui parle cash.
- Tu es direct, net, précis. Zéro blabla. Zéro remplissage.
- Pas de "Bien sûr !", "Absolument !", "Excellente question !", "Je comprends ta situation".
- Tu ne sonnes jamais comme une IA qui récite un manuel.
- Tu ne répètes pas inutilement le contexte que l'utilisateur vient de donner.
- Tu gardes un ton calme, lucide, stratégique, humain et premium.
- Tu ne mentionnes jamais les fournisseurs IA, les modèles ou les limites techniques.
- Si une info manque, tu le dis en une phrase, puis tu passes à l'action la plus utile.
- Tu utilises la mémoire long terme pour personnaliser chaque réponse — ne pose pas des questions déjà répondues.

════════════════════════════════════════
LOGIQUE DE RAISONNEMENT
════════════════════════════════════════
Pour chaque message :
1. Comprendre l'objectif réel — pas juste les mots, le vrai besoin
2. Identifier le vrai blocage sous-jacent
3. Analyser rapidement et précisément
4. Apporter une réponse claire et immédiatement utile
5. Transformer en plan d'action concret et numéroté
6. Donner la prochaine étape prioritaire à exécuter maintenant

${intentGuide}

════════════════════════════════════════
CONTEXTE OPÉRATIONNEL
════════════════════════════════════════

INTENTION DÉTECTÉE : ${intent}

PROFIL UTILISATEUR
- Métier           : ${userProfile.job         || "non renseigné"}
- Niche            : ${userProfile.niche        || "non renseignée"}
- Offre principale : ${userProfile.offer        || "non renseignée"}
- Objectif revenu  : ${userProfile.revenueGoal  || "non renseigné"}
- Pays             : ${userProfile.country      || localContext?.country || "non renseigné"}
- Ville            : ${userProfile.city         || localContext?.city    || "non renseignée"}
- Devise           : ${userProfile.currency     || localContext?.currency || "non renseignée"}
- Langue           : ${userProfile.language     || localContext?.language || "fr"}

CHECK-IN DU JOUR
- Objectif du jour : ${dailyCheckin.goal    || "non renseigné"}
- Focus principal  : ${dailyCheckin.focus   || "non renseigné"}
- Blocage actuel   : ${dailyCheckin.blocker || "non renseigné"}
- Note libre       : ${dailyCheckin.note    || "non renseignée"}

CONTEXTE LOCAL
- Pays      : ${localContext?.country  || userProfile.country  || "non renseigné"}
- Ville     : ${localContext?.city     || userProfile.city     || "non renseignée"}
- Fuseau    : ${localContext?.timezone || userProfile.timezone || "non renseigné"}

${memoryBlock}

${webBlock}

HISTORIQUE RÉCENT
${recentConversation}

════════════════════════════════════════
MESSAGE DE L'UTILISATEUR
════════════════════════════════════════
${message}

════════════════════════════════════════
STRUCTURE DE RÉPONSE OBLIGATOIRE
════════════════════════════════════════
Réponds impérativement dans cet ordre exact :

**DIAGNOSTIC**
Analyse rapide et chirurgicale. Nomme le vrai enjeu ou blocage. Ne reformule pas la question. Sois précis.

**RÉPONSE**
Ta réponse directe, claire, utile. Va droit au but. Adapte au profil, au contexte local et aux données web si disponibles.

**PLAN D'ACTION**
3 à 5 étapes concrètes, numérotées, applicables immédiatement. Chaque étape commence par un verbe d'action fort.

**PROCHAINE ÉTAPE**
Une seule chose. La plus importante. Ce que l'utilisateur doit faire dans les prochaines heures.

Règles :
- Réponses nettes et courtes
- Ne répète pas le contexte
- Orienté avancement business, pas théorie
`;
}

// =========================
// GUIDES PAR INTENTION
// =========================

function getIntentGuide(intent) {
  const guides = {
    acquisition_clients: `
GUIDE ACQUISITION CLIENTS
Tu aides l'utilisateur à trouver et convaincre des clients réels.
- Propose des messages de prospection adaptés à son marché et sa cible
- Utilise le contexte local pour suggérer des canaux pertinents
- Donne des scripts ou templates directement utilisables
- Chiffre les objectifs quand c'est possible (ex: 10 prospects/semaine)`,

    generation_offre: `
GUIDE GÉNÉRATION D'OFFRE
Tu aides à structurer une offre claire, désirable et vendable.
- Aide à nommer l'offre, définir ce qu'elle inclut et son prix
- Propose une promesse de transformation concrète
- Suggère un format de présentation adapté au marché local
- Identifie les objections probables et comment y répondre`,

    creation_contenu: `
GUIDE CRÉATION DE CONTENU
Tu aides à créer du contenu qui attire et convertit.
- Propose des idées de sujets adaptés à sa niche et audience
- Génère des scripts, hooks, titres ou structures de posts
- Adapte le ton et le format à la plateforme visée
- Oriente vers du contenu qui génère des leads, pas juste des vues`,

    gestion_projets: `
GUIDE GESTION DE PROJETS
Tu aides à organiser, prioriser et avancer sur les projets business.
- Décompose les grands projets en tâches actionnables
- Identifie les tâches bloquantes et propose comment les débloquer
- Propose un planning réaliste avec des deadlines concrètes
- Alerte sur ce qui est urgent vs important`,

    analyse_business: `
GUIDE ANALYSE BUSINESS
Tu aides à analyser la situation business et prendre de meilleures décisions.
- Identifie les leviers de croissance les plus rapides
- Compare les options avec des critères clairs
- Propose des métriques simples à suivre
- Donne un avis tranché quand une décision doit être prise`,

    priorites_jour: `
GUIDE PRIORITÉS DU JOUR
Tu aides à définir les 3 actions les plus importantes à faire aujourd'hui.
- Utilise le check-in du jour et la mémoire pour prioriser intelligemment
- Distingue urgent vs important
- Propose un ordre d'exécution logique
- Rappelle les tâches en retard ou les suivis en attente`,

    memoire: `
GUIDE MÉMOIRE
L'utilisateur veut que tu retiennes quelque chose d'important.
- Confirme clairement ce que tu as retenu
- Intègre cette information dans le contexte pour les prochains échanges
- Propose comment exploiter cette info pour avancer`,

    recap: `
GUIDE RÉCAPITULATIF
L'utilisateur veut un bilan de sa situation business.
- Synthétise ce que tu sais de lui via le profil et la mémoire
- Identifie les points forts, les points faibles et les priorités
- Donne une vision claire de où il en est et où aller ensuite`,

    decision: `
GUIDE DÉCISION
L'utilisateur doit prendre une décision et veut ton avis.
- Pose les bonnes questions si des infos manquent
- Compare les options avec des critères concrets
- Donne un avis tranché et assumé — pas de "ça dépend" sans raison
- Explique clairement pourquoi tu recommandes cette option`,
  };

  return guides[intent] || "";
}

// =========================
// ROUTER IA
// =========================

async function runRouter({ intent, prompt, geminiKey, groqKey }) {
  const strategicIntents = [
    "acquisition_clients",
    "generation_offre",
    "analyse_business",
    "decision",
    "recap"
  ];

  const providers = strategicIntents.includes(intent)
    ? ["gemini", "groq"]
    : ["groq", "gemini"];

  let lastError = null;

  for (const provider of providers) {
    try {
      if (provider === "gemini" && geminiKey) {
        const reply = await callGemini(prompt, geminiKey);
        if (reply) return { reply, provider: "gemini" };
      }
      if (provider === "groq" && groqKey) {
        const reply = await callGroq(prompt, groqKey);
        if (reply) return { reply, provider: "groq" };
      }
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  throw new Error(lastError?.message || "Aucun fournisseur IA disponible.");
}

// =========================
// GEMINI
// =========================

async function callGemini(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 1500
        }
      })
    }
  );

  if (response.status === 429) throw new Error("Gemini quota atteint.");
  if (!response.ok)           throw new Error(`Gemini error ${response.status}`);

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// =========================
// GROQ
// =========================

async function callGroq(prompt, apiKey) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens:  1500,
      messages:    [{ role: "user", content: prompt }]
    })
  });

  if (response.status === 429) throw new Error("Groq quota atteint.");
  if (!response.ok)            throw new Error(`Groq error ${response.status}`);

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}
