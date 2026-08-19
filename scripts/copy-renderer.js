// Copie le renderer (vanilla, DA dark) vers dist/renderer. Étape remplacée par
// `ng build` quand le renderer sera migré vers Angular (l'archi main/preload/moteur
// est déjà agnostique du framework).
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('renderer copié vers dist/renderer');
