/* ===========================================================================
 * cashflow-engine.js – Kontoumsätze (vorzeichenbehaftet) + 13-Wochen-Vorschau
 *
 * Baut auf cost-engine.js auf: CSV-Splitting, Betrags-/Datums-Parsing,
 * Regel-Matching und Kategorisierung werden NICHT neu geschrieben, sondern
 * wiederverwendet. Unterschied zur Kostenanalyse: hier zählen BEIDE
 * Richtungen (Eingänge wie Ausgänge), weil daraus der Kontostand entsteht.
 *
 * Reine Funktionen – nutzbar im Browser (window.CashflowEngine) und in Node.
 * =========================================================================== */
(function (root, factory) {
  var E = (typeof module !== 'undefined' && module.exports)
    ? require('./cost-engine.js')
    : (root && root.CostEngine);
  var api = factory(E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CashflowEngine = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function norm(s) { return E.norm(s); }

  // ── Konten/Quellen ────────────────────────────────────────────────────────
  var SOURCES = {
    kreissparkasse: { label: 'Kreissparkasse', kind: 'bank' },
    amex:           { label: 'American Express', kind: 'credit_card' },
  };

  // Sammelabbuchung der Kreditkarte im Bankkonto. Dieselben Muster wie die
  // eingebauten Ausschlüsse der Kostenanalyse (cost_exclude_rules, builtin).
  var CARD_SETTLEMENT_PATTERNS = [
    'american express', 'eigene kreditkartenabrechn', 'kreditkartenabrechnung',
  ];
  function isCardSettlement(tx) {
    if (tx.source !== 'kreissparkasse') return false;
    var hay = norm([tx.payee, tx.purpose, tx.booking_text, tx.description].join(' '));
    return CARD_SETTLEMENT_PATTERNS.some(function (p) { return hay.indexOf(p) !== -1; });
  }

  // Gegenstück auf der Karte: die eingegangene Zahlung der Kartenrechnung.
  // Gleiche Muster wie die eingebauten Ausschlüsse der Kostenanalyse.
  var CARD_PAYMENT_PATTERNS = ['ueberweisung erhalten besten dank', 'überweisung erhalten besten dank', 'zahlung erhalten'];
  function isCardPayment(tx) {
    if (tx.source !== 'amex') return false;
    return CARD_PAYMENT_PATTERNS.some(function (p) { return norm(tx.description).indexOf(norm(p)) !== -1; });
  }

  // Ad-Spend an Amazon: Standardmuster, per Einstellungen erweiterbar.
  var DEFAULT_ADSPEND_PATTERNS = ['amazon advertising', 'amazon ads', 'amazon media', 'advertising emea', 'amzn advertis'];
  // Weiterberechnung an Kunden (Durchlaufposten) – identisch zu den
  // Ausschluss-Keywords des Lexoffice-Syncs (DEFAULT_EXCLUDE dort).
  var DEFAULT_ADSPEND_INVOICE_KEYWORDS = ['media-budget', 'mediabudget', 'media budget', 'zweckgebundener ausgleich', 'werbekosten'];

  function matchesAny(text, patterns) {
    var hay = norm(text);
    return (patterns || []).some(function (p) { var n = norm(p); return n && hay.indexOf(n) !== -1; });
  }

  // ── CSV: Kreissparkasse (CAMT), vorzeichenbehaftet ────────────────────────
  // Spalten werden über den Header gefunden (robust gegen Reihenfolge/neue
  // Spalten), Fallback auf feste Positionen wie in cost-engine.
  function parseKreissparkasse(text) {
    var rows = splitRows(text);
    if (!rows.length) return [];
    var header = E.splitLine(rows[0], ';').map(norm);
    function col(name) { return header.indexOf(norm(name)); }
    var iDate = col('Buchungstag'), iVal = col('Valutadatum'), iBook = col('Buchungstext');
    var iPurp = col('Verwendungszweck'), iPayee = col('Beguenstigter/Zahlungspflichtiger');
    var iBetrag = col('Betrag');
    var get = function (p, idx, fallbackFromEnd) {
      if (idx >= 0 && idx < p.length) return p[idx];
      return fallbackFromEnd != null ? p[p.length - fallbackFromEnd] : '';
    };
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var p = E.splitLine(rows[i], ';');
      if (p.length < 5) continue;
      var betrag = E.parseGermanAmount(get(p, iBetrag, 3));
      if (!isFinite(betrag)) continue;
      var dt = E.parseDateKsk(get(p, iDate, null) || p[1]);
      if (!dt) continue;
      var val = E.parseDateKsk(get(p, iVal, null) || p[2]);
      var bookingText = (get(p, iBook, null) || p[3] || '').trim();
      var purpose = (get(p, iPurp, null) || p[4] || '').trim();
      var payee = (get(p, iPayee, 6) || '').trim();
      out.push({
        source: 'kreissparkasse',
        tx_date: dt.iso, value_date: val ? val.iso : dt.iso, year: dt.year, month: dt.month,
        booking_text: bookingText, purpose: purpose, payee: payee,
        description: [payee, purpose, bookingText].filter(Boolean).join(' | '),
        amount: round2(betrag),                     // Vorzeichen wie im Auszug
      });
    }
    return out;
  }

  function splitRows(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n').filter(function (l) { return l.trim().length > 0; });
  }

  // ── CSV: American Express, vorzeichenbehaftet ─────────────────────────────
  // Amex-Exporte unterscheiden sich: mal 3 Spalten (Datum;Beschreibung;Betrag),
  // mal mit Zusatzspalten (Karteninhaber, Konto, erweiterte Details). Betrag
  // wird deshalb über den Header gesucht, sonst über die letzte Zahlenspalte.
  // signMode: 'auto' | 'charge_positive' | 'charge_negative'
  function parseAmex(text, signMode) {
    var rows = splitRows(text);
    if (!rows.length) return [];
    var delim = pickDelimiter(rows[0]);
    var header = E.splitLine(rows[0], delim).map(norm);
    var hasHeader = header.some(function (h) { return /datum|date/.test(h); });
    var iAmt = indexOfAny(header, ['betrag', 'amount', 'summe']);
    var iDesc = indexOfAny(header, ['beschreibung', 'description', 'händler', 'haendler', 'merchant']);
    var iDate = indexOfAny(header, ['datum', 'date']);

    var raw = [];
    for (var i = hasHeader ? 1 : 0; i < rows.length; i++) {
      var p = E.splitLine(rows[i], delim);
      if (p.length < 2) continue;
      var betrag = E.parseGermanAmount(iAmt >= 0 && iAmt < p.length ? p[iAmt] : lastNumeric(p));
      if (!isFinite(betrag)) continue;
      var dt = E.parseDateAmex(p[iDate >= 0 ? iDate : 0]) || E.parseDateKsk(p[iDate >= 0 ? iDate : 0]);
      if (!dt) continue;
      var desc;
      if (iDesc >= 0 && iDesc < p.length) desc = p[iDesc];
      else desc = p.slice(1, Math.max(2, p.length - 1)).join(' ');
      desc = String(desc || '').replace(/\s+/g, ' ').trim();
      raw.push({
        source: 'amex',
        tx_date: dt.iso, value_date: dt.iso, year: dt.year, month: dt.month,
        booking_text: '', purpose: desc, payee: desc, description: desc,
        amount: round2(betrag),
      });
    }
    var invert = shouldInvertAmex(raw, signMode);
    return raw.map(function (t) {
      return invert ? Object.assign({}, t, { amount: round2(-t.amount) }) : t;
    });
  }

  // Auf einer Kreditkartenabrechnung sind die meisten Zeilen Belastungen.
  // Überwiegen positive Beträge, ist "positiv = Belastung" → drehen, damit
  // Ausgaben (wie im Bankkonto) negativ sind.
  function shouldInvertAmex(rows, signMode) {
    if (signMode === 'charge_positive') return true;
    if (signMode === 'charge_negative') return false;
    var pos = 0, neg = 0;
    rows.forEach(function (t) { if (t.amount > 0) pos++; else if (t.amount < 0) neg++; });
    return pos >= neg;
  }

  function pickDelimiter(line) {
    var counts = [[';', (line.match(/;/g) || []).length], [',', (line.match(/,/g) || []).length], ['\t', (line.match(/\t/g) || []).length]];
    counts.sort(function (a, b) { return b[1] - a[1]; });
    return counts[0][1] > 0 ? counts[0][0] : ';';
  }
  function indexOfAny(header, names) {
    for (var i = 0; i < header.length; i++) {
      for (var j = 0; j < names.length; j++) if (header[i].indexOf(names[j]) !== -1) return i;
    }
    return -1;
  }
  function lastNumeric(parts) {
    for (var i = parts.length - 1; i >= 0; i--) {
      if (isFinite(E.parseGermanAmount(parts[i]))) return parts[i];
    }
    return '';
  }

  function detectSource(text) {
    var head = (text || '').slice(0, 400).toLowerCase();
    if (head.indexOf('auftragskonto') !== -1 || head.indexOf('buchungstag') !== -1) return 'kreissparkasse';
    if (head.indexOf('beschreibung') !== -1 || head.indexOf('description') !== -1) return 'amex';
    return null;
  }

  function parseCsv(text, source, signMode) {
    return source === 'amex' ? parseAmex(text, signMode) : parseKreissparkasse(text);
  }

  // ── Dedup ─────────────────────────────────────────────────────────────────
  // Schlüssel laut Vorgabe: Buchungstag + Betrag + Verwendungszweck.
  // Quelle kommt dazu (sonst kollidieren Karte und Bank), plus Vorkommens-Index
  // innerhalb der Datei, damit zwei echte identische Buchungen erhalten bleiben.
  function dedupSignature(tx) {
    var cents = Math.round(tx.amount * 100);
    var purpose = norm(tx.purpose || tx.description).slice(0, 80);
    return tx.source + '|' + tx.tx_date + '|' + cents + '|' + purpose;
  }
  function assignDedupKeys(txs) {
    var seen = {};
    return txs.map(function (t) {
      var sig = dedupSignature(t);
      var occ = seen[sig] || 0;
      seen[sig] = occ + 1;
      return Object.assign({}, t, { dedup_key: sig + '#' + occ });
    });
  }

  // ── Anreicherung: Kategorie (Kostenanalyse-Regeln) + Flow-Typ ─────────────
  // Für die Kategorie wird die Buchung in die Form von cost_transactions
  // gebracht (amount_gross = positiver Kostenbeitrag) und CostEngine.enrich
  // benutzt – damit gelten exakt dieselben Regeln wie in der Kostenanalyse.
  function categoryOf(tx, rules) {
    var probe = {
      description: tx.description, tx_date: tx.tx_date,
      amount_gross: Math.abs(tx.amount),
    };
    return E.enrich(probe, rules || {}).category;
  }

  var SALARY_CATEGORIES = { 'Employee': 1, 'Gehalt': 1, 'Personal': 1 };
  var TAX_CATEGORIES = { 'Steuern': 1, 'Umsatzsteuer': 1 };

  function classifyFlow(tx, opts) {
    opts = opts || {};
    if (tx.is_card_settlement) return 'card_settlement';
    if (matchesAny(tx.description, opts.adspendPatterns || DEFAULT_ADSPEND_PATTERNS)) {
      return tx.amount >= 0 ? 'adspend_refund' : 'adspend_amazon';
    }
    if (tx.amount > 0) {
      if (matchesAny(tx.description, opts.adspendInvoiceKeywords || DEFAULT_ADSPEND_INVOICE_KEYWORDS)) return 'adspend_refund';
      if (isKnownClient(tx.payee || tx.description, opts.clientNames)) return 'client_payment';
      return 'other_in';
    }
    if (SALARY_CATEGORIES[tx.category]) return 'salary';
    if (TAX_CATEGORIES[tx.category]) return 'tax';
    return 'other_out';
  }

  function isKnownClient(name, clientNames) {
    if (!clientNames || !clientNames.length) return false;
    var hay = norm(name);
    if (!hay) return false;
    return clientNames.some(function (c) {
      var n = norm(c);
      return n.length >= 4 && (hay.indexOf(n) !== -1 || n.indexOf(hay) !== -1);
    });
  }

  function enrich(tx, opts) {
    opts = opts || {};
    var settlement = isCardSettlement(tx) || isCardPayment(tx);
    var category = categoryOf(tx, opts.rules);
    var full = Object.assign({}, tx, { is_card_settlement: settlement, category: category });
    return Object.assign(full, { flow_type: classifyFlow(full, opts) });
  }
  function enrichAll(txs, opts) { return txs.map(function (t) { return enrich(t, opts); }); }

  // ── Kontostand ────────────────────────────────────────────────────────────
  // Bankkonto: Anfangssaldo + Summe aller Bank-Buchungen (die Sammelabbuchung
  // der Karte IST Teil des Kontostands – nur in der Kostenanalyse wird sie
  // ausgeschlossen, damit die Einzelposten nicht doppelt zählen).
  // Kreditkarte: offener Saldo seit der letzten Sammelabbuchung (Verbindlichkeit).
  function balances(txs, accounts) {
    var byAccount = {};
    (accounts || []).forEach(function (a) {
      byAccount[a.source] = {
        source: a.source, name: a.name || (SOURCES[a.source] || {}).label || a.source,
        kind: a.kind || (SOURCES[a.source] || {}).kind || 'bank',
        opening_balance: Number(a.opening_balance) || 0,
        opening_date: a.opening_date || null,
        balance: Number(a.opening_balance) || 0, count: 0, first: null, last: null,
      };
    });
    (txs || []).forEach(function (t) {
      var a = byAccount[t.source] || (byAccount[t.source] = {
        source: t.source, name: (SOURCES[t.source] || {}).label || t.source,
        kind: (SOURCES[t.source] || {}).kind || 'bank',
        opening_balance: 0, opening_date: null, balance: 0, count: 0, first: null, last: null,
      });
      if (a.opening_date && t.tx_date < a.opening_date) return;   // vor dem Anfangssaldo → ignorieren
      a.balance = round2(a.balance + (Number(t.amount) || 0));
      a.count++;
      if (!a.first || t.tx_date < a.first) a.first = t.tx_date;
      if (!a.last || t.tx_date > a.last) a.last = t.tx_date;
    });
    var list = Object.keys(byAccount).map(function (k) { return byAccount[k]; });
    var bank = list.filter(function (a) { return a.kind !== 'credit_card'; })
      .reduce(function (s, a) { return round2(s + a.balance); }, 0);
    var card = list.filter(function (a) { return a.kind === 'credit_card'; })
      .reduce(function (s, a) { return round2(s + a.balance); }, 0);
    return { accounts: list, bank: bank, card: card, cardOpen: cardOpenBalance(txs) };
  }

  // Noch nicht abgerechnete Kartenumsätze: alle Amex-Buchungen NACH der letzten
  // Abrechnung. Als Stichtag zählt der spätere der beiden Marker – die
  // Sammelabbuchung im Bankkonto und die auf der Karte gutgeschriebene Zahlung.
  // Ergebnis ist negativ = offene Verbindlichkeit (nächste Abbuchung).
  function cardOpenBalance(txs) {
    var lastSettle = (txs || []).reduce(function (m, t) {
      if (!(isCardSettlement(t) || isCardPayment(t))) return m;
      return (!m || t.tx_date > m) ? t.tx_date : m;
    }, null);
    var open = (txs || []).filter(function (t) {
      return t.source === 'amex' && (!lastSettle || t.tx_date > lastSettle);
    }).reduce(function (s, t) { return round2(s + (Number(t.amount) || 0)); }, 0);
    return { amount: open, since: lastSettle };
  }

  // ── Ist-Cashflow je Monat ────────────────────────────────────────────────
  // Basis sind die BANK-Buchungen (Karte würde doppelt zählen: die Karte wird
  // per Sammelabbuchung vom Bankkonto bezahlt). Die Kartenposten dienen der
  // Kategorisierung der Ausgaben, nicht dem Saldo.
  function monthlyActuals(txs, accounts) {
    var bankSources = {};
    (accounts || []).forEach(function (a) { if ((a.kind || 'bank') !== 'credit_card') bankSources[a.source] = 1; });
    if (!Object.keys(bankSources).length) bankSources.kreissparkasse = 1;
    var opening = (accounts || []).filter(function (a) { return (a.kind || 'bank') !== 'credit_card'; })
      .reduce(function (s, a) { return round2(s + (Number(a.opening_balance) || 0)); }, 0);

    var byMonth = {};
    (txs || []).forEach(function (t) {
      if (!bankSources[t.source]) return;
      var key = t.year + '-' + pad2(t.month);
      var b = byMonth[key] || (byMonth[key] = { key: key, year: t.year, month: t.month, inflow: 0, outflow: 0 });
      if (t.amount >= 0) b.inflow = round2(b.inflow + t.amount);
      else b.outflow = round2(b.outflow + Math.abs(t.amount));
    });
    var keys = Object.keys(byMonth).sort();
    var running = opening;
    return keys.map(function (k) {
      var b = byMonth[k];
      b.delta = round2(b.inflow - b.outflow);
      running = round2(running + b.delta);
      b.endBalance = running;
      return b;
    });
  }

  // Ausgaben-Kategorien je Monat – nach den Regeln der Kostenanalyse.
  // Kartenposten zählen einzeln, die Sammelabbuchung fliegt raus (sonst doppelt).
  function monthlyCategories(txs) {
    var byMonth = {};
    (txs || []).forEach(function (t) {
      if (t.is_card_settlement) return;
      if (t.amount >= 0) return;
      var key = t.year + '-' + pad2(t.month);
      var b = byMonth[key] || (byMonth[key] = {});
      var cat = t.category || '(unkategorisiert)';
      b[cat] = round2((b[cat] || 0) + Math.abs(t.amount));
    });
    return byMonth;
  }

  // ── Datums-Helfer (rein kalendarisch, ohne Zeitzonen-Falle) ──────────────
  function toDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  function toIso(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function addDays(iso, n) {
    var d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d);
  }
  function mondayOf(iso) {
    var d = toDate(iso);
    var dow = d.getUTCDay();                    // 0=So
    var diff = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + diff);
    return toIso(d);
  }
  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  function isoOf(year, month, day) {
    return year + '-' + pad2(month) + '-' + Math.min(day, daysInMonth(year, month));
  }
  function monthsBetween(fromIso, toIso_) {
    var a = toDate(fromIso), b = toDate(toIso_), out = [];
    var y = a.getUTCFullYear(), m = a.getUTCMonth() + 1;
    while (y * 12 + m <= b.getUTCFullYear() * 12 + (b.getUTCMonth() + 1)) {
      out.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Fällige Termine einer Fixkosten-Zeile im Zeitraum.
  function fixedCostDates(fc, fromIso, toIso_) {
    var out = [];
    monthsBetween(fromIso, toIso_).forEach(function (ym) {
      if (fc.rhythm === 'quarterly') {
        var anchor = ((Number(fc.start_month) || 1) - 1) % 3;
        if ((ym.month - 1) % 3 !== anchor) return;
      } else if (fc.rhythm === 'yearly') {
        if (ym.month !== (Number(fc.start_month) || 1)) return;
      }
      var iso = isoOf(ym.year, ym.month, Math.max(1, Math.min(31, Number(fc.pay_day) || 1)));
      if (iso >= fromIso && iso <= toIso_) out.push(iso);
    });
    return out;
  }

  // ── Umsatzsteuer-Voranmeldung ────────────────────────────────────────────
  // Zahltag: 10. des Folgemonats, mit Dauerfristverlängerung 10. des übernächsten.
  // Fällt der 10. auf ein Wochenende, verschiebt das Finanzamt auf den nächsten
  // Werktag – für die Liquiditätsplanung bleibt der spätere Termin konservativ.
  function ustvaDueDate(year, month, permanentExtension) {
    var shift = permanentExtension ? 2 : 1;
    var m = month + shift, y = year;
    while (m > 12) { m -= 12; y++; }
    return isoOf(y, m, 10);
  }

  // Schätzung: Umsatzsteuer aus den Rechnungen des Zeitraums minus Vorsteuer
  // aus den Buchungen desselben Zeitraums.
  function estimateUstva(opts) {
    var netRevenue = Number(opts.netRevenue) || 0;
    var rate = opts.vatRate != null ? Number(opts.vatRate) : 0.19;
    var inputVat = Number(opts.inputVat) || 0;
    return round2(Math.max(0, netRevenue * rate - inputVat));
  }

  // ── Fixkosten-Vorschlag aus der Kostenanalyse ────────────────────────────
  // Nimmt die vorhandenen cost_transactions und findet wiederkehrende Zahlungen:
  // Lieferant (gleiche Logik wie die Regel-Vorschläge der Kostenanalyse),
  // Median-Betrag je Monat und Median-Zahltag. Damit muss der Fixkosten-Plan
  // nicht abgetippt werden.
  var BUCKET_BY_CATEGORY = {
    'Employee': 'salary',
    'Freelancer/Externe': 'supplier',
    'Büro': 'supplier',
    'Software': 'supplier',
    'Equipment': 'other_out',
    'Marketing': 'other_out',
    'Recruitment': 'other_out',
    'Reisekosten': 'other_out',
    'Restaurant': 'other_out',
    'Hotel': 'other_out',
    'Team-Event': 'other_out',
    'PayPal': 'other_out',
    'Andere': 'other_out',
  };
  // Steuern gehören in den Reiter Steuertermine (sonst doppelt zur UStVA-Schätzung).
  var SKIP_CATEGORIES = { 'Steuern': 1, 'Umsatzsteuer': 1 };

  // Lieferantenname ohne angehängte Transaktions-IDs – identisch zur
  // Pattern-Heuristik in kostenanalyse.js.
  function vendorName(text) {
    var s = String(text || '').split('|')[0].trim();
    var toks = s.split(/\s+/), out = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var digitCount = (t.match(/\d/g) || []).length;
      if ((/^\d+$/.test(t) && t.length >= 4) || digitCount >= 5) break;
      out.push(t);
    }
    return out.join(' ').replace(/[\s.,;:_\-]+$/, '').trim() || s;
  }

  // Bewusst OHNE Rundung: der Median wird auch auf Quoten angewendet
  // (effektiver USt-Satz). Geldbeträge werden am Aufrufort gerundet.
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // costTxs: Zeilen aus cost_transactions (amount_gross positiv = Kosten).
  // opts: { months: 6, minMonths: 4, today: 'YYYY-MM-DD', minAmount: 50 }
  function suggestFixedCosts(costTxs, opts) {
    opts = opts || {};
    var months = opts.months || 6;
    var minMonths = opts.minMonths || Math.max(2, Math.ceil(months * 2 / 3));
    var minAmount = opts.minAmount != null ? opts.minAmount : 50;
    var today = opts.today;
    var fromIso = null;
    if (today) {
      var y = +today.slice(0, 4), m = +today.slice(5, 7) - months;
      while (m < 1) { m += 12; y--; }
      fromIso = isoOf(y, m, 1);
    }

    var groups = {};
    (costTxs || []).forEach(function (t) {
      if (t.excluded) return;
      var gross = Number(t.amount_gross) || 0;
      if (gross <= 0) return;
      if (fromIso && t.tx_date < fromIso) return;

      var bundled = E.isBundledTaxPayment(t);
      var isLohnsteuer = /lohnsteuer/i.test(t.description || '');
      var category = t.category, amount = gross, label = null;
      if (t.is_card_settlement) {
        // Kartenabrechnung ist eine echte wiederkehrende Zahlung – aber eine
        // eigene Zeile, damit sie nicht mit der nächsten Abbuchung kollidiert.
        label = 'Amex-Sammelabbuchung';
        category = null;
      } else if (bundled) {
        // Sammellastschrift ans Finanzamt: nur der Lohnsteuer-Anteil ist
        // planbare Personalzahlung, der USt-Anteil steckt in der UStVA-Zeile.
        amount = Number(t.amount_net) || 0;
        category = 'Employee';
        label = 'Lohnsteuer (Finanzamt)';
      } else if (isLohnsteuer) {
        // Reine Lohnsteuer-Lastschrift: gehört in dieselbe Gruppe, sonst
        // zerfällt der Posten je nach Monat in zwei Zeilen.
        category = 'Employee';
        label = 'Lohnsteuer (Finanzamt)';
      } else if (SKIP_CATEGORIES[category]) {
        return;
      }
      if (amount <= 0) return;

      var name = label || vendorName(t.payee || t.description);
      var key = norm(name);
      var g = groups[key] || (groups[key] = { label: name, category: category, byMonth: {}, days: [] });
      var mk = t.tx_date.slice(0, 7);
      g.byMonth[mk] = round2((g.byMonth[mk] || 0) + amount);
      g.days.push(+t.tx_date.slice(8, 10));
      if (!g.category) g.category = category;
    });

    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      var keys = Object.keys(g.byMonth).sort();
      var vals = keys.map(function (m) { return g.byMonth[m]; });
      var amount = round2(median(vals));
      return {
        label: g.label,
        category: g.category || null,
        bucket: g.label === 'Amex-Sammelabbuchung' ? 'card_settlement'
                : (BUCKET_BY_CATEGORY[g.category] || 'other_out'),
        amount: amount,
        pay_day: Math.round(median(g.days)) || 1,
        rhythm: 'monthly',
        monthsSeen: keys.length,
        monthsChecked: months,
        spread: vals.length ? round2(Math.max.apply(null, vals) / Math.max(0.01, Math.min.apply(null, vals))) : 1,
        lastMonth: keys[keys.length - 1] || null,
      };
    }).filter(function (x) {
      return x.monthsSeen >= minMonths && x.amount >= minAmount;
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  // ── Umsatzsteuer: effektiver Satz aus der eigenen Zahlungshistorie ────────
  // Das Modell "Netto-Umsatz × 19 % − Vorsteuer" überschätzt die Zahlung, wenn
  // ein Teil des Umsatzes Reverse-Charge ist (EU/UK ohne deutsche USt).
  // Deshalb den Satz aus den tatsächlichen Finanzamt-Zahlungen ableiten:
  // je Voranmeldungszeitraum USt-Zahlung / Netto-Umsatz, davon der Median.
  var MONTH_ABBR = { jan: 1, feb: 2, mrz: 3, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12 };

  // "… Umsatzsteuer Jan. 26 10.106,41 Lohnsteuer Mrz. 26 4.807,61" → '2026-01'
  function ustPeriod(description) {
    var m = String(description || '').match(/umsatzsteuer\s+([a-zäöü]{3})[a-zäöü]*\.?\s*(\d{2,4})/i);
    if (!m) return null;
    var mm = MONTH_ABBR[m[1].toLowerCase()];
    if (!mm) return null;
    var yy = +m[2];
    if (yy < 100) yy += 2000;
    return yy + '-' + pad2(mm);
  }

  // Tatsächlich gezahlte Umsatzsteuer je Zeitraum aus den Finanzamt-Buchungen.
  // Bei Sammellastschriften ist amount_net der Lohnsteuer-Anteil → USt = brutto − netto.
  function actualVatPayments(costTxs) {
    var out = [];
    (costTxs || []).forEach(function (t) {
      if (t.excluded) return;
      if (!/umsatzsteuer/i.test(t.description || '')) return;
      var gross = Number(t.amount_gross) || 0;
      var net = Number(t.amount_net != null ? t.amount_net : gross);
      var vat = net < gross ? round2(gross - net) : gross;
      if (vat <= 0) return;
      out.push({ tx_date: t.tx_date, amount: vat, period: ustPeriod(t.description), paidTotal: gross });
    });
    return out.sort(function (a, b) { return a.tx_date < b.tx_date ? -1 : 1; });
  }

  // revenueByPeriod: { 'YYYY-MM': netto } → { rate, samples:[{period,vat,revenue,rate}] }
  function effectiveVatRate(costTxs, revenueByPeriod) {
    var samples = [];
    actualVatPayments(costTxs).forEach(function (p) {
      var rev = p.period ? Number(revenueByPeriod[p.period]) : 0;
      if (!rev || rev <= 0) return;
      samples.push({ period: p.period, vat: p.amount, revenue: round2(rev), rate: p.amount / rev });
    });
    return {
      rate: samples.length ? median(samples.map(function (s) { return s.rate; })) : null,
      samples: samples,
    };
  }

  // ── 13-Wochen-Vorschau ───────────────────────────────────────────────────
  // Erwartete Struktur der Eingaben:
  //   startBalance   Kontostand heute (Bankkonten)
  //   invoices       [{ contact, dueDate, amount, isAdSpend }]   Ausgangsrechnungen (brutto)
  //   apInvoices     [{ supplier, due_date, amount, kind }]      Eingangsrechnungen/Sonstiges
  //   fixedCosts     [{ label, amount, pay_day, rhythm, start_month, bucket, active }]
  //   taxDates       [{ label, due_date, amount, kind }]
  //   cardSettlement { amount, date }                            offene Kartenumsätze
  var BUCKETS = ['clientPayments', 'adSpendRefunds', 'otherIn', 'salaries', 'suppliers', 'adSpendAmazon', 'taxes', 'otherOut'];

  function emptyWeek(startIso, idx) {
    var w = { index: idx, from: startIso, to: addDays(startIso, 6), startBalance: 0, endBalance: 0, items: [] };
    BUCKETS.forEach(function (b) { w[b] = 0; });
    return w;
  }

  function buildForecast(opts) {
    opts = opts || {};
    var weeks = opts.weeks || 13;
    var today = opts.today;
    var start = mondayOf(today);
    var list = [];
    for (var i = 0; i < weeks; i++) list.push(emptyWeek(addDays(start, i * 7), i));
    var lastDay = list[list.length - 1].to;

    function weekFor(iso) {
      if (!iso) return null;
      // Alles was heute oder früher fällig ist (auch Überfälliges) landet in Woche 1.
      var d = iso < today ? today : iso;
      if (d > lastDay) return null;
      var idx = Math.floor((toDate(d) - toDate(start)) / 604800000);
      return list[Math.max(0, Math.min(weeks - 1, idx))];
    }
    function add(iso, bucket, amount, label) {
      var w = weekFor(iso);
      if (!w || !amount) return;
      w[bucket] = round2(w[bucket] + amount);
      w.items.push({ date: iso, bucket: bucket, amount: round2(amount), label: label });
    }

    // Ausgangsrechnungen nach Fälligkeit (brutto – so kommt das Geld an)
    (opts.invoices || []).forEach(function (v) {
      var amt = Number(v.amount) || 0;
      if (!amt) return;
      add(v.dueDate || today, v.isAdSpend ? 'adSpendRefunds' : 'clientPayments', amt,
        v.contact || 'Rechnung');
    });

    // Eingangsrechnungen & sonstige geplante Zahlungen
    (opts.apInvoices || []).forEach(function (a) {
      if (a.paid) return;
      var amt = Number(a.amount) || 0;
      if (!amt) return;
      if (a.kind === 'other_income') add(a.due_date, 'otherIn', amt, a.supplier || 'Sonstiger Eingang');
      else if (a.kind === 'adspend_amazon') add(a.due_date, 'adSpendAmazon', -amt, a.supplier || 'Amazon Ad-Spend');
      else add(a.due_date, 'suppliers', -amt, a.supplier || 'Lieferant');
    });

    // Fixkosten
    var bucketMap = { salary: 'salaries', supplier: 'suppliers', adspend_amazon: 'adSpendAmazon',
                      tax: 'taxes', other_out: 'otherOut', card_settlement: 'otherOut' };
    var cs0 = opts.cardSettlement;
    (opts.fixedCosts || []).forEach(function (fc) {
      if (fc.active === false) return;
      var amt = Number(fc.amount) || 0;
      if (!amt) return;
      var bucket = bucketMap[fc.bucket] || 'otherOut';
      fixedCostDates(fc, start, lastDay).forEach(function (iso) {
        // Die nächste Kartenabrechnung steht mit dem echten offenen Saldo drin –
        // der wiederkehrende Planwert würde sie sonst doppelt buchen.
        if (fc.bucket === 'card_settlement' && cs0 && cs0.amount && iso === cs0.date) return;
        add(iso, bucket, -Math.abs(amt), fc.label);
      });
    });

    // Steuertermine
    (opts.taxDates || []).forEach(function (t) {
      var amt = Number(t.amount) || 0;
      if (!amt) return;
      add(t.due_date, 'taxes', -Math.abs(amt), t.label);
    });

    // Offene Kartenumsätze → nächste Sammelabbuchung
    var cs = opts.cardSettlement;
    if (cs && cs.amount) add(cs.date, 'otherOut', -Math.abs(cs.amount), 'Amex-Sammelabbuchung');

    // Salden fortschreiben
    var running = round2(Number(opts.startBalance) || 0);
    list.forEach(function (w) {
      w.startBalance = running;
      w.net = round2(BUCKETS.reduce(function (s, b) { return s + w[b]; }, 0));
      running = round2(running + w.net);
      w.endBalance = running;
      w.items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    });
    return list;
  }

  function lowestPoint(weeks) {
    var min = null;
    (weeks || []).forEach(function (w) { if (!min || w.endBalance < min.endBalance) min = w; });
    return min;
  }

  return {
    SOURCES: SOURCES,
    DEFAULT_ADSPEND_PATTERNS: DEFAULT_ADSPEND_PATTERNS,
    DEFAULT_ADSPEND_INVOICE_KEYWORDS: DEFAULT_ADSPEND_INVOICE_KEYWORDS,
    BUCKETS: BUCKETS,
    parseKreissparkasse: parseKreissparkasse,
    parseAmex: parseAmex,
    parseCsv: parseCsv,
    detectSource: detectSource,
    shouldInvertAmex: shouldInvertAmex,
    isCardSettlement: isCardSettlement,
    isCardPayment: isCardPayment,
    matchesAny: matchesAny,
    dedupSignature: dedupSignature,
    assignDedupKeys: assignDedupKeys,
    categoryOf: categoryOf,
    classifyFlow: classifyFlow,
    enrich: enrich,
    enrichAll: enrichAll,
    balances: balances,
    cardOpenBalance: cardOpenBalance,
    monthlyActuals: monthlyActuals,
    monthlyCategories: monthlyCategories,
    fixedCostDates: fixedCostDates,
    ustvaDueDate: ustvaDueDate,
    estimateUstva: estimateUstva,
    suggestFixedCosts: suggestFixedCosts,
    vendorName: vendorName,
    median: median,
    ustPeriod: ustPeriod,
    actualVatPayments: actualVatPayments,
    effectiveVatRate: effectiveVatRate,
    buildForecast: buildForecast,
    lowestPoint: lowestPoint,
    mondayOf: mondayOf, addDays: addDays, isoOf: isoOf, monthsBetween: monthsBetween,
    round2: round2,
  };
});
