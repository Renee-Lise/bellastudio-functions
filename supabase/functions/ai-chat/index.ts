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
    const { data: sub } = await db.from("subscriptions").select("plan,status,admin_granted,current_period_end").eq("user_id", user.id).single();
    const isPremium = sub?.admin_granted || (["premium_monthly","premium_annual"].includes(sub?.plan) && sub?.status === "active" && (!sub?.current_period_end || new Date(sub.current_period_end) > new Date()));
    const body = await req.json();
    const { action, messages, context } = body;
    if (action === "generate_recipes") return await generateRecipes(db, user.id, context, isPremium);
    if (action === "meal_plan_to_list") return await mealPlanToList(db, user.id, body.meal_plan_id);
    return await chat(db, user.id, messages, isPremium);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

async function chat(db: any, userId: string, messages: any[], isPremium: boolean) {
  const [{ data: lists }, { data: pantry }, { data: prefs }] = await Promise.all([
    db.from("shopping_lists").select("title").eq("user_id", userId).eq("status","active").limit(5),
    db.from("pantry_items").select("name,quantity,unit").eq("user_id", userId).gt("quantity", 0).limit(20),
    db.from("user_preferences").select("currency,preferred_store,language").eq("user_id", userId).single(),
  ]);
  const ctx = [
    `Listes actives : ${(lists||[]).map((l:any) => l.title).join(", ") || "aucune"}`,
    `Garde-manger : ${(pantry||[]).map((p:any) => p.name).slice(0,15).join(", ") || "vide"}`,
    prefs?.preferred_store ? `Magasin préféré : ${prefs.preferred_store}` : "",
    `Plan : ${isPremium ? "Premium" : "Gratuit"}`,
  ].filter(Boolean).join("\n");
  const text = await callAnthropic(`Tu es Bellaïa, l'assistante de Bella'Studio Marché. Tu aides à gérer courses, recettes, placard et budget. Tu parles français, anglais et créole antillais. Tu réponds dans la langue de l'utilisateur. Contexte : ${ctx}`, messages);
  return json({ text });
}

async function generateRecipes(db: any, userId: string, context: string, isPremium: boolean) {
  const [{ data: pantry }, { data: bought }] = await Promise.all([
    db.from("pantry_items").select("name,quantity,unit,expiration_date").eq("user_id", userId).gt("quantity", 0),
    db.from("shopping_items").select("name").eq("user_id", userId).eq("checked", true).order("updated_at",{ascending:false}).limit(30),
  ]);
  const maxRecipes = isPremium ? 5 : 3;
  const pantryList = (pantry||[]).map((i:any) => `- ${i.name}: ${i.quantity}${i.unit?" "+i.unit:""}${i.expiration_date?" (exp: "+i.expiration_date+")":""}`).join("\n") || "Vide";
  const boughtList = [...new Set((bought||[]).map((i:any) => i.name))].slice(0,15).join(", ") || "aucun";
  const prompt = `Garde-manger :\n${pantryList}\nRécemment acheté : ${boughtList}\n${context?"Précision : "+context:""}\nGénère ${maxRecipes} recettes. JSON uniquement :\n{"recipes":[{"title":"...","type":"repas|dessert|cocktail|mocktail","description":"...","prep_time":"15 min","cook_time":"30 min","difficulty":"Facile|Moyen|Difficile","servings":4,"estimated_cost":8.50,"available_ingredients":[{"name":"...","qty":"...","available":true}],"missing_ingredients":[{"name":"...","qty":"...","estimated_price":1.50}],"instructions":["Étape 1..."],"tags":["antillais"]}]}`;
  const text = await callAnthropic("Réponds uniquement en JSON valide.", [{ role: "user", content: prompt }]);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { recipes: [] }; }
  return json({ ...parsed, is_premium: isPremium });
}

async function mealPlanToList(db: any, userId: string, mealPlanId: string) {
  const { data: entries } = await db.from("meal_plan_entries").select("*, recipes(title,ingredients,servings)").eq("meal_plan_id", mealPlanId).eq("user_id", userId);
  if (!entries?.length) return json({ error: "Aucune entrée dans ce menu" }, 400);
  const ingredientsMap: Record<string, any> = {};
  for (const entry of entries) {
    if (!entry.recipes?.ingredients) continue;
    const ratio = (entry.servings || 4) / (entry.recipes.servings || 4);
    for (const ingr of entry.recipes.ingredients) {
      const key = ingr.name.toLowerCase();
      if (!ingredientsMap[key]) ingredientsMap[key] = { name: ingr.name, qty: 0, unit: ingr.unit || "" };
      ingredientsMap[key].qty += (parseFloat(ingr.qty) || 1) * ratio;
    }
  }
  const { data: plan } = await db.from("meal_plans").select("title,start_date,end_date").eq("id", mealPlanId).single();
  const { data: newList } = await db.from("shopping_lists").insert({ user_id: userId, title: `🍽 ${plan?.title||"Menu"} — Courses`, status: "active" }).select().single();
  if (!newList) return json({ error: "Erreur création liste" }, 500);
  const items = Object.values(ingredientsMap).map((ingr: any) => ({ list_id: newList.id, user_id: userId, name: ingr.name, quantity: Math.ceil(ingr.qty*10)/10, unit: ingr.unit||null, checked: false }));
  await db.from("shopping_items").insert(items);
  return json({ list_id: newList.id, items_count: items.length, list_title: newList.title });
}

async function callAnthropic(system: string, messages: any[]): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Clé Anthropic manquante");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1500, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
