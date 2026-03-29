const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = "https://psznbzvnwtpcpiwvgpbp.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzem5ienZud3RwY3Bpd3ZncGJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2Njk5MDAsImV4cCI6MjA5MDI0NTkwMH0.18Sqvy5oUj_e0QpGJdm9xKEZeZ4swlIwYfEmH8xPUAE";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TICKET_LIMIT = 3;

// ─── POMOCNÁ FUNKCIA ───────────────────────────────────────────────────────────
async function getId(table, colMatch, colRet, value) {
    if (!value) return null;
    const clean = value.trim().toLowerCase();

    const { data: res1 } = await supabase.from(table).select(colRet).ilike(colMatch, clean);
    if (res1?.length) return res1[0][colRet];

    const { data: res2 } = await supabase.from(table).select(colRet).ilike(colMatch, `%${clean}%`);
    if (res2?.length) return res2[0][colRet];

    const firstWord = clean.split(' ')[0];
    const { data: res3 } = await supabase.from(table).select(colRet).ilike(colMatch, `%${firstWord}%`);
    if (res3?.length) return res3[0][colRet];

    return null;
}

// ─── KROK 0: Resetuj zaseknuté tickety späť na open ───────────────────────────
async function resetNepriradene() {
    console.log("\n🔄 KROK 0: Kontrolujem zaseknuté tickety...");

    const { data, error } = await supabase
        .from("tickets")
        .update({ status: "open" })
        .eq("status", "processing")
        .select("ticket_code");

    if (error) {
        console.log(`❌ RESET: Chyba: ${error.message}`);
        return;
    }

    if (data?.length) {
        console.log(`🔄 RESET: Vrátených ${data.length} zaseknutých ticketov na 'open': ${data.map(d => d.ticket_code).join(', ')}`);
    } else {
        console.log(`✅ RESET: Žiadne zaseknuté tickety.`);
    }
}

// ─── KROK 1: Chatbot → Ticket ──────────────────────────────────────────────────
async function chatbotToTicket() {
    console.log("\n📥 KROK 1: Načítavam záznam z chatbotu...");

    const { data: cbData } = await supabase
        .from("chatbot")
        .select("created_at, region, country, client_type, service")
        .or("status.is.null,status.neq.vybavene")
        .order("created_at", { ascending: false })
        .limit(1);

    if (!cbData?.length) {
        console.log("❌ KROK 1: Žiadne nové záznamy v chatbot tabuľke.");
        return null;
    }

    const cb = cbData[0];
    console.log(`🔎 Načítané z chatbot: ${cb.region} | ${cb.country} | ${cb.client_type} | ${cb.service}`);

    const region   = await getId("regions",            "name",  "id",            cb.region);
    const country  = await getId("countries",          "name",  "country_index", cb.country);
    const reqCat   = await getId("request_categories", "label", "id",            cb.service);
    const userType = await getId("user_types",         "label", "id",            cb.client_type);

    console.log(`🔢 Kódy: Reg:${region} | Krajina:${country} | Servis:${reqCat} | Typ:${userType}`);

    if ([region, country, reqCat, userType].includes(null)) {
        console.log("❌ KROK 1: Niektoré ID neboli nájdené. Skontroluj hodnoty v číselníkoch.");
        return null;
    }

    const ticketCode = `${region}${country}${reqCat}${userType}`;
    console.log(`🎫 Generujem ticket kód: ${ticketCode}`);

    const { error } = await supabase.from("tickets").insert({
        ticket_code: ticketCode,
        status: "open",
        created_at: new Date().toISOString()
    });

    if (error) {
        console.log(`❌ KROK 1: Chyba pri zápise ticketu: ${error.message}`);
        return null;
    }

    const { error: updateError } = await supabase
        .from("chatbot")
        .update({ status: "vybavene" })
        .eq("created_at", cb.created_at);

    if (updateError) {
        console.log(`❌ KROK 1: Chyba pri aktualizácii chatbot statusu: ${updateError.message}`);
        return null;
    }

    console.log(`✅ KROK 1: Ticket ${ticketCode} vytvorený.`);
    return ticketCode;
}

