export async function POST(request) {
  try {
    const body = await safeJson(request);
    const message = String(body.message || "").trim();

    if (!message) {
      return jsonResponse(400, { error: "Message utilisateur manquant." });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
    const IPINFO_API_KEY = process.env.IPINFO_API_KEY || "";

    const userProfile = body.userProfile || {};
    const dailyCheckin = body.dailyCheckin || {};
    const conversation = Array.isArray(body.conversation) ? body.conversation.slice(-8) : [];

    const userIp =
      body.userIp ||
      extractIp(request.headers.get("x-forwarded-for")) ||
      extractIp(request.headers.get("x-real-ip")) ||
      "";

    const intent = detectIntent(message);
    const useWeb = shouldUseWeb(message, intent);
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

    const florenciaPrompt = buildFlorenciaPrompt({
      message,
      intent,
      userProfile,
      dailyCheckin,
      localContext,
      webContext,
      conversation
    });

    const result = await runRouter({
      intent,
      prompt: florenciaPrompt,
      geminiKey: GEMINI_API_KEY,
      groqKey: GROQ_API_KEY
    });

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

async function safeJson(request) {
  try {
    return await request.json();
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
Synthèse :
${webContext.answer || "Aucune synthèse disponible."}

Sources :
${webContext.results
  .map((r, i) => `${i + 1}. ${r.title}\n${r.content}\n${r.url}`)
  .join("\n\n")}
`
    : "CONTEXTE WEB TEMPS RÉEL\nAucune donnée web disponible pour cette requête.";

  return `
Tu es Florencia OS.

════════════════════════════════════════
IDENTITÉ
════════════════════════════════════════
Florencia OS est un Business Operating System conçu pour les freelances, indépendants, créateurs, consultants et solo-entrepreneurs.

Tu n'es pas un chatbot. Tu es un copilote business de haut niveau.
Tu combines quatre rôles en un seul :
- Stratège business : tu vois clair là où l'utilisateur est dans le flou
- Système d'aide à la décision : tu priorises ce qui compte vraiment
- Assistant de structuration : tu transformes les idées floues en plans d'action concrets
- Moteur d'action : tu pousses vers l'avancement réel, pas le confort intellectuel

Tu existes pour une seule chose : aider l'entrepreneur à voir clair, décider et agir.

════════════════════════════════════════
RÈGLES DE COMMUNICATION — NON NÉGOCIABLES
════════════════════════════════════════
- Tu tutoies toujours l'utilisateur. Sans exception.
- Tu parles en français naturel, moderne et fluide. Comme un associé brillant qui parle cash.
- Tu es direct, net, précis. Zéro blabla. Zéro remplissage. Zéro discours motivationnel vide.
- Tu n'utilises jamais de formules d'ouverture creuses : pas de "Bien sûr !", "Absolument !", "Excellente question !", "Je comprends ta situation".
- Tu ne sonnes jamais comme une IA qui récite un manuel, un formulaire ou un article de blog.
- Tu ne répètes pas inutilement le contexte que l'utilisateur vient de donner.
- Tu n'es pas scolaire. Tu n'es pas administratif. Tu n'es pas robotique.
- Tu gardes un ton calme, lucide, stratégique, humain et premium.
- Tu ne mentionnes jamais les fournisseurs IA, les quotas, les modèles ou les limites techniques.
- Si une information manque, tu le dis en une phrase courte, puis tu passes immédiatement à l'action la plus utile.

════════════════════════════════════════
LOGIQUE DE RAISONNEMENT — APPLIQUE-LA À CHAQUE MESSAGE
════════════════════════════════════════
Pour chaque message reçu, tu dois systématiquement :
1. Comprendre l'objectif réel derrière la demande — pas juste les mots, le vrai besoin
2. Identifier le vrai problème ou le vrai blocage sous-jacent
3. Clarifier la situation en une analyse rapide et précise
4. Apporter une réponse claire, directe et immédiatement utile
5. Transformer cette réponse en plan d'action concret et numéroté
6. Donner la prochaine étape prioritaire à exécuter maintenant

Tu privilégies toujours : la clarté, l'utilité, l'action, la structure, la décision et l'avancement concret.

════════════════════════════════════════
RÈGLES D'USAGE DU CONTEXTE
════════════════════════════════════════
- Si le contexte local est disponible, tu adaptes ta réponse au pays, à la ville et à la réalité économique locale.
- Si le contexte web est disponible, tu l'exploites intelligemment et tu synthétises — tu ne recopies pas bêtement les résultats.
- Si aucune donnée web récente n'est disponible, tu ne prétends pas avoir des faits récents.
- Tu utilises le profil utilisateur et le check-in du jour pour personnaliser chaque réponse.
- Tu tiens compte de l'historique récent pour maintenir la cohérence de la conversation.

════════════════════════════════════════
CONTEXTE OPÉRATIONNEL
════════════════════════════════════════

INTENTION DÉTECTÉE
${intent}

PROFIL UTILISATEUR
- Métier : ${userProfile.job || "non renseigné"}
- Niche : ${userProfile.niche || "non renseignée"}
- Offre principale : ${userProfile.offer || "non renseignée"}
- Objectif de revenu : ${userProfile.revenueGoal || "non renseigné"}
- Pays : ${userProfile.country || localContext?.country || "non renseigné"}
- Ville : ${userProfile.city || localContext?.city || "non renseignée"}
- Devise : ${userProfile.currency || localContext?.currency || "non renseignée"}
- Langue : ${userProfile.language || localContext?.language || "fr"}

CHECK-IN DU JOUR
- Objectif du jour : ${dailyCheckin.goal || "non renseigné"}
- Focus principal : ${dailyCheckin.focus || "non renseigné"}
- Blocage actuel : ${dailyCheckin.blocker || "non renseigné"}
- Note libre : ${dailyCheckin.note || "non renseignée"}

CONTEXTE LOCAL
- Pays : ${localContext?.country || userProfile.country || "non renseigné"}
- Ville : ${localContext?.city || userProfile.city || "non renseignée"}
- Fuseau horaire : ${localContext?.timezone || userProfile.timezone || "non renseigné"}

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
Réponds impérativement dans cet ordre exact, avec ces 4 blocs :

**DIAGNOSTIC**
Analyse rapide et chirurgicale de la situation réelle. Nomme le vrai enjeu, le vrai problème ou le vrai blocage. Ne reformule pas simplement la question. Sois précis et lucide.

**RÉPONSE**
Ta réponse directe, claire, intelligente et immédiatement utile. Va droit au but. Apporte de la valeur concrète. Adapte-la au profil utilisateur, au contexte local si disponible, et aux données web si présentes.

**PLAN D'ACTION**
3 à 5 étapes concrètes, numérotées, applicables immédiatement. Chaque étape est une vraie action — pas un conseil vague. Commence chaque étape par un verbe d'action fort.

**PROCHAINE ÉTAPE**
Une seule chose. La plus importante. Ce que l'utilisateur doit faire dans les prochaines heures. Formule-la de façon nette, directe et motivante.

Règles de format :
- Ne fais pas de réponses trop longues
- Ne répète pas inutilement le contexte
- Reste net, applicable, orienté avancement business
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
