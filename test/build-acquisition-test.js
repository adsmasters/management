/* Erzeugt test/acquisition-test.html aus der echten acquisition.html:
 * gleiche Oberfläche, aber ohne Supabase/Login – stattdessen die Fixture-DB
 * aus acquisition-test-db.js. So kann die Testseite nicht mehr veralten.
 * Ausführen:  node test/build-acquisition-test.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'acquisition.html'), 'utf8');
const v = Date.now();

const SCRIPTS_LIVE = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="js/db.js?v=20260610b"></script>
<script src="js/utils.js"></script>
<script src="js/auth.js"></script>
<script src="js/acquisition.js?v=20260904a"></script>
  <script defer src="https://adsmasters.github.io/hub/backlink.js"></script>
  <script src="js/nav.js"></script>`;

const SCRIPTS_TEST = `<script src="acquisition-test-db.js?v=${v}"></script>
<script src="../js/utils.js?v=${v}"></script>
<script src="../js/acquisition.js?v=${v}"></script>`;

if (!src.includes(SCRIPTS_LIVE)) {
  console.error('Script-Block in acquisition.html hat sich geändert – bitte SCRIPTS_LIVE hier anpassen.');
  process.exit(1);
}

const out = src
  .replace('<link rel="stylesheet" href="css/style.css">', '<link rel="stylesheet" href="../css/style.css">')
  .replace('<title>Akquisition – Adsmasters Management</title>', '<title>Test: Akquisition mit Fixture-DB</title>')
  .replace(SCRIPTS_LIVE, SCRIPTS_TEST);

fs.writeFileSync(path.join(__dirname, 'acquisition-test.html'), out);
console.log('test/acquisition-test.html neu erzeugt aus acquisition.html');
