// ============================================================
// FLORENCIA OS — api/chat.js
// Vercel Edge · Supabase REST · Plans Free/Pro
// Router IA : Gemma 4 → Gemini → Groq → DeepSeek (fallback)
// ============================================================

const PLAN_LIMITS = {
  free: { messagesPerDay: 50,  webSearch: false, pdf: false, memory: "short" },
  pro:  { messagesPerDay: -1,  webSearch: true,  pdf: true,  memory: "long"  }
};

export async function POST(request) {
  try {
    const body    = await safeJson(request);
    const message = String(body.message || "").trim();
    if (!message) return jsonResponse(400, { error: "Message manquant." });

    const GEMINI_API_KEY     = process.env.GEMINI_API_KEY            || "";
    const GROQ_API_KEY       = process.env.GROQ_API_KEY              || "";
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY        || "";
    const TAVILY_API_KEY     = process.env.TAVILY_API_KEY            || "";
    const IPINFO_API_KEY     = process.env.IPINFO_API_KEY            || "";
    const SUPABASE_URL       = process.env.SUPABASE_URL              || "";
    const SUPABASE_SERVICE   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    const lang      = detectLanguage(message);
    const userToken = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();

    let userId   = null;
    let userPlan = "free";

    if (SUPABASE_URL && SUPABASE_SERVICE && userToken) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { "Authorization": `Bearer ${userToken}`, "apikey": SUPABASE_SERVICE }
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          userId = userData?.id || null;
          if (userId) {
            const profileRes = await fetch(
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_actif`,
              { headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE } }
            );
            if (profileRes.ok) {
              const profile = (await profileRes.json())?.[0];
              if (profile) {
                userPlan = (profile.plan_actif === true && profile.plan === "pro") ? "pro" : "free";
              }
            }
          }
        }
      } catch (e) { console.warn("[Florencia] Auth:", e.message); }
    }

    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.free;

    // Limite quotidienne (Free)
    if (planLimits.messagesPerDay > 0 && userId && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const todayDate = today();
        const usageRes  = await fetch(
          `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&select=messages_today,last_reset_date`,
          { headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE } }
        );
        if (usageRes.ok) {
          const usage = (await usageRes.json())?.[0];
          if (usage) {
            let msgToday = usage.messages_today || 0;
            if (usage.last_reset_date !== todayDate) {
              msgToday = 0;
              await patchSupabase(SUPABASE_URL, SUPABASE_SERVICE,
                `usage?user_id=eq.${userId}`,
                { messages_today: 0, last_reset_date: todayDate }
              );
            }
            if (msgToday >= planLimits.messagesPerDay) {
              return jsonResponse(429, {
                error: "daily_limit_reached",
                message: getLimitMessage(lang, planLimits.messagesPerDay),
                plan: userPlan, upgradeUrl: "/pricing.html"
              });
            }
            await patchSupabase(SUPABASE_URL, SUPABASE_SERVICE,
              `usage?user_id=eq.${userId}`,
              { messages_today: msgToday + 1 }
            );
          }
        }
      } catch (e) { console.warn("[Florencia] Usage:", e.message); }
    }

    const userProfile    = body.userProfile    || {};
    const dailyCheckin   = body.dailyCheckin   || {};
    const conversationId = body.conversationId || null;
    const pdfBase64      = body.pdfContent     || null;
    const conversation   = Array.isArray(body.conversation) ? body.conversation.slice(-12) : [];
    const userIp         = body.userIp || extractIp(request.headers.get("x-forwarded-for")) || "";

    // Mémoire longue (Pro)
    let memory = body.memory || {};
    if (userId && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const memRes = await fetch(
          `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&select=key,value`,
          { headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE } }
        );
        if (memRes.ok) {
          const rows = await memRes.json();
          if (rows?.length > 0) {
            const db = {};
            rows.forEach(r => { db[r.key] = r.value; });
            memory = { ...db, ...memory };
          }
        }
      } catch (e) { console.warn("[Florencia] Memory fetch:", e.message); }
    }

    // Analyse PDF (Pro)
    let pdfContext = null;
    if (pdfBase64 && planLimits.pdf && GEMINI_API_KEY) {
      pdfContext = await analyzePDF(pdfBase64, GEMINI_API_KEY, lang);
    }

    const intent   = detectIntent(message, pdfContext);
    const useWeb   = planLimits.webSearch && shouldUseWeb(message, intent);
    const useLocal = shouldUseLocal(message, userProfile);

    let localContext = null;
    if (useLocal) localContext = await getLocalContext({ ip: userIp, token: IPINFO_API_KEY, userProfile });

    let webContext = null;
    if (useWeb && TAVILY_API_KEY) {
      webContext = await searchWeb({ query: buildSearchQuery(message, userProfile, localContext), apiKey: TAVILY_API_KEY });
    }

    const extractedMemory = extractMemoryFromMessage(message, intent);

    const prompt = buildFlorenciaPrompt({
      message, intent, userProfile, dailyCheckin,
      localContext, webContext, conversation,
      memory, userPlan, pdfContext, lang
    });

    // Appel IA — Gemma 4 en PRIORITÉ
    const isHeavy = ["analyse_business","analyse_document","decision","recap","automatisation","generation_offre","acquisition_clients"].includes(intent) || !!pdfContext;

    const result = await runRouter({
      prompt,
      geminiKey:     GEMINI_API_KEY,
      groqKey:       GROQ_API_KEY,
      openRouterKey: OPENROUTER_API_KEY,
      isHeavy
    });

    // Sauvegarde mémoire (Pro)
    if (userId && extractedMemory && planLimits.memory === "long" && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const upserts = Object.entries(extractedMemory).map(([key, value]) => ({
          user_id: userId, key, value: String(value), updated_at: new Date().toISOString()
        }));
        if (upserts.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${SUPABASE_SERVICE}`,
              "apikey":        SUPABASE_SERVICE,
              "Content-Type":  "application/json",
              "Prefer":        "resolution=merge-duplicates"
            },
            body: JSON.stringify(upserts)
          });
        }
      } catch (e) { console.warn("[Florencia] Memory save:", e.message); }
    }

    // Sauvegarde conversation
    if (userId && conversationId && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SUPABASE_SERVICE}`,
            "apikey":        SUPABASE_SERVICE,
            "Content-Type":  "application/json"
          },
          body: JSON.stringify([
            { conversation_id: conversationId, user_id: userId, role: "user",      content: message },
            { conversation_id: conversationId, user_id: userId, role: "assistant", content: result.reply }
          ])
        });
      } catch (e) { console.warn("[Florencia] Message save:", e.message); }
    }

    return jsonResponse(200, {
      reply:        result.reply,
      provider:     result.provider,
      thinking:     result.thinking || null,
      intent,
      plan:         userPlan,
      lang,
      usedWeb:      !!webContext,
      usedPdf:      !!pdfContext,
      memoryUpdate: extractedMemory
    });

  } catch (error) {
    console.error("[Florencia] Erreur:", error);
    return jsonResponse(500, { error: "Erreur serveur.", details: error?.message });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ════════════════════════════════════════════════════════════
// ROUTER IA — Gemma 4 en PRIORITÉ ABSOLUE
// Fallback automatique : Gemini → Groq → DeepSeek
// ════════════════════════════════════════════════════════════

async function runRouter({ prompt, geminiKey, groqKey, openRouterKey, isHeavy }) {
  // Gemma 4 27B est le modèle principal — le plus puissant disponible gratuitement
  // Les autres ne servent que si Gemma 4 est indisponible ou à quota
  const providers = openRouterKey
    ? ["gemma4", "gemini", "groq", "deepseek"]
    : ["gemini", "groq"];

  let lastError = null;

  for (const p of providers) {
    try {
      if (p === "gemma4" && openRouterKey) {
        const r = await callOpenRouter(prompt, openRouterKey, "google/gemma-4-27b-it:free", true);
        if (r?.reply) return r;
      }
      if (p === "gemini" && geminiKey) {
        const reply = await callGemini(prompt, geminiKey, isHeavy);
        if (reply) return { reply, provider: "gemini", thinking: null };
      }
      if (p === "groq" && groqKey) {
        const reply = await callGroq(prompt, groqKey);
        if (reply) return { reply, provider: "groq", thinking: null };
      }
      if (p === "deepseek" && openRouterKey) {
        const r = await callOpenRouter(prompt, openRouterKey, "deepseek/deepseek-chat-v3-0324:free", false);
        if (r?.reply) return r;
      }
    } catch (err) { lastError = err; }
  }

  throw new Error(lastError?.message || "Aucun provider IA disponible.");
}

// ── Gemma 4 via OpenRouter (avec thinking activé) ────────────

async function callOpenRouter(prompt, apiKey, model, enableThinking = false) {
  const body = {
    model,
    temperature: 0.7,
    max_tokens:  4000,
    messages:    [{ role: "user", content: prompt }]
  };

  // Le reasoning permet à Gemma 4 de réfléchir avant de répondre
  if (enableThinking) {
    body.reasoning = { effort: "high" };
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer":  "https://florencia-os.vercel.app",
      "X-Title":       "Florencia OS"
    },
    body: JSON.stringify(body)
  });

  if (res.status === 429) throw new Error("OpenRouter quota reached.");
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);

  const data    = await res.json();
  const reply   = data?.choices?.[0]?.message?.content || "";
  const thinking = data?.choices?.[0]?.message?.reasoning || null;

  return { reply, provider: "gemma-4-27b", thinking };
}

// ── Gemini ───────────────────────────────────────────────────

async function callGemini(prompt, apiKey, isHeavy = false) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: isHeavy ? 3000 : 1800 }
      })
    }
  );
  if (res.status === 429) throw new Error("Gemini quota reached.");
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const d = await res.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── Groq ─────────────────────────────────────────────────────

async function callGroq(prompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens:  2000,
      messages:    [{ role: "user", content: prompt }]
    })
  });
  if (res.status === 429) throw new Error("Groq quota reached.");
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const d = await res.json();
  return d?.choices?.[0]?.message?.content || "";
}

// ════════════════════════════════════════════════════════════
// ANALYSE PDF — Gemini Vision
// ════════════════════════════════════════════════════════════

async function analyzePDF(pdfBase64, apiKey, lang = "fr") {
  if (!apiKey || !pdfBase64) return null;
  const instr = {
    fr: "Analyse ce document. Extrais les points clés, chiffres, décisions et actions requises. Réponds en français, structuré.",
    en: "Analyze this document. Extract key points, figures, decisions, actions. Respond in English, structured.",
    es: "Analiza este documento. Extrae puntos clave, cifras, decisiones, acciones. Responde en español.",
    pt: "Analise este documento. Extraia pontos, números, decisões, ações. Responda em português."
  };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
            { text: instr[lang] || instr.fr }
          ]}],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
        })
      }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// LANGUE
// ════════════════════════════════════════════════════════════

function detectLanguage(text) {
  const t = text.toLowerCase();
  const score = (m) => m.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const s = {
    fr: score(["je ","tu ","il ","nous ","les ","des ","une ","est ","pas ","pour ","avec ","dans ","sur ","ça ","mais ","très "]),
    en: score(["i ","you ","he ","she ","we ","the ","a ","an ","is ","are ","have ","help ","how ","what ","can ","do "]),
    es: score(["yo ","tú ","los ","las ","una ","como ","que ","para ","con ","ayuda","quiero ","necesito "]),
    pt: score(["eu ","você ","ele ","os ","as ","para ","com ","ajuda","quero ","preciso "])
  };
  if (/[àâäéèêëîïôùûüçœæ]/i.test(text)) s.fr += 3;
  if (/[áéíóúüñ¿¡]/i.test(text))        s.es += 3;
  if (/[ãõ]/i.test(text))               s.pt += 2;
  const w = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
  return w[1] === 0 ? "fr" : w[0];
}

function getLimitMessage(lang, limit) {
  const m = {
    fr: `Tu as atteint ta limite de ${limit} messages aujourd'hui. Passe au Pro pour des messages illimités.`,
    en: `You've reached your daily limit of ${limit} messages. Upgrade to Pro for unlimited messages.`,
    es: `Límite de ${limit} mensajes alcanzado. Actualiza a Pro.`,
    pt: `Limite de ${limit} mensagens atingido. Atualize para o Pro.`
  };
  return m[lang] || m.fr;
}

