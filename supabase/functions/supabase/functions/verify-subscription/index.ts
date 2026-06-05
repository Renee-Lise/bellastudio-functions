import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (url.searchParams.get("action") === "kofi_webhook") return handleKofiWebhook(req);
  if (req.method === "GET") return getSubscriptionStatus(req);
  return new Response("Not found", { status: 404 });
});

async function handleKofiWebhook(req: Request) {
  try {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const dataStr = params.get("data");
    if (!dataStr) return new Response("No data", { status: 400 });
    const data = JSON.parse(dataStr);
    const expectedToken = Deno.env.get("KOFI_VERIFICATION_TOKEN");
    if (expectedToken && data.verification_token !== expectedToken) return new Response("Unauthorized", { status: 401 });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { type, email, tier_name, is_subscription_payment, kofi_transaction_id, amount, currency } = data;
    const { data: users } = await db.auth.admin.listUsers();
    const user = users?.users?.find((u: any) => u.email?.toLowerCase() === email?.toLowerCase());
    if (!user) return new Response("OK - user not found", { status: 200 });
    let plan = "premium_monthly";
    if (tier_name?.toLowerCase().includes("annual") || tier_name?.toLowerCase().includes("annuel")) plan = "premium_annual";
    const now = new Date();
    const periodEnd = new Date(now);
    if (plan === "premium_annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);
    if (type === "Subscription" || is_subscription_payment) {
      await db.from("subscriptions").upsert({
        user_id: user.id, provider: "kofi",
        provider_customer_id: email,
        provider_subscription_id: kofi_transaction_id || email,
        status: "active", plan,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        metadata: { tier_name, amount, currency, kofi_transaction_id },
        updated_at: now.toISOString(),
      }, { onConflict: "user_id" });
    } else if (type === "Cancellation" || type === "subscription_cancelled") {
      await db.from("subscriptions").update({
        status: "canceled",
        canceled_at: now.toISOString(),
        updated_at: now.toISOString(),
      }).eq("user_id", user.id);
    }
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Ko-fi webhook error:", err);
    return new Response("Error", { status: 500 });
  }
}

async function getSubscriptionStatus(req: Request) {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: CORS });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: CORS });
    const { data: sub } = await db.from("subscriptions").select("*").eq("user_id", user.id).single();
    const isPremium = sub?.admin_granted ||
      (["premium_monthly","premium_annual"].includes(sub?.plan) &&
       sub?.status === "active" &&
       (!sub?.current_period_end || new Date(sub.current_period_end) > new Date()));
    return new Response(JSON.stringify({ subscription: sub, is_premium: isPremium }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}
