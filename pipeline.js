const { createClient } = require('@supabase/supabase-js');

let supabase;
function getSupabase() {
    if (!supabase) {
        supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );
    }
    return supabase;
}

const TICKET_LIMIT = 3;

// ─── POMOCNÁ FUNKCIA ───────────────────────────────────────────────────────────
async function getId(table, colMatch, colRet, value) {
    if (!value) return null;
    const clean = value.trim().toLowerCase();

    const { data: res1 } = await getSupabase().from(table).select(colRet).ilike(colMatch, clean);
    if (res1?.length) return res1[0][colRet];

    const { data: res2 } = await getSupabase().from(table).select(colRet).ilike(colMatch, `%${clean}%`);
    if (res2?.length) return res2[0][colRet];

    const firstWord = clean.split(' ')[0];
    const { data: res3 } = await getSupabase().from(table).select(colRet).ilike(colMatch, `%${firstWord}%`);
    if (res3?.length) return res3[0][colRet];

    return null;
}

// ─── KROK 0: Resetuj zaseknuté tickety späť na open ───────────────────────────
async function resetNepriradene() {
    const { data, error } = await getSupabase()
        .from("tickets")
        .update({ status: "open" })
        .eq("status", "processing")
        .select("ticket_code");

    if (error) {
        console.log(`❌ RESET: ${error.message}`);
        return;
    }
    if (data?.length) {
        console.log(`🔄 RESET: Vrátených ${data.length} ticketov na open: ${data.map(d => d.ticket_code).join(', ')}`);
    } else {
        console.log(`✅ RESET: Žiadne zaseknuté tickety.`);
    }
}

// ─── KROK 1: Chatbot dáta → Ticket ────────────────────────────────────────────
// FIX: name, email, opis_problemu are now passed in and written directly —
//      no longer dependent on the backfill step to fill them in later.
async function chatbotToTicket(vstup) {
    const { region, country, client_type, service, name, email, opis_problemu } = vstup;

    const regionId  = await getId("regions",            "name",  "id",            region);
    const countryId = await getId("countries",          "name",  "country_index", country);
    const reqCat    = await getId("request_categories", "label", "id",            service);
    const userType  = await getId("user_types",         "label", "id",            client_type);

    console.log(`🔢 Kódy: Reg:${regionId} | Krajina:${countryId} | Servis:${reqCat} | Typ:${userType}`);

    if ([regionId, countryId, reqCat, userType].includes(null)) {
        throw new Error(`Niektoré ID neboli nájdené — Reg:${regionId} | Krajina:${countryId} | Servis:${reqCat} | Typ:${userType}`);
    }

    const ticketCode = `${regionId}${countryId}${reqCat}${userType}`;

    const { error } = await getSupabase().from("tickets").insert({
        ticket_code:   ticketCode,
        status:        "open",
        Meno:          name          || null,
        email:         email         || null,
        opis_problemu: opis_problemu || null,
        created_at:    new Date().toISOString()
    });

    if (error) throw new Error(`Chyba pri zápise ticketu: ${error.message}`);

    console.log(`✅ Ticket ${ticketCode} vytvorený (Meno: ${name}, Email: ${email}, Opis: ${opis_problemu}).`);
    return ticketCode;
}

// ─── KROK 2: Načítaj najstarší open ticket ─────────────────────────────────────
async function ziskanieTicketu() {
    const { data } = await getSupabase()
        .from("tickets")
        .select("ticket_code")
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(1);

    if (!data?.length) {
        console.log("📭 Žiadne nové tickety na spracovanie.");
        return null;
    }

    const plnyKod = String(data[0].ticket_code);
    console.log(`🎫 Načítaný ticket: ${plnyKod}`);

    await getSupabase()
        .from("tickets")
        .update({ status: "processing" })
        .eq("ticket_code", plnyKod);

    return plnyKod;
}

// ─── KROK 3: Priraď zamestnanca ───────────────────────────────────────────────
async function priradZamestnanca(plnyKod) {
    if (!plnyKod || plnyKod.length < 8) {
        console.log(`❌ Neplatný kód ticketu (${plnyKod}).`);
        return null;
    }

    const kod6 = plnyKod.slice(0, 6);

    function vyrezStred(kod) {
        return kod.slice(0, 2) + kod.slice(4, 6);
    }

    const kod4 = vyrezStred(kod6);

    const { data: vsetci, error } = await getSupabase()
        .from("employees")
        .select("id, meno, zakaznik");

    if (error || !vsetci?.length) {
        console.log(`❌ Chyba pri načítaní zamestnancov.`);
        await getSupabase().from("tickets").update({ status: "unassigned" }).eq("ticket_code", plnyKod);
        return null;
    }

    console.log(`🔍 1. pokus — hľadám id = '${kod6}'`);
    let kandidati = vsetci.filter(z => z.id === kod6);

    if (!kandidati.length) {
        console.log(`⚠️ Nenašiel. 2. pokus — hľadám vyrezané id = '${kod4}'`);
        kandidati = vsetci.filter(z => vyrezStred(z.id) === kod4);
    }

    if (!kandidati.length) {
        console.log(`❌ Nenašiel sa žiadny zamestnanec pre ticket ${plnyKod}.`);
        await getSupabase().from("tickets").update({ status: "unassigned" }).eq("ticket_code", plnyKod);
        return null;
    }

    for (const zam of kandidati) {
        const aktualneTickety = zam.zakaznik?.length ?? 0;
        console.log(`👤 ${zam.meno} (${zam.id}) — aktívne tickety: ${aktualneTickety}/${TICKET_LIMIT}`);

        if (aktualneTickety >= TICKET_LIMIT) {
            console.log(`⛔ ${zam.meno} má plný limit. Preskakujem.`);
            continue;
        }

        const noveZakaznik = [...(zam.zakaznik ?? []), plnyKod];

        const { error: updateErr } = await getSupabase()
            .from("employees")
            .update({ zakaznik: noveZakaznik })
            .eq("id", zam.id);

        if (updateErr) {
            console.log(`❌ Chyba pri zápise: ${updateErr.message}`);
            continue;
        }

        await getSupabase()
            .from("tickets")
            .update({ status: "assigned" })
            .eq("ticket_code", plnyKod);

        console.log(`📝 ${zam.meno} — tickety: [${noveZakaznik.join(', ')}]`);
        return zam.meno;
    }

    console.log(`⛔ Všetci kandidáti majú plný limit.`);
    await getSupabase().from("tickets").update({ status: "open" }).eq("ticket_code", plnyKod);
    return null;
}

// ─── HLAVNÝ EXPORT ─────────────────────────────────────────────────────────────
async function runPipeline(vstup) {
    console.log("\n═══════════════════════════════════════");
    console.log(`🚀 Pipeline štart: ${vstup ? JSON.stringify(vstup) : 'auto režim'}`);
    console.log("═══════════════════════════════════════");

    await resetNepriradene();

    // FIX: create the ticket first (with all data), then pick it up and assign
    if (vstup) {
        await chatbotToTicket(vstup);
    }

    const plnyKod = await ziskanieTicketu();
    if (!plnyKod) return 'Žiadny ticket na priradenie.';

    const zamestnanec = await priradZamestnanca(plnyKod);

    const zaver = zamestnanec
        ? `Ticket ${plnyKod} priradený → ${zamestnanec}`
        : `Ticket ${plnyKod} zostal nepriradený.`;

    console.log(`🏁 ${zaver}\n`);
    return zaver;
}

module.exports = { runPipeline };
