// ics-fetch: holt den privaten ICS-Feed des Google-Urlaubskalenders serverseitig
// (Browser-Direktzugriff scheitert an CORS). Kein offener Proxy: nur Google-Kalender-Hosts.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { icsUrl } = await req.json();
    const u = new URL(String(icsUrl || ''));
    if (u.protocol !== 'https:' || !/(^|\.)(calendar\.)?google\.com$/.test(u.hostname)) {
      throw new Error('Nur https://calendar.google.com-Adressen erlaubt.');
    }
    const r = await fetch(u.toString(), { redirect: 'follow' });
    if (!r.ok) throw new Error('ICS-Abruf fehlgeschlagen: HTTP ' + r.status);
    const ics = await r.text();
    if (ics.indexOf('BEGIN:VCALENDAR') === -1) throw new Error('Antwort ist kein ICS-Kalender.');
    return new Response(JSON.stringify({ ics }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
