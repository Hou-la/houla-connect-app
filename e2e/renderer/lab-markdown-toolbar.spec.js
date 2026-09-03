const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// HYPOTHÈSE DU PROPRIÉTAIRE, après qu'un pack tiers a publié 40 lignes de codes de triche en
// texte brut : « ça se trouve, c'est le bouton Code de l'éditeur qui ne met pas les bonnes
// balises ». Elle mérite une mesure, pas une supposition : la barre expose DEUX boutons,
// « <> » (code en ligne, un backtick) et « { } » (bloc, trois backticks), et se tromper de
// bouton produit exactement le symptôme observé.

const ouvrirLab = async (page) => {
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#lab-instructions')).toBeVisible();
};
const saisir = async (page, txt) => {
    await page.locator('#lab-instructions').fill(txt);
    await page.locator('#lab-instructions').selectText();
};
const valeur = (page) => page.locator('#lab-instructions').inputValue();

test('« { } » produit un VRAI bloc, avec trois backticks et des sauts de ligne', async ({ page }) => {
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await saisir(page, '80002000');
    await page.locator('#lab-instr-toolbar .md-tool[data-md="codeblock"]').click();

    const v = await valeur(page);
    expect(v).toContain('```');
    // le contenu doit être sur sa PROPRE ligne, sinon ce n'est pas un bloc mais du charabia
    expect(v).toMatch(/```\n80002000\n```/);
    // et il doit y avoir DEUX clôtures, pas une
    expect((v.match(/```/g) || []).length).toBe(2);
});

test('« <> » produit du code EN LIGNE (un seul backtick), pas un bloc', async ({ page }) => {
    // C'est la confusion qui explique le symptôme : un créateur qui clique « <> » sur
    // 40 lignes obtient un bloc en ligne illisible, pas un bloc de code.
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await saisir(page, 'espace');
    await page.locator('#lab-instr-toolbar .md-tool[data-md="code"]').click();

    const v = await valeur(page);
    expect(v).toContain('`espace`');
    expect(v).not.toContain('```');
});

test('ce que « { } » écrit est RENDU comme un bloc copiable (bout en bout)', async ({ page }) => {
    // Contre-témoin du test précédent : produire des backticks ne prouve pas que le rendu
    // suit. On rejoue la sortie de l'éditeur dans le moteur de rendu.
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await saisir(page, '80002000\n20000000');
    await page.locator('#lab-instr-toolbar .md-tool[data-md="codeblock"]').click();
    const v = await valeur(page);

    const r = await page.evaluate((md) => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        window.renderMarkdownInto(el, md);
        return { html: el.innerHTML, text: el.textContent };
    }, v);
    expect(r.html).toContain('md-code');
    expect(r.html).toContain('md-copy');
    expect(r.text).toContain('80002000');
});

test('sans rien sélectionner, « { } » insère un bloc avec un texte d’amorce', async ({ page }) => {
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await page.locator('#lab-instructions').fill('');
    await page.locator('#lab-instructions').click();
    await page.locator('#lab-instr-toolbar .md-tool[data-md="codeblock"]').click();
    const v = await valeur(page);
    expect(v).toMatch(/```\n.+\n```/); // jamais un bloc vide, on amorce
});

test('la DESCRIPTION a le même éditeur, et écrit dans le BON champ', async ({ page }) => {
    // Ajouté à la demande du propriétaire : la description est le premier texte lu dans le
    // store, elle n'avait aucune mise en forme. Le piège d'implémentation était que la barre
    // écrive dans les instructions : `applyMdTool` visait un textarea codé en dur.
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await page.locator('#lab-desc').fill('Pilote ton jeu');
    await page.locator('#lab-desc').selectText();
    await page.locator('#lab-desc-toolbar .md-tool[data-md="bold"]').click();

    expect(await page.locator('#lab-desc').inputValue()).toContain('**Pilote ton jeu**');
    // CONTRE-TÉMOIN : les instructions ne doivent PAS avoir bougé.
    expect(await page.locator('#lab-instructions').inputValue()).toBe('');
});

test('l’aperçu de la description rend le Markdown', async ({ page }) => {
    await boot(page, { store: [], gifts: [] });
    await ouvrirLab(page);
    await page.locator('#lab-desc').fill(['## Titre', '', '```', '80002000', '```'].join('\n'));
    await page.locator('#lab-desc-preview-tab').click();
    await expect(page.locator('#lab-desc-preview')).toBeVisible();
    await expect(page.locator('#lab-desc-preview .md-code')).toBeVisible();
    await expect(page.locator('#lab-desc-preview')).toContainText('80002000');
});
