const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// CAPACITÉ (machine) vs EFFECTIF (pack) — refonte du 2026-09-11.
//
// Avant, tout était global : un diffuseur déclarait huit manettes une fois pour
// toutes, puis activait un pack Minecraft joué en solo, et le spectateur se
// voyait encore proposer HUIT cibles. Il en choisissait une, PAYAIT, et le
// cadeau partait sur une manette que le jeu ne lit même pas. Rien ne le
// signalait, ni chez le spectateur ni chez le diffuseur.
//
// Le partage retenu :
//   - CAPACITÉ, dans Réglages, globale : combien de manettes ce poste sait
//     fournir et de quel type. Propriété du MATÉRIEL, elle ne bouge jamais.
//   - EFFECTIF, dans Capture, PAR PACK : qui joue ce soir, sous quel nom.
//     Propriété de la PARTIE — Tomb Raider à deux, Mario Kart à quatre le
//     lendemain avec d'autres personnes — donc mémorisé sur le pack.
//
// Ce que ces tests protègent, dans l'ordre du coût :
//   1. Un pack qui ne pilote PAS de manette ne propose AUCUNE cible.
//   2. L'effectif est mémorisé par pack et revient tel quel.
//   3. Le TYPE de manette est une PRÉFÉRENCE, jamais écrasée en silence : c'est
//      l'effectif du soir qui décide (au-delà de 2 joueurs, DualShock 4
//      obligatoire, sinon le jeu ne les voit pas), et on PRÉVIENT.
//   4. La carte reste lisible : mêmes largeurs, aucun libellé sur deux lignes.

const PACKS = [
    { slug: 'mario-kart', version: '1.0.0', contentHash: 'h1' },
    { slug: 'minecraft-solo', version: '1.0.0', contentHash: 'h2' },
];

async function ouvrirReglages(page, cfg = {}) {
    await boot(page, { installed: PACKS, ...cfg });
    await page.locator('.nav[data-view="settings"]').click();
    await expect(page.locator('#pads-card')).toBeVisible();
}

async function ouvrirCapture(page, cfg = {}) {
    await boot(page, { installed: PACKS, padCapacity: { count: 4, kind: 'ds4' }, ...cfg });
    await page.locator('.nav[data-view="capture"]').click();
}

// ── 1. LE TROU : un pack non ciblable ne propose aucune cible ────────────────

test('pack CLAVIER : le bloc « qui joue » n’existe pas', async ({ page }) => {
    // Le cas exact signalé : 8 manettes configurées + un pack Minecraft solo.
    // Un clavier envoie ses touches à la FENÊTRE active, pas à une personne :
    // proposer une cible serait promettre un effet qui n'arrivera jamais.
    await ouvrirCapture(page, { rosterUsesGamepad: false });
    await expect(page.locator('#roster-block')).toBeHidden();
});

test('CONTRE-TÉMOIN : pack MANETTE, le bloc apparaît', async ({ page }) => {
    // Sans lui, « le bloc est caché » serait vrai même si on l'avait cassé.
    await ouvrirCapture(page);
    await expect(page.locator('#roster-block')).toBeVisible();
    await expect(page.locator('#roster-list .roster-label')).toHaveCount(4);
});

// ── 2. L'effectif appartient au PACK ────────────────────────────────────────

test('l’effectif est MÉMORISÉ par pack, et revient tel quel', async ({ page }) => {
    await ouvrirCapture(page);
    await expect(page.locator('#roster-block')).toBeVisible();

    // Mario Kart à 4, avec des noms.
    await page.locator('#roster-count').selectOption('4');
    await page.locator('#roster-list .roster-label').nth(0).fill('Flicky');
    await page.locator('#roster-list .roster-label').nth(1).fill('Mika');
    await page.locator('#roster-list .roster-label').nth(1).blur();

    // On bascule sur l'autre pack et on le règle à 2.
    await page.locator('#active-bundle').selectOption('minecraft-solo');
    await page.locator('#roster-count').selectOption('2');
    await expect(page.locator('#roster-list .roster-label')).toHaveCount(2);

    // Retour sur Mario Kart : SES quatre joueurs, avec SES noms.
    await page.locator('#active-bundle').selectOption('mario-kart');
    await expect(page.locator('#roster-list .roster-label')).toHaveCount(4);
    await expect(page.locator('#roster-list .roster-label').nth(0)).toHaveValue('Flicky');
    await expect(page.locator('#roster-list .roster-label').nth(1)).toHaveValue('Mika');
});

test('l’effectif est écrit SUR LE PACK sélectionné', async ({ page }) => {
    await ouvrirCapture(page);
    await page.locator('#active-bundle').selectOption('minecraft-solo');
    await page.locator('#roster-count').selectOption('2');

    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.setRoster || []).length))
        .toBeGreaterThan(0);
    const [slug, joueurs] = await page.evaluate(() => {
        const c = window.__E2E_CALLS__.setRoster;
        return c[c.length - 1];
    });
    expect(slug).toBe('minecraft-solo');
    expect(joueurs.map((j) => j.id)).toEqual([1, 2]);
});

test('changer le NOMBRE ne détruit pas les noms déjà saisis', async ({ page }) => {
    // Passer de 4 à 2 pour vérifier puis revenir à 4 ne doit pas effacer le
    // travail du diffuseur : ce serait une perte de données silencieuse.
    await ouvrirCapture(page);
    await page.locator('#roster-count').selectOption('4');
    await page.locator('#roster-list .roster-label').nth(3).fill('Quatrième');
    await page.locator('#roster-list .roster-label').nth(3).blur();

    await page.locator('#roster-count').selectOption('2');
    await expect(page.locator('#roster-list .roster-label')).toHaveCount(2);
    await page.locator('#roster-count').selectOption('4');
    await expect(page.locator('#roster-list .roster-label').nth(3)).toHaveValue('Quatrième');
});

