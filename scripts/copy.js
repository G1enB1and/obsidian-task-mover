// Copies manifest.json & main.js to your vault plugin folder on each build.
// Edit VAULT_PATH to your actual vault path.
const fs = require('fs');
const path = require('path');

const VAULT_PATH = "C:\Obsidian\Dragon Cave\Dragon Cave";
const PLUGIN_ID = "task-mover";
const DEST = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID);

if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

for (const f of ["manifest.json", "main.js"]) {
  const src = path.join(process.cwd(), f);
  const dst = path.join(DEST, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}
console.log(`[copy] Deployed to ${DEST}`);