// ─── KROK 2: Načítaj najstarší open ticket ─────────────────────────────────────
async function ziskanieTicketu() {
    console.log("\n📋 KROK 2: Hľadám otvorený ticket...");

    const { data } = await supabase
        .from("tickets")
        .select("ticket_code")
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(1);

    if (!data?.length) {
        console.log("📭 KROK 2: Žiadne nové tickety na spracovanie.");
        return null;
    }

    const plnyKod = String(data[0].ticket_code);
    console.log(`🎫 KROK 2: Načítaný ticket: ${plnyKod}`);

    await supabase
        .from("tickets")
        .update({ status: "processing" })
        .eq("ticket_code", plnyKod);

    return plnyKod;
}

// ─── KROK 3: Priraď zamestnanca (s limitom ticketov) ──────────────────────────
async function priradZamestnanca(plnyKod) {
    if (!plnyKod || plnyKod.length < 8) {
        console.log(`❌ KROK 3: Neplatný kód ticketu (${plnyKod}).`);
        return null;
    }

    const kod6 = plnyKod.slice(0, 6);

    // Vyreže stredné 2 znaky (krajina) z 6-miestneho kódu → ostane región + servis
    function vyrezStred(kod) {
        return kod.slice(0, 2) + kod.slice(4, 6);
    }

    const kod4 = vyrezStred(kod6);

    // Načítaj všetkých zamestnancov
    const { data: vsetci, error } = await supabase
        .from("employees")
        .select("id, meno, zakaznik");

    if (error || !vsetci?.length) {
        console.log(`❌ KROK 3: Chyba pri načítaní zamestnancov.`);
        await supabase.from("tickets").update({ status: "unassigned" }).eq("ticket_code", plnyKod);
        return null;
    }

    // 1. POKUS — presná zhoda prvých 6 znakov ticketu s id zamestnanca
    console.log(`🔍 KROK 3: 1. pokus — hľadám id = '${kod6}'`);
    let kandidati = vsetci.filter(z => z.id === kod6);

    // 2. POKUS — vyrež stred z ticketu aj zo zamestnanca a porovnaj
    if (!kandidati.length) {
        console.log(`⚠️ Nenašiel. 2. pokus — hľadám vyrezané id = '${kod4}'`);
        kandidati = vsetci.filter(z => vyrezStred(z.id) === kod4);
    }

    if (!kandidati.length) {
        console.log(`❌ KROK 3: Nenašiel sa žiadny zamestnanec.`);
        await supabase.from("tickets").update({ status: "unassigned" }).eq("ticket_code", plnyKod);
        return null;
    }

    // Priraď prvého kto má voľný slot
    for (const zam of kandidati) {
        const aktualneTickety = zam.zakaznik?.length ?? 0;
        console.log(`👤 ${zam.meno} (${zam.id}) — aktívne tickety: ${aktualneTickety}/${TICKET_LIMIT}`);

        if (aktualneTickety >= TICKET_LIMIT) {
            console.log(`⛔ ${zam.meno} má plný limit. Preskakujem.`);
            continue;
        }

        const noveZakaznik = [...(zam.zakaznik ?? []), plnyKod];

        const { error: updateErr } = await supabase
            .from("employees")
            .update({ zakaznik: noveZakaznik })
            .eq("id", zam.id);

        if (updateErr) {
            console.log(`❌ Chyba pri zápise: ${updateErr.message}`);
            continue;
        }

        await supabase
            .from("tickets")
            .update({ status: "assigned" })
            .eq("ticket_code", plnyKod);

        console.log(`📝 ${zam.meno} — tickety: [${noveZakaznik.join(', ')}]`);
        return zam.meno;
    }

    console.log(`⛔ KROK 3: Všetci kandidáti majú plný limit.`);
    await supabase.from("tickets").update({ status: "open" }).eq("ticket_code", plnyKod);
    return null;
}

// ─── HLAVNÝ PIPELINE ───────────────────────────────────────────────────────────
async function main() {
    console.log("═══════════════════════════════════════");
    console.log("🚀 Štartujem plný pipeline...");
    console.log("═══════════════════════════════════════");

    await resetNepriradene();
    await chatbotToTicket();

    const plnyKod = await ziskanieTicketu();
    if (!plnyKod) {
        console.log("\n⚠️ ZÁVER: Žiadny ticket na priradenie.\n");
        return;
    }

    const zamestnanec = await priradZamestnanca(plnyKod);

    console.log("\n═══════════════════════════════════════");
    if (zamestnanec) {
        console.log(`🎉 ZÁVER: Ticket ${plnyKod} → ${zamestnanec}`);
    } else {
        console.log(`⚠️ ZÁVER: Ticket ${plnyKod} zostal nepriradený.`);
    }
    console.log("═══════════════════════════════════════\n");
}

main();