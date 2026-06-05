import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Non authentifié" }, 401);
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return json({ error: "Non authentifié" }, 401);
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return json({ error: "Accès refusé" }, 403);
    const adminDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = req.method === "POST" ? await req.json() : {};
    const action = new URL(req.url).searchParams.get("action") || body.action;

    switch (action) {
      case "stats": {
        const [stats, recentUsers, premiumUsers, openTickets] = await Promise.all([
          db.from("admin_stats").select("*").single(),
          adminDb.from("profiles").select("id,email,full_name,created_at,role").order("created_at",{ascending:false}).limit(10),
          adminDb.from("subscriptions").select("user_id,plan,status,current_period_end,provider").in("plan",["premium_monthly","premium_annual"]).eq("status","active"),
          adminDb.from("support_requests").select("id,subject,status,priority,created_at,email").eq("status","open").order("created_at",{ascending:false}).limit(20),
        ]);
        return json({ stats: stats.data, recent_users: recentUsers.data, premium_users: premiumUsers.data, open_tickets: openTickets.data });
      }

      case "users": {
        const { page = 1, search = "" } = body;
        const limit = 20, offset = (page - 1) * limit;
        let query = adminDb.from("profiles").select("id,email,full_name,role,created_at,is_active", { count: "exact" });
        if (search) query = query.ilike("email", `%${search}%`);
        const { data, count } = await query.order("created_at",{ascending:false}).range(offset, offset+limit-1);
        const userIds = (data||[]).map((u:any) => u.id);
        const { data: subs } = await adminDb.from("subscriptions").select("user_id,plan,status").in("user_id", userIds);
        const subMap = Object.fromEntries((subs||[]).map((s:any) => [s.user_id, s]));
        const users = (data||[]).map((u:any) => ({ ...u, subscription: subMap[u.id] || null }));
        return json({ users, total: count, page, pages: Math.ceil((count||0)/limit) });
      }

      case "grant_premium": {
        const { target_user_id, plan = "premium_monthly", months = 1 } = body;
        if (!target_user_id) return json({ error: "target_user_id requis" }, 400);
        const periodEnd = new Date();
        periodEnd.setMonth(periodEnd.getMonth() + months);
        await adminDb.from("subscriptions").upsert({
          user_id: target_user_id, plan, status: "active",
          admin_granted: true,
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        await adminDb.from("admin_logs").insert({
          admin_id: user.id, action: "grant_premium",
          target_user: target_user_id,
          details: { plan, months, granted_by: user.email },
        });
        return json({ success: true, message: `Premium accordé jusqu'au ${periodEnd.toLocaleDateString("fr-FR")}` });
      }

      case "revoke_premium": {
        const { target_user_id, reason = "" } = body;
        if (!target_user_id) return json({ error: "target_user_id requis" }, 400);
        await adminDb.from("subscriptions").update({
          plan: "free", status: "inactive",
          admin_granted: false,
          canceled_at: new Date().toISOString(),
          admin_note: reason,
          updated_at: new Date().toISOString(),
        }).eq("user_id", target_user_id);
        await adminDb.from("admin_logs").insert({
          admin_id: user.id, action: "revoke_premium",
          target_user: target_user_id,
          details: { reason, revoked_by: user.email },
        });
        return json({ success: true });
      }

      case "toggle_user_active": {
        const { target_user_id, is_active } = body;
        await adminDb.from("profiles").update({ is_active }).eq("id", target_user_id);
        await adminDb.from("admin_logs").insert({
          admin_id: user.id,
          action: is_active ? "activate_user" : "deactivate_user",
          target_user: target_user_id,
          details: { by: user.email },
        });
        return json({ success: true });
      }

      case "reply_support": {
        const { ticket_id, reply } = body;
        await adminDb.from("support_requests").update({
          admin_reply: reply, status: "resolved",
          resolved_at: new Date().toISOString(),
        }).eq("id", ticket_id);
        return json({ success: true });
      }

      default:
        return json({ error: "Action non reconnue" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