test('le repli est VISIBLE dans le champ, pas caché côté serveur', async ({ page }) => {
    // Le placeholder EST ce que verront les spectateurs si rien n'est saisi.
    await ouvrirCapture(page);
    const champs = page.locator('#roster-list .roster-label');
    await expect(champs.nth(0)).toHaveAttribute('placeholder', 'Contrôleur 1');
    await expect(champs.nth(3)).toHaveAttribute('placeholder', 'Contrôleur 4');
    await expect(champs.nth(0)).toHaveAttribute('maxlength', '24');
});

test('« 1 joueur » n’est pas proposé : ce serait le même choix que « aucun »', async ({ page }) => {
    // À un seul joueur il n'y a rien à viser. Offrir les deux, c'est offrir un
    // choix sans différence.
    await ouvrirCapture(page);
    const valeurs = await page.locator('#roster-count option').evaluateAll(
        (els) => els.map((e) => e.value),
    );
    expect(valeurs).toEqual(['0', '2', '3', '4']);
});

test('capacité à zéro : on DIT quoi faire au lieu d’un bloc vide', async ({ page }) => {
    // Un sélecteur vide sous un intitulé donne une carte qui semble cassée.
    await ouvrirCapture(page, { padCapacity: { count: 0, kind: 'x360' } });
    await expect(page.locator('#roster-block')).toBeVisible();
    await expect(page.locator('#roster-list .roster-label')).toHaveCount(0);
    await expect(page.locator('#roster-status')).toContainText(/R[ée]glages/);
});

test('jamais réglé : on propose la capacité, et on le DIT', async ({ page }) => {
    // Proposer zéro rendrait la fonctionnalité invisible ; proposer sans le
    // dire ferait croire à un choix déjà fait.
    await ouvrirCapture(page);
    await expect(page.locator('#roster-count')).toHaveValue('4');
    await expect(page.locator('#roster-status')).toContainText(/Jamais r[ée]gl[ée]/);
});

// ── 3. Capacité : la bascule XInput -> DualShock 4 ──────────────────────────

test('le type est une PRÉFÉRENCE : il n’est plus écrasé en silence', async ({ page }) => {
    // À l'origine, choisir 4 manettes basculait le select en DualShock 4 et
    // réécrivait le choix du diffuseur. C'ÉTAIT UN BUG, corrigé le 2026-09-11 :
    // le type doit suivre l'EFFECTIF du soir, pas la capacité de la machine.
    // Une machine déclarée à 4 mais jouée à 2 sur un jeu XInput créait sinon le
    // joueur 2 en DualShock 4 : invisible du jeu, et pourtant publié comme cible.
    await ouvrirReglages(page);
    await expect(page.locator('#pads-kind')).toHaveValue('x360');
    await page.locator('#pads-count').selectOption('4');

    await expect(page.locator('#pads-kind')).toHaveValue('x360'); // choix RESPECTÉ
    // Mais on PRÉVIENT, en toutes lettres : au-delà de 2 joueurs sur un pack, les
    // manettes passeront en DualShock 4 ou le jeu ne les verrait pas.
    await expect(page.locator('#pads-status')).toContainText(/DualShock 4/);
});

test('CONTRE-TÉMOIN : à 2 manettes, aucun avertissement', async ({ page }) => {
    // Sans lui, « ça prévient » serait vrai quel que soit le nombre, et
    // l'avertissement deviendrait du bruit qu'on n'a plus lit.
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('2');
    await expect(page.locator('#pads-kind')).toHaveValue('x360');
    await expect(page.locator('#pads-status')).toBeHidden();
});

test('DualShock 4 choisi à 4 manettes : aucun avertissement non plus', async ({ page }) => {
    // Le diffuseur a fait le bon choix : rien à lui signaler.
    await ouvrirReglages(page, { padCapacity: { count: 0, kind: 'ds4' } });
    await page.locator('#pads-kind').selectOption('ds4');
    await page.locator('#pads-count').selectOption('4');
    await expect(page.locator('#pads-kind')).toHaveValue('ds4');
    await expect(page.locator('#pads-status')).toBeHidden();
});

test('les Réglages ne portent PLUS les noms de joueurs', async ({ page }) => {
    // Ils y étaient, et c'était le bug de conception : un nom de joueur ne se
    // règle pas une fois pour la machine, il change avec la partie.
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('4');
    await expect(page.locator('#pads-card .roster-label')).toHaveCount(0);
    await expect(page.locator('#pads-card input[type="text"]')).toHaveCount(0);
});

// ── 4. Lisibilité de la carte ───────────────────────────────────────────────

test('tous les contrôles ont la MÊME largeur, aucun libellé sur deux lignes', async ({ page }) => {
    // Le défaut visuel signalé le 2026-09-09 : le libellé était comprimé à
    // ~25 % et se cassait en deux lignes (« Manette » puis « 1 ») pendant que
    // le contrôle mangeait le reste. Une grille commune règle les deux.
    await ouvrirCapture(page);
    await page.locator('#roster-count').selectOption('3');

    const largeurs = await page.locator('#roster-block .form__ctl').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    expect(largeurs.length).toBe(4); // 1 select + 3 champs
    expect(new Set(largeurs).size).toBe(1);

    const hauteurs = await page.locator('#roster-block .form__lbl').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(Math.max(...hauteurs) - Math.min(...hauteurs)).toBeLessThanOrEqual(2);
});
