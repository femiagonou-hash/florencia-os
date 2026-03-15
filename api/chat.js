export async function POST(request) {
  try {
    const body = await request.json();
    const message = String(body.message || "").trim();

    if (!message) {
      return new Response(JSON.stringify({ error: "Message utilisateur manquant." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      reply: "Florencia fonctionne. Backend connecté."
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: "Erreur backend Florencia."
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
