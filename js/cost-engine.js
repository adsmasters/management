/* ===========================================================================
 * cost-engine.js – CSV-Parser + Kategorisierungs-/MwSt-/Ausschluss-Logik
 * Reine Funktionen (keine DOM-/DB-Abhängigkeit), nutzbar im Browser (window.CostEngine)
 * und in Node (module.exports) für Tests.
 * =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CostEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Hilfsfunktionen ───────────────────────────────────────────────────────

  // "1.999,20" / "-13109,63" / "10,79"  →  Number
  function parseGermanAmount(str) {
    if (str == null) return NaN;
    var s = String(str).trim().replace(/^"|"$/g, '').replace(/\s/g, '');
    if (!s) return NaN;
    s = s.replace(/\./g, '').replace(',', '.');   // Tausenderpunkt weg, Komma→Punkt
    return parseFloat(s);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // "31.03.26" (TT.MM.JJ) → { iso, year, month }
  function parseDateKsk(str) {
    var m = String(str || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
    if (!m) return null;
    var d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    return { iso: y + '-' + pad2(mo) + '-' + pad2(d), year: y, month: mo };
  }

  // "02/05/2026" (TT/MM/JJJJ) → { iso, year, month }
  function parseDateAmex(str) {
    var m = String(str || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (!m) return null;
    var d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    return { iso: y + '-' + pad2(mo) + '-' + pad2(d), year: y, month: mo };
  }

  // CSV-Zeile splitten mit Quote-Handling für ein gegebenes Trennzeichen.
  function splitLine(line, delim) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function splitRows(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n')
      .filter(function (l) { return l.trim().length > 0; });
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ── Parser: Kreissparkasse (Online Banking) ───────────────────────────────
  // Semikolon-getrennt, 17 Spalten. NUR Abflüsse (Betrag < 0) werden als
  // Kosten importiert; positive Gutschriften sind Umsätze (kommen aus Lexoffice).
  function parseKreissparkasse(text) {
    var rows = splitRows(text);
    if (!rows.length) return [];
    var out = [];
    for (var i = 1; i < rows.length; i++) {          // Zeile 0 = Header
      var p = splitLine(rows[i], ';');
      if (p.length < 5) continue;
      // Robust gegen vereinzelte Semikolons im Freitext: Betrag/Währung/Info vom Ende.
      var betrag = parseGermanAmount(p[p.length - 3]);
      if (!isFinite(betrag)) continue;
      if (betrag >= 0) continue;                     // Gutschrift = Umsatz → überspringen
      var dt = parseDateKsk(p[1]);
      if (!dt) continue;
      var bookingText = (p[3] || '').trim();
      var purpose     = (p[4] || '').trim();
      var payee       = (p[p.length - 6] || '').trim();   // Beguenstigter (vor IBAN/BIC/Betrag)
      var description = [payee, purpose, bookingText].filter(Boolean).join(' | ');
      out.push({
        source: 'kreissparkasse',
        tx_date: dt.iso, year: dt.year, month: dt.month,
        booking_text: bookingText, purpose: purpose, payee: payee,
        description: description,
        amount_gross: Math.round(-betrag * 100) / 100,  // Abfluss → positiver Kostenbeitrag
      });
    }
    return out;
  }

  // ── Parser: American Express ───────────────────────────────────────────────
  // Spalten: Datum;Beschreibung;Betrag  (Trennzeichen ',' ODER ';').
  // Belastung positiv = Kosten, Gutschrift/Ausgleich negativ.
  function parseAmex(text) {
    var rows = splitRows(text);
    if (!rows.length) return [];
    var header = rows[0];
    var delim = (header.split(';').length >= 3) ? ';' : ',';
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var p = splitLine(rows[i], delim);
      if (p.length < 3) continue;
      var betrag = parseGermanAmount(p[p.length - 1]);  // Betrag = letzte Spalte
      if (!isFinite(betrag)) continue;
      var dt = parseDateAmex(p[0]);
      if (!dt) continue;
      var desc = (p.slice(1, p.length - 1).join(' ') || '').replace(/\s+/g, ' ').trim();
      out.push({
        source: 'amex',
        tx_date: dt.iso, year: dt.year, month: dt.month,
        booking_text: '', purpose: desc, payee: desc,
        description: desc,
        amount_gross: Math.round(betrag * 100) / 100,
      });
    }
    return out;
  }

  function parseCsv(text, source) {
    return source === 'amex' ? parseAmex(text) : parseKreissparkasse(text);
  }

  // ── Regel-Matching ────────────────────────────────────────────────────────
  function ruleMatches(text, rule) {
    var hay = norm(text);
    var needle = norm(rule.pattern);
    if (!needle) return false;
    return (rule.match_type === 'equals') ? hay === needle : hay.indexOf(needle) !== -1;
  }

  // Erste passende Kategorie-Regel gewinnt → Kategorie oder null.
  function categorize(tx, categoryRules) {
    for (var i = 0; i < categoryRules.length; i++) {
      if (ruleMatches(tx.description, categoryRules[i])) return categoryRules[i].category;
    }
    return null;
  }

  // MwSt anhand passender Regel (mit optionalem Zeitfenster). Anteilig, auch bei
  // negativen Beträgen (Gutschriften enthalten ebenfalls MwSt).
  function applyVat(tx, vatRules) {
    var rate = 0;
    for (var i = 0; i < vatRules.length; i++) {
      var r = vatRules[i];
      if (!ruleMatches(tx.description, r)) continue;
      if (r.start_date && tx.tx_date < r.start_date) continue;
      if (r.end_date && tx.tx_date > r.end_date) continue;
      rate = Number(r.vat_rate) || 0;
      break;
    }
    var gross = tx.amount_gross;
    var vat = rate > 0 ? Math.round((gross - gross / (1 + rate)) * 100) / 100 : 0;
    return { vat_rate: rate, vat_amount: vat, amount_net: Math.round((gross - vat) * 100) / 100 };
  }

  function applyExclude(tx, excludeRules) {
    for (var i = 0; i < excludeRules.length; i++) {
      if (ruleMatches(tx.description, excludeRules[i])) {
        return { excluded: true, exclude_reason: excludeRules[i].reason || excludeRules[i].pattern };
      }
    }
    return { excluded: false, exclude_reason: null };
  }

  // Lohnsteuer-Beträge aus einem Finanzamt-Buchungstext extrahieren.
  // "... Umsatzsteuer Okt. 25 14.694,96 Lohnsteuer Nov. 25 4.557,73" → 4557.73
  function extractLohnsteuer(desc) {
    var toks = String(desc || '').split(/\s+/);
    var sum = 0, found = false;
    for (var i = 0; i < toks.length; i++) {
      if (!/lohnsteuer/i.test(toks[i])) continue;
      for (var j = i + 1; j < Math.min(toks.length, i + 6); j++) {
        var m = toks[j].match(/^(\d[\d.]*,\d{2})$/);   // dt. Betrag wie 4.557,73
        if (m) { sum += parseGermanAmount(m[1]); found = true; break; }
      }
    }
    return found ? Math.round(sum * 100) / 100 : null;
  }

  // Finanzamt-Sammelzahlung (Umsatzsteuer + Lohnsteuer in einer Lastschrift):
  // nur die Lohnsteuer ist echter Aufwand; der USt-Anteil ist Durchlauf.
  // Reihenfolge-unabhängig: greift, sobald Text BEIDE Steuerarten + Lohnsteuer-Betrag enthält.
  function isBundledTaxPayment(tx) {
    return /lohnsteuer/i.test(tx.description || '')
      && /umsatzsteuer/i.test(tx.description || '')
      && extractLohnsteuer(tx.description) != null;
  }

  // Eine Transaktion vollständig anreichern (Kategorie + MwSt + Ausschluss).
  function enrich(tx, rules) {
    var cat = categorize(tx, rules.categoryRules || []);
    var vat = applyVat(tx, rules.vatRules || []);
    var exc = applyExclude(tx, rules.excludeRules || []);
    var net = vat.amount_net;
    if (isBundledTaxPayment(tx)) {                   // immer als Lohnsteuer behandeln (egal welche Regel zuerst griff)
      cat = 'Employee';
      net = extractLohnsteuer(tx.description);
    }
    return Object.assign({}, tx, {
      category: cat,
      vat_rate: vat.vat_rate, vat_amount: vat.vat_amount, amount_net: net,
      excluded: exc.excluded, exclude_reason: exc.exclude_reason,
    });
  }

  function enrichAll(txs, rules) {
    return txs.map(function (t) { return enrich(t, rules); });
  }

  // ── Dedup-Hash ────────────────────────────────────────────────────────────
  // Signatur + Vorkommens-Index INNERHALB der Datei. Erneuter Upload derselben
  // (oder überlappender) Datei erzeugt identische Hashes → DB-Insert überspringt.
  // Zwei echte gleiche Buchungen einer Datei bekommen #0 und #1 → bleiben erhalten.
  function signature(tx) {
    var cents = Math.round(tx.amount_gross * 100);
    return tx.source + '|' + tx.tx_date + '|' + cents + '|' + norm(tx.description).slice(0, 80);
  }
  function assignDedupHashes(txs) {
    var seen = {};
    return txs.map(function (t) {
      var sig = signature(t);
      var occ = seen[sig] || 0;
      seen[sig] = occ + 1;
      return Object.assign({}, t, { dedup_hash: sig + '#' + occ });
    });
  }

  // ── Profit-Übersicht ──────────────────────────────────────────────────────
  // Aggregiert eingebundene Netto-Kosten je Monat + Kategorie.
  // settings: { [category]: include_in_profit(bool) }; fehlend ⇒ true.
  // Ausgeschlossene Zeilen zählen nie. Kategorien mit include=false fließen NICHT
  // in den Gewinn-vor-Steuern ein, werden aber als Memo erfasst.
  function included(category, settings) {
    var key = category == null ? '__uncategorized__' : category;
    if (settings && Object.prototype.hasOwnProperty.call(settings, key)) return !!settings[key];
    if (settings && category != null && Object.prototype.hasOwnProperty.call(settings, category)) return !!settings[category];
    return true; // Standard: zählt als Kosten
  }

  function summarize(transactions, settings) {
    settings = settings || {};
    var byMonth = {};   // 'YYYY-MM' → { costNet, excludedMemoNet, byCategory:{cat:net}, uncategorized:int }
    function bucket(key) {
      return byMonth[key] || (byMonth[key] = {
        year: 0, month: 0, costNet: 0, memoNet: 0, byCategory: {}, uncategorizedCount: 0,
      });
    }
    transactions.forEach(function (t) {
      var key = t.year + '-' + pad2(t.month);
      var b = bucket(key); b.year = t.year; b.month = t.month;
      var net = Number(t.amount_net != null ? t.amount_net : t.amount_gross) || 0;
      if (t.excluded) return;                       // Red Bull / Kreditkarten-Verrechnung etc.
      var cat = t.category == null ? '—' : t.category;
      if (included(t.category, settings)) {
        b.costNet += net;
        b.byCategory[cat] = (b.byCategory[cat] || 0) + net;
        if (t.category == null) b.uncategorizedCount++;
      } else {
        b.memoNet += net;                           // Steuern / Umsatzsteuer: nur Memo
        b.byCategory[cat] = (b.byCategory[cat] || 0) + net;
      }
    });
    return byMonth;
  }

  return {
    parseGermanAmount: parseGermanAmount,
    parseDateKsk: parseDateKsk,
    parseDateAmex: parseDateAmex,
    splitLine: splitLine,
    parseKreissparkasse: parseKreissparkasse,
    parseAmex: parseAmex,
    parseCsv: parseCsv,
    norm: norm,
    ruleMatches: ruleMatches,
    categorize: categorize,
    applyVat: applyVat,
    applyExclude: applyExclude,
    enrich: enrich,
    enrichAll: enrichAll,
    extractLohnsteuer: extractLohnsteuer,
    isBundledTaxPayment: isBundledTaxPayment,
    signature: signature,
    assignDedupHashes: assignDedupHashes,
    summarize: summarize,
    included: included,
  };
});