// ════════════════════════════════════════════════════════════
// INTENTION
// ════════════════════════════════════════════════════════════

function detectIntent(message, pdfContext) {
  if (pdfContext) return "analyse_document";
  const t = message.toLowerCase();
  if (containsOne(t, ["client","prospect","prospection","acquisition","lead","cold email","customer","sales","clientes","vendas"])) return "acquisition_clients";
  if (containsOne(t, ["offre","positionnement","tarif","pricing","offer","value proposition","price","oferta","preço"])) return "generation_offre";
  if (containsOne(t, ["contenu","script","post","publication","youtube","instagram","linkedin","tiktok","content","social media","contenido","conteúdo"])) return "creation_contenu";
  if (containsOne(t, ["projet","organisation","tâches","deadline","workflow","roadmap","project","tasks","proyecto","tarefas"])) return "gestion_projets";
  if (containsOne(t, ["revenu","analyse","performance","optimisation","croissance","revenue","analysis","growth","analytics","ingresos","receita"])) return "analyse_business";
  if (containsOne(t, ["décide","choisir","option","comparer","choose","decide","cuál","decidir"])) return "decision";
  if (containsOne(t, ["écris","rédige","email","message","texte","write","draft","redacta","escreve"])) return "redaction";
  if (containsOne(t, ["automatise","zapier","make","workflow","automate","automatiza"])) return "automatisation";
  if (containsOne(t, ["souviens","rappelle","mémoire","remember","memory"])) return "memoire";
  if (containsOne(t, ["résumé","bilan","recap","synthèse","summary","resumen","resumo"])) return "recap";
  if (containsOne(t, ["priorités","aujourd'hui","focus","que faire","priorities","today"])) return "priorites_jour";
  return "general";
}

