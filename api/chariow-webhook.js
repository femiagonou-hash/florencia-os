// ============================================================
// FLORENCIA OS — api/chariow-webhook.js
// Reçoit les Pulses Chariow et met à jour Supabase
// ============================================================

const SUPABASE_URL     = process.env.SUPABASE_URL              || "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function POST(request) {
  try {
    const body = await safeJson(request);

    // On accepte uniquement les ventes complétées
    if (body.event !== "sale.completed") {
      return jsonResponse(200, { received: true, action: "ignored" });
    }

    const sale     = body.data?.sale;
    const customer = sale?.customer;

    if (!sale || !customer?.email) {
      return jsonResponse(400, { error: "Données de vente manquantes." });
    }

    const email = customer.email.toLowerCase().trim();

    if (!SUPABASE_URL || !SUPABASE_SERVICE) {
      console.error("[Webhook] Variables Supabase manquantes.");
      return jsonResponse(500, { error: "Configuration serveur manquante." });
    }

    // 1. Trouver l'utilisateur Supabase via son email (auth.users)
    const authRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      {
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE}`,
          "apikey":        SUPABASE_SERVICE
        }
      }
    );

    if (!authRes.ok) {
      console.error("[Webhook] Erreur recherche utilisateur:", authRes.status);
      return jsonResponse(500, { error: "Erreur recherche utilisateur." });
    }

    const authData = await authRes.json();
    const users    = authData?.users || [];

    if (users.length === 0) {
      // Utilisateur pas encore inscrit — on log et on passe
      console.warn("[Webhook] Achat sans compte Florencia:", email);
      return jsonResponse(200, { received: true, action: "no_account_found" });
    }

    const userId = users[0].id;

    // 2. Mettre à jour le profil avec le plan Pro
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
      {
        method:  "PATCH",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE}`,
          "apikey":        SUPABASE_SERVICE,
          "Content-Type":  "application/json",
          "Prefer":        "return=minimal"
        },
        body: JSON.stringify({
          plan:             "pro",
          plan_actif:       true,
          chariow_sale_id:  sale.id || null,
          plan_depuis:      new Date().toISOString()
        })
      }
    );

    if (!updateRes.ok) {
      console.error("[Webhook] Erreur mise à jour profil:", updateRes.status);
      return jsonResponse(500, { error: "Erreur mise à jour base de données." });
    }

    console.log(`[Webhook] Plan Pro activé pour ${email} (${userId})`);
    return jsonResponse(200, { received: true, action: "plan_activated", userId });

  } catch (err) {
    console.error("[Webhook] Erreur:", err.message);
    return jsonResponse(500, { error: "Erreur serveur." });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────

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
