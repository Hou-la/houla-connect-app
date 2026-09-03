const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// QUESTION POSÉE PAR LE PROPRIÉTAIRE : un pack tiers affiche 40 lignes de codes de triche en
// texte brut, sans coloration ni bouton « Copier ». Est-ce que le créateur a oublié les
// balises, ou est-ce que NOTRE rendu Markdown est cassé ?
//
// RÉPONSE MESURÉE : les instructions de mk8dx v1.0.9 en production contiennent ZÉRO backtick
// (ni ``` ni `). Le créateur n'a rien balisé. Le moteur, lui, fait bien son travail : ces
// tests le verrouillent, parce que lire `case 'codeblock'` dans l'éditeur ne prouve RIEN sur
// le rendu.
//
// ⚠️ PIÈGE DANS LEQUEL JE SUIS TOMBÉ en écrivant ces tests : asserter le contenu sur le HTML
// BRUT échoue alors que le rendu est parfait, parce que la coloration syntaxique découpe
// « 58020000 00F53448 » en <span class="c-hex">…</span>. Le TEXTE se vérifie sur textContent,
// la STRUCTURE sur le HTML. Un test faux qui accuse le code est pire qu'un test absent.

const CODE = ['80002000', '58020000 00F53448', '20000000'].join('\n');

const render = (page, md) => page.evaluate((md) => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    window.renderMarkdownInto(el, md);
    return { html: el.innerHTML, text: el.textContent };
}, md);

test('un bloc ``` devient un bloc de code AVEC bouton Copier', async ({ page }) => {
    await boot(page, {});
    const r = await render(page, '# Titre\n\nColle ceci :\n\n```\n' + CODE + '\n```\n');
    expect(r.html).toContain('md-code');
    expect(r.html).toContain('md-copy');
    expect(r.html).toContain('<code');
    expect(r.text).toContain('58020000 00F53448'); // contenu : sur le TEXTE
    expect(r.html).toContain('c-hex');             // et la coloration a bien tourné
});

test('le bouton Copier met VRAIMENT le code dans le presse-papiers', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, {});
    await page.evaluate((md) => {
        const el = document.createElement('div');
        el.id = 'md-test';
        document.body.appendChild(el);
        window.renderMarkdownInto(el, md);
    }, '```\n' + CODE + '\n```');
    await page.locator('#md-test .md-copy').click();
    // CONTRE-TÉMOIN : « le bouton existe » ne prouve pas qu'il copie. On relit le presse-papiers.
    await expect(page.locator('#md-test .md-copy')).toContainText(/Copié/i);
    const colle = await page.evaluate(() => navigator.clipboard.readText());
    expect(colle.replace(/\r/g, '').trim()).toBe(CODE);
});

test('la langue annoncée après ``` est reprise dans l’en-tête du bloc', async ({ page }) => {
    await boot(page, {});
    const r = await render(page, '```json\n{"a":1}\n```');
    expect(r.html).toContain('json');
});

test('SANS balises, le texte reste du texte : c’est le cas du pack Mario Kart', async ({ page }) => {
    // Reproduit fidèlement ce qu'a écrit le créateur : des lignes brutes, aucun backtick.
    await boot(page, {});
    const r = await render(page, 'Faites un Copier/Coller du code suivant :\n\n' + CODE);
    expect(r.html).not.toContain('md-code'); // rien à reprocher au moteur : rien n'est balisé
    expect(r.text).toContain('80002000');    // le texte est là, juste pas dans un bloc
});

test('le rendu reste SÛR : une balise script dans les instructions n’est jamais exécutée', async ({ page }) => {
    // Les instructions sont écrites par des tiers et affichées à tous les joueurs : c'est une
    // surface d'injection. Le moteur doit échapper, pas interpréter.
    await boot(page, {});
    const r = await render(page, 'Bonjour <script>window.__PWN__ = 1;</script> fin');
    expect(r.html).not.toContain('<script');
    expect(await page.evaluate(() => window.__PWN__)).toBeUndefined();
});
