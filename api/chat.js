// ============================================================
// FLORENCIA OS — api/chat.js
// Vercel Node.js · Supabase REST · Plans Free/Pro
// Router IA : Gemini → Groq → OpenRouter (fallback gratuit)
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

    const lang = detectLanguage(message);

    const authHeader = request.headers.get("Authorization") || "";
    const userToken  = authHeader.replace("Bearer ", "").trim();

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
              const profiles = await profileRes.json();
              const profile  = profiles?.[0];
              if (profile) {
                // Plan actif uniquement si plan_actif = true ET plan = 'pro'
                userPlan = (profile.plan_actif === true && profile.plan === "pro") ? "pro" : "free";
              }
            }
          }
        }
      } catch (e) { console.warn("[Florencia] Auth error:", e.message); }
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
              await fetch(`${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}`, {
                method: "PATCH",
                headers: { "Authorization": `Bearer ${SUPABASE_SERVICE}`, "apikey": SUPABASE_SERVICE, "Content-Type": "application/json" },
                body: JSON.stringify({ messages_today: 0, last_reset_date: todayDate })
              });
            }

            if (msgToday >= planLimits.messagesPerDay) {
              return jsonResponse(429, {
                error: "daily_limit_reached",
                message: getLimitMessage(lang, planLimits.messagesPerDay),
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
      } catch (e) { console.warn("[Florencia] Usage error:", e.message); }
    }

    const userProfile    = body.userProfile    || {};
    const dailyCheckin   = body.dailyCheckin   || {};
    const conversationId = body.conversationId || null;
    const pdfBase64      = body.pdfContent     || null;
    const conversation   = Array.isArray(body.conversation) ? body.conversation.slice(-12) : [];
    const userIp         = body.userIp || extractIp(request.headers.get("x-forwarded-for")) || "";

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
            memRows.forEach(r => { dbMemory[r.key] = r.value; });
            memory = { ...dbMemory, ...memory };
          }
        }
      } catch (e) { console.warn("[Florencia] Memory fetch error:", e.message); }
    }

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

    const result = await runRouter({
      intent, prompt,
      geminiKey:     GEMINI_API_KEY,
      groqKey:       GROQ_API_KEY,
      openRouterKey: OPENROUTER_API_KEY,
      isLong:        !!pdfContext
    });

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
      } catch (e) { console.warn("[Florencia] Memory save error:", e.message); }
    }

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
      } catch (e) { console.warn("[Florencia] Message save error:", e.message); }
    }

    return jsonResponse(200, {
      reply: result.reply, provider: result.provider, intent,
      plan: userPlan, lang, usedWeb: !!webContext, usedPdf: !!pdfContext,
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

// ── Router IA ────────────────────────────────────────────────

async function runRouter({ intent, prompt, geminiKey, groqKey, openRouterKey, isLong }) {
  const heavy = ["acquisition_clients","generation_offre","analyse_business","decision","recap","analyse_document","automatisation"];
  const order = (heavy.includes(intent) || isLong)
    ? ["gemini","groq","openrouter"]
    : ["groq","gemini","openrouter"];

  let lastError = null;
  for (const p of order) {
    try {
      if (p === "gemini"      && geminiKey)      { const r = await callGemini(prompt, geminiKey, isLong);      if (r) return { reply: r, provider: "gemini" }; }
      if (p === "groq"        && groqKey)        { const r = await callGroq(prompt, groqKey);                  if (r) return { reply: r, provider: "groq" }; }
      if (p === "openrouter"  && openRouterKey)  { const r = await callOpenRouter(prompt, openRouterKey);      if (r) return { reply: r, provider: "openrouter" }; }
    } catch (err) { lastError = err; }
  }
  throw new Error(lastError?.message || "Aucun provider IA disponible.");
}

async function callGemini(prompt, apiKey, isLong = false) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.72, maxOutputTokens: isLong ? 3000 : 1800 } }) }
  );
  if (res.status === 429) throw new Error("Gemini quota reached.");
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const d = await res.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.72, max_tokens: 2000, messages: [{ role: "user", content: prompt }] })
  });
  if (res.status === 429) throw new Error("Groq quota reached.");
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const d = await res.json();
  return d?.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(prompt, apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "HTTP-Referer": "https://florencia-os.vercel.app", "X-Title": "Florencia OS" },
    body: JSON.stringify({ model: "deepseek/deepseek-chat-v3-0324:free", temperature: 0.72, max_tokens: 2000, messages: [{ role: "user", content: prompt }] })
  });
  if (res.status === 429) throw new Error("OpenRouter quota reached.");
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const d = await res.json();
  return d?.choices?.[0]?.message?.content || "";
}

// ── PDF ──────────────────────────────────────────────────────

async function analyzePDF(pdfBase64, apiKey, lang = "fr") {
  if (!apiKey || !pdfBase64) return null;
  const instr = { fr: "Analyse ce document. Extrais les points clés, chiffres importants, décisions et actions requises. Réponds en français, structuré et actionnable.", en: "Analyze this document. Extract key points, figures, decisions, required actions. Respond in English, structured.", es: "Analiza este documento. Extrae puntos clave, cifras, decisiones, acciones. Responde en español.", pt: "Analise este documento. Extraia pontos principais, números, decisões, ações. Responda em português." };
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }, { text: instr[lang] || instr.fr }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2500 } }) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

// ── Langue ───────────────────────────────────────────────────

