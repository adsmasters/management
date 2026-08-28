/* Erzeugt test/cashflow-test.html aus der echten cashflow.html:
 * gleiche Oberfläche, aber ohne Supabase/Login – stattdessen die Fixture-DB
 * aus cashflow-test-db.js. So kann die Testseite nicht mehr veralten.
 * Ausführen:  node test/build-cashflow-test.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'cashflow.html'), 'utf8');
const v = Date.now();

const SCRIPTS_LIVE = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="js/db.js?v=20260827"></script>
<script src="js/auth.js"></script>
<script src="js/utils.js"></script>
<script src="js/cost-engine.js"></script>
<script src="js/cashflow-engine.js"></script>
<script src="js/cashflow.js?v=1"></script>
  <script defer src="https://adsmasters.github.io/hub/backlink.js"></script>
  <script src="js/nav.js"></script>`;

const SCRIPTS_TEST = `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="cashflow-test-db.js?v=${v}"></script>
<script src="../js/utils.js?v=${v}"></script>
<script src="../js/cost-engine.js?v=${v}"></script>
<script src="../js/cashflow-engine.js?v=${v}"></script>
<script src="../js/cashflow.js?v=${v}"></script>`;

if (!src.includes(SCRIPTS_LIVE)) {
  console.error('Script-Block in cashflow.html hat sich geändert – bitte SCRIPTS_LIVE hier anpassen.');
  process.exit(1);
}

const out = src
  .replace('<link rel="stylesheet" href="css/style.css">', '<link rel="stylesheet" href="../css/style.css">')
  .replace('<title>Cashflow – Adsmasters Management</title>', '<title>Test: Cashflow-Seite mit Fixture-DB</title>')
  .replace(SCRIPTS_LIVE, SCRIPTS_TEST);

fs.writeFileSync(path.join(__dirname, 'cashflow-test.html'), out);
console.log('test/cashflow-test.html neu erzeugt aus cashflow.html');
