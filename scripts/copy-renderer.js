// Copie le renderer (vanilla, DA dark) vers dist/renderer. Étape remplacée par
// `ng build` quand le renderer sera migré vers Angular (l'archi main/preload/moteur
// est déjà agnostique du framework).
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dst, { recursive: true });
// ⚠️ RÉCURSIF, et ça compte : la boucle ne copiait que les FICHIERS de premier niveau. Les
// catalogues de traduction vivent dans `locales/` : sans récursion ils n'arrivaient jamais
// dans le build, et l'app serait restée en français quoi qu'on choisisse, en silence.
// Re-vérification : `ls dist/renderer/locales/` doit lister fr/en/it/es/pt.
let copies = 0;
(function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, e.name);
        const d = path.join(to, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else { fs.copyFileSync(s, d); copies++; }
    }
})(src, dst);
console.log(`renderer copié vers dist/renderer (${copies} fichiers)`);