function shouldUseWeb(message, intent) {
  if (!["acquisition_clients","analyse_business","general"].includes(intent)) return false;
  return containsOne(message.toLowerCase(), ["actualité","tendance","prix","marché","concurrent","news","trend","market","today","now","2025","2026"]);
}

function shouldUseLocal(message, userProfile) {
  if (userProfile?.country) return false;
  return containsOne(message.toLowerCase(), ["ici","local","région","ville","pays","near","city","country"]);
}

// ════════════════════════════════════════════════════════════
// WEB + LOCAL
// ════════════════════════════════════════════════════════════

async function searchWeb({ query, apiKey }) {
  if (!apiKey || !query) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 4, include_answer: true })
    });
    if (!res.ok) return null;
    const d = await res.json();
    const r = (d?.results || []).slice(0, 3);
    return r.length === 0 ? null : r.map(x => `• ${x.title}\n${(x.content || "").substring(0, 300)}`).join("\n\n");
  } catch { return null; }
}

function buildSearchQuery(message, userProfile, localContext) {
  return [message.substring(0, 120), localContext?.country || userProfile?.country || "", userProfile?.niche || ""]
    .filter(Boolean).join(" ").trim();
}

async function getLocalContext({ ip, token, userProfile }) {
  if (userProfile?.country && userProfile?.city) {
    return { country: userProfile.country, city: userProfile.city, timezone: userProfile.timezone || "" };
  }
  if (!ip || !token) return null;
  try {
    const res = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!res.ok) return null;
    const d = await res.json();
    return { country: d.country || "", city: d.city || "", timezone: d.timezone || "" };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// MÉMOIRE
// ════════════════════════════════════════════════════════════

function extractMemoryFromMessage(message, intent) {
  const mem = {};
  const t   = message.toLowerCase();
  const n = t.match(/(?:niche|secteur|domaine)\s*(?:est|:)?\s*([a-zàâäéèêëîïôùûüç\s-]{3,30})/i);
  const r = t.match(/(\d[\d\s]*(?:€|eur|usd|\$|fcfa|xof|k€|k\$))/i);
  const o = t.match(/(?:offre|service|produit|vends?|propose)\s*(?::|est|de)?\s*([a-zàâäéèêëîïôùûüç\s-]{3,40})/i);
  if (n) mem.lastNicheMentioned   = n[1].trim();
  if (r) mem.lastMentionedRevenue = r[1].trim();
  if (o) mem.lastMentionedOffer   = o[1].trim();
  return Object.keys(mem).length > 0 ? mem : null;
}

// ════════════════════════════════════════════════════════════
// PROMPT
// ════════════════════════════════════════════════════════════

function buildFlorenciaPrompt({ message, intent, userProfile, dailyCheckin, localContext, webContext, conversation, memory, userPlan, pdfContext, lang }) {
  const langRule = {
    fr: "Réponds UNIQUEMENT en français. Sans exception.",
    en: "Respond ONLY in English. No exceptions.",
    es: "Responde ÚNICAMENTE en español. Sin excepciones.",
    pt: "Responda SOMENTE em português. Sem exceções."
  }[lang] || "Réponds UNIQUEMENT en français.";

  const memBlock  = memory && Object.keys(memory).length > 0
    ? `MÉMOIRE\n${Object.entries(memory).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
    : "MÉMOIRE\n- Aucune mémoire enregistrée.";
  const webBlock  = webContext  ? `\nRÉSULTATS WEB\n${webContext}` : "";
  const pdfBlock  = pdfContext  ? `\nDOCUMENT\n${pdfContext}` : "";
  const convBlock = conversation.length > 0
    ? conversation.map(m => `${m.role === "user" ? "Utilisateur" : "Florencia"}: ${m.content}`).join("\n")
    : "Pas de messages précédents.";

  return `Tu es Florencia — copilote IA business, stratège, conseiller de confiance.

LANGUE : ${langRule}

RÈGLES DE COMMUNICATION
- Direct, précis, sans blabla. Zéro remplissage.
- Jamais "Bien sûr !", "Absolument !", "Excellente question !"
- Ne répète pas ce que l'utilisateur vient de dire.
- Ton : calme, lucide, humain, premium.
- Ne mentionne jamais les modèles IA ou tes limitations techniques.
- Utilise la mémoire — ne pose jamais une question déjà répondue.

LONGUEUR DE RÉPONSE
Adapte la longueur à la question :
- Question simple ou rapide → réponse courte et directe (2-5 lignes).
- Analyse, plan d'action, stratégie → réponse longue et bien structurée.
- Ne gonfle jamais une réponse simple. Ne coupe jamais une analyse importante.
- Pour les réponses complexes, tu peux raisonner étape par étape en interne, puis donner une réponse finale claire.

${getIntentGuide(intent)}

CONTEXTE
Plan: ${userPlan.toUpperCase()}
Profil: ${userProfile.job || "—"} | ${userProfile.niche || memory?.lastNicheMentioned || "—"} | ${userProfile.country || localContext?.country || "—"} | ${userProfile.currency || "—"}
Check-in: Objectif=${dailyCheckin.goal || "—"} | Focus=${dailyCheckin.focus || "—"} | Bloqueur=${dailyCheckin.blocker || "aucun"}
${memBlock}${webBlock}${pdfBlock}

CONVERSATION RÉCENTE
${convBlock}

INTENTION : ${intent}

UTILISATEUR : ${message}`;
}

function getIntentGuide(intent) {
  const g = {
    acquisition_clients: `GUIDE — ACQUISITION CLIENTS : Scripts de prospection adaptés. Canaux pertinents. Templates prêts. Objectifs chiffrés.`,
    generation_offre:    `GUIDE — OFFRE : Nom, contenu, prix. Promesse concrète. Objections + réponses.`,
    creation_contenu:    `GUIDE — CONTENU : Sujets adaptés à la niche. Scripts, hooks, titres. Ton adapté à la plateforme.`,
    gestion_projets:     `GUIDE — PROJETS : Tâches actionnables. Bloqueurs identifiés. Planning réaliste.`,
    analyse_business:    `GUIDE — BUSINESS : Leviers de croissance rapides. Comparaison d'options. 3 actions immédiates.`,
    analyse_document:    `GUIDE — DOCUMENT : Points clés, chiffres, décisions, actions requises, risques cachés.`,
    priorites_jour:      `GUIDE — PRIORITÉS : Max 3 actions. Urgent vs important. Ordre logique d'exécution.`,
    decision:            `GUIDE — DÉCISION : Recommandation claire. Pourquoi cette option. Risques de chaque choix.`,
    redaction:           `GUIDE — RÉDACTION : Texte prêt à copier-coller. Ton adapté. Concis et impactant.`,
    automatisation:      `GUIDE — AUTOMATISATION : Étapes du workflow. Outils à connecter. Temps économisé.`,
    recap:               `GUIDE — RÉCAP : Synthèse via profil + mémoire. Forces, faiblesses. 3 actions prioritaires.`
  };
  return g[intent] ? `\n${g[intent]}\n` : "";
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

async function patchSupabase(url, key, endpoint, data) {
  return fetch(`${url}/rest/v1/${endpoint}`, {
    method:  "PATCH",
    headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Content-Type": "application/json" },
    body:    JSON.stringify(data)
  });
}

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
  return (!raw || typeof raw !== "string") ? "" : raw.split(",")[0].trim();
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function containsOne(text, keywords) {
  return keywords.some(w => text.includes(w));
}
