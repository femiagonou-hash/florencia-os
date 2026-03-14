exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Méthode non autorisée." });
    }

    const body = safeParse(event.body);
    const message = String(body.message || "").trim();

    if (!message) {
      return jsonResponse(400, { error: "Message utilisateur manquant." });
    }

    // === Variables d'environnement ===
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
    const IPINFO_API_KEY = process.env.IPINFO_API_KEY || "";

    // === Données utilisateur V1 ===
    const userProfile = body.userProfile || {};
    const dailyCheckin = body.dailyCheckin || {};
    const conversation = Array.isArray(body.conversation) ? body.conversation.slice(-8) : [];

    const userIp =
      body.userIp ||
      extractIp(event.headers["x-forwarded-for"]) ||
      extractIp(event.headers["client-ip"]) ||
      "";

    // === 1) Analyse d'intention ===
    const intent = detectIntent(message);

    // === 2) Décision : faut-il du web ? ===
    const useWeb = shouldUseWeb(message, intent);

    // === 3) Décision : faut-il du local ? ===
    const useLocal = shouldUseLocal(message, intent, userProfile);

    // === 4) Récupération contexte local ===
    let localContext = null;
    if (useLocal) {
      localContext = await getLocalContext({
        ip: userIp,
        token: IPINFO_API_KEY,
        userProfile
      });
    }

    // === 5) Récupération web temps réel ===
    let webContext = null;
    if (useWeb) {
      webContext = await searchWeb({
        query: buildSearchQuery(message, userProfile, localContext),
        apiKey: TAVILY_API_KEY
      });
    }

    // === 6) Construction du prompt Florencia ===
    const florenciaPrompt = buildFlorenciaPrompt({
      message,
      intent,
      userProfile,
      dailyCheckin,
      localContext,
      webContext,
      conversation
    });

    // === 7) Routage multi-modèles + fallback ===
    const result = await runRouter({
      intent,
      prompt: florenciaPrompt,
      geminiKey: GEMINI_API_KEY,
      groqKey: GROQ_API_KEY
    });

    // === 8) Réponse finale structurée ===
    return jsonResponse(200, {
      reply: result.reply,
      provider: result.provider,
      intent,
      usedWeb: !!webContext,
      usedLocal: !!localContext
    });

  } catch (error) {
    return jsonResponse(500, {
      error: "Erreur backend Florencia.",
      details: error.message
    });
  }
};

// =========================
// OUTILS GÉNÉRAUX
// =========================

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
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

  if (
    containsOne(text, [
      "client", "prospect", "prospection", "acquisition", "lead", "cold email",
      "trouver des clients", "messages de prospection"
    ])
  ) {
    return "acquisition_clients";
  }

  if (
    containsOne(text, [
      "offre", "positionnement", "promesse", "proposition de valeur", "prix",
      "tarif", "pricing"
    ])
  ) {
    return "generation_offre";
  }

  if (
    containsOne(text, [
      "contenu", "youtube", "script", "post", "publication", "calendrier éditorial",
      "idées de contenu"
    ])
  ) {
    return "creation_contenu";
  }

  if (
    containsOne(text, [
      "projet", "organisation", "tâches", "deadline", "workflow", "plan d'action"
    ])
  ) {
    return "gestion_projets";
  }

  if (
    containsOne(text, [
      "revenu", "analyse", "performance", "optimisation", "croissance", "business plan"
    ])
  ) {
    return "analyse_business";
  }

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

  if (
    containsOne(text, [
      "aujourd'hui", "actuel", "actuelle", "maintenant", "tendance", "tendances",
      "prix", "concurrence", "concurrent", "concurrents", "entreprise", "entreprises",
      "marché", "marches", "niche", "plateforme", "plateformes", "prospects",
      "trouve-moi", "cherche", "recherche", "local", "opportunité", "opportunités"
    ])
  ) {
    return true;
  }

  return ["acquisition_clients", "analyse_business"].includes(intent);
}

function shouldUseLocal(message, intent, userProfile) {
  const text = message.toLowerCase();

  if (
    containsOne(text, [
      "dans mon pays", "dans ma ville", "local", "bénin", "france", "sénégal",
      "cotonou", "ville", "devise", "marché local", "réalité locale"
    ])
  ) {
    return true;
  }

  if (userProfile.country || userProfile.city || userProfile.currency) {
    return true;
  }

  return ["acquisition_clients", "generation_offre", "analyse_business"].includes(intent);
}

// =========================
// CONTEXTE LOCAL
// =========================