function detectLanguage(text) {
  const t = text.toLowerCase();
  const score = (markers) => markers.reduce((n, m) => n + (t.includes(m) ? 1 : 0), 0);
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
  const m = { fr: `Limite de ${limit} messages atteinte. Passe au Pro pour des messages illimités.`, en: `Daily limit of ${limit} messages reached. Upgrade to Pro for unlimited messages.`, es: `Límite de ${limit} mensajes alcanzado. Actualiza a Pro.`, pt: `Limite de ${limit} mensagens atingido. Atualize para o Pro.` };
  return m[lang] || m.fr;
}

// ── Intent ───────────────────────────────────────────────────

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

// ── Web ──────────────────────────────────────────────────────

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
  return [message.substring(0, 120), localContext?.country || userProfile?.country || "", userProfile?.niche || ""].filter(Boolean).join(" ").trim();
}

// ── Local ────────────────────────────────────────────────────

async function getLocalContext({ ip, token, userProfile }) {
  if (userProfile?.country && userProfile?.city) return { country: userProfile.country, city: userProfile.city, timezone: userProfile.timezone || "" };
  if (!ip || !token) return null;
  try {
    const res = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!res.ok) return null;
    const d = await res.json();
    return { country: d.country || "", city: d.city || "", timezone: d.timezone || "" };
  } catch { return null; }
}

// ── Mémoire ──────────────────────────────────────────────────

function extractMemoryFromMessage(message, intent) {
  const mem = {};
  const t   = message.toLowerCase();
  const nicheMatch   = t.match(/(?:niche|secteur|domaine)\s*(?:est|:)?\s*([a-zàâäéèêëîïôùûüç\s-]{3,30})/i);
  const revenueMatch = t.match(/(\d[\d\s]*(?:€|eur|usd|\$|fcfa|xof|k€|k\$))/i);
  const offerMatch   = t.match(/(?:offre|service|produit|vends?|propose)\s*(?::|est|de)?\s*([a-zàâäéèêëîïôùûüç\s-]{3,40})/i);
  if (nicheMatch)   mem.lastNicheMentioned   = nicheMatch[1].trim();
  if (revenueMatch) mem.lastMentionedRevenue = revenueMatch[1].trim();
  if (offerMatch)   mem.lastMentionedOffer   = offerMatch[1].trim();
  return Object.keys(mem).length > 0 ? mem : null;
}

// ── Prompt ───────────────────────────────────────────────────

function buildFlorenciaPrompt({ message, intent, userProfile, dailyCheckin, localContext, webContext, conversation, memory, userPlan, pdfContext, lang }) {
  const langRule = { fr: "Respond ONLY in French.", en: "Respond ONLY in English.", es: "Respond ONLY in Spanish.", pt: "Respond ONLY in Portuguese." }[lang] || "Respond ONLY in French.";
  const memBlock = memory && Object.keys(memory).length > 0 ? `MEMORY\n${Object.entries(memory).map(([k,v]) => `- ${k}: ${v}`).join("\n")}` : "MEMORY\n- No prior memory.";
  const webBlock = webContext ? `\nWEB RESULTS\n${webContext}` : "";
  const pdfBlock = pdfContext ? `\nDOCUMENT\n${pdfContext}` : "";
  const conv     = conversation.length > 0 ? conversation.map(m => `${m.role === "user" ? "User" : "Florencia"}: ${m.content}`).join("\n") : "No prior messages.";
  const guide    = getIntentGuide(intent);

  return `You are Florencia, an advanced AI business copilot.

LANGUAGE — CRITICAL: ${langRule} Never switch mid-response. Default: French.

RULES: Direct, sharp, no filler. No "Of course!" or "Great question!". Never mention AI providers. Use memory.

${guide}

CONTEXT
Plan: ${userPlan.toUpperCase()}
Profile: ${userProfile.job || "—"} | ${userProfile.niche || memory?.lastNicheMentioned || "—"} | ${userProfile.country || localContext?.country || "—"}
Check-in: Goal=${dailyCheckin.goal || "—"} | Focus=${dailyCheckin.focus || "—"} | Blocker=${dailyCheckin.blocker || "none"}
${memBlock}${webBlock}${pdfBlock}

CONVERSATION
${conv}

INTENT: ${intent}

USER: ${message}`;
}

function getIntentGuide(intent) {
  const g = {
    acquisition_clients: "GUIDE: Prospecting scripts, relevant channels, quantified goals, ready-to-use templates.",
    generation_offre:    "GUIDE: Name, content, price, promise, objections + answers.",
    creation_contenu:    "GUIDE: Topics, scripts, hooks, titles, platform-adapted tone.",
    analyse_business:    "GUIDE: Fastest growth levers, option comparison, 3 immediate actions.",
    decision:            "GUIDE: Clear recommendation, why this option, risks of each choice.",
    redaction:           "GUIDE: Ready-to-copy text, adapted tone.",
    automatisation:      "GUIDE: Clear workflow steps, tools to connect, time saved.",
    analyse_document:    "GUIDE: Key points, figures, decisions, required actions, hidden risks."
  };
  return g[intent] ? `\n${g[intent]}\n` : "";
}

// ── Helpers ──────────────────────────────────────────────────

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
}
async function safeJson(req) { try { return await req.json(); } catch { return {}; } }
function extractIp(raw) { return (!raw || typeof raw !== "string") ? "" : raw.split(",")[0].trim(); }
function today() { return new Date().toISOString().split("T")[0]; }
function containsOne(text, keywords) { return keywords.some(w => text.includes(w)); }