async function getLocalContext({ ip, token, userProfile }) {
  const fallback = {
    country: userProfile.country || "",
    city: userProfile.city || "",
    currency: userProfile.currency || "",
    language: userProfile.language || "fr",
    timezone: userProfile.timezone || ""
  };

  if (!token || !ip) {
    return fallback;
  }

  try {
    const response = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!response.ok) return fallback;

    const data = await response.json();

    return {
      country: fallback.country || data.country || "",
      city: fallback.city || data.city || "",
      currency: fallback.currency || "",
      language: fallback.language || "fr",
      timezone: fallback.timezone || data.timezone || ""
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
  const city = userProfile.city || localContext?.city || "";

  return [message, city, country].filter(Boolean).join(" | ");
}

async function searchWeb({ query, apiKey }) {
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: 5
      })
    });

    if (!response.ok) return null;

    const data = await response.json();

    return {
      answer: data.answer || "",
      results: Array.isArray(data.results)
        ? data.results.slice(0, 5).map((item) => ({
            title: item.title || "",
            url: item.url || "",
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
  conversation
}) {
  const recentConversation = conversation.length
    ? conversation
        .map((msg) => `- ${msg.role || "user"}: ${msg.content || ""}`)
        .join("\n")
    : "Aucun historique récent.";

  const webBlock = webContext
    ? `
CONTEXTE WEB TEMPS RÉEL
Réponse synthétique web:
${webContext.answer || "Aucune synthèse."}

Résultats utiles:
${webContext.results
  .map((r, i) => `${i + 1}. ${r.title}\n${r.content}\n${r.url}`)
  .join("\n\n")}
`
    : "CONTEXTE WEB TEMPS RÉEL\nAucun contexte web utilisé.";

  return `
Tu es Florencia OS.
Tu n'es pas un simple chatbot.
Tu es un copilote business intelligent pour freelances, indépendants, créateurs et solo entrepreneurs.

MISSION
- Répondre de façon concrète, utile, stratégique et actionnable.
- Adapter la réponse au contexte local si disponible.
- Utiliser les informations web si elles sont présentes.
- Ne pas halluciner de faits récents si le contexte web est vide.
- Être clair, structuré, premium, sans jargon inutile.
- Ne pas parler des fournisseurs IA ni des quotas dans la réponse utilisateur.
- Ne pas dire que tu es en fallback.
- Si l'information manque, l'admettre proprement puis proposer l'action la plus utile.

INTENTION DÉTECTÉE
${intent}

PROFIL UTILISATEUR
- Métier: ${userProfile.job || "non renseigné"}
- Niche: ${userProfile.niche || "non renseignée"}
- Offre principale: ${userProfile.offer || "non renseignée"}
- Objectif revenu: ${userProfile.revenueGoal || "non renseigné"}
- Pays: ${userProfile.country || localContext?.country || "non renseigné"}
- Ville: ${userProfile.city || localContext?.city || "non renseignée"}
- Devise: ${userProfile.currency || localContext?.currency || "non renseignée"}
- Langue: ${userProfile.language || localContext?.language || "fr"}

CHECK-IN DU JOUR
- Objectif du jour: ${dailyCheckin.goal || "non renseigné"}
- Focus: ${dailyCheckin.focus || "non renseigné"}
- Blocage: ${dailyCheckin.blocker || "non renseigné"}
- Note libre: ${dailyCheckin.note || "non renseignée"}

CONTEXTE LOCAL
- Pays: ${localContext?.country || userProfile.country || "non renseigné"}
- Ville: ${localContext?.city || userProfile.city || "non renseignée"}
- Fuseau horaire: ${localContext?.timezone || userProfile.timezone || "non renseigné"}

${webBlock}

HISTORIQUE RÉCENT
${recentConversation}

MESSAGE UTILISATEUR
${message}

FORMAT DE RÉPONSE
- Commence par la réponse directe.
- Puis donne un mini plan d'action.
- Si utile, propose des exemples concrets.
- Si le sujet dépend du local, adapte à son pays/ville si possible.
- Si le sujet dépend du web et que le contexte web existe, exploite-le.
- Reste net, intelligent, fluide et business.
`;
}

// =========================
// ROUTER IA
// =========================

async function runRouter({ intent, prompt, geminiKey, groqKey }) {
  const strategicIntents = [
    "acquisition_clients",
    "generation_offre",
    "analyse_business"
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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    }
  );

  if (response.status === 429) {
    throw new Error("Gemini quota atteint.");
  }

  if (!response.ok) {
    throw new Error(`Gemini error ${response.status}`);
  }

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
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (response.status === 429) {
    throw new Error("Groq quota atteint.");
  }

  if (!response.ok) {
    throw new Error(`Groq error ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
  }
