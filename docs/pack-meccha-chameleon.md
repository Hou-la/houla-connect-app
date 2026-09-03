# Pack « Meccha Chameleon » — description et instructions

Texte prêt à coller dans le Lab (champs **Description** et **Instructions**).
Écrit pour un joueur qui ne sait pas ce qu'est une DLL.

Les étapes ci-dessous sont tirées du **code réel** (`src/main/index.ts` : `engine:start`,
`placeProxyDlls`, `game:linkPackTo` ; `resources/xinput-proxy/proxy.c`), pas d'une supposition.
Aucune étape inventée.

---

## Description (champ « Description »)

> Tes viewers prennent le contrôle de ton caméléon. Chaque cadeau devient une action dans
> Meccha Chameleon : il saute, il siffle, il part à gauche, il se clone, il prend une pose au
> hasard. Tu joues normalement, ta manette continue de répondre : les cadeaux s'ajoutent à ce
> que tu fais, ils ne te remplacent pas.
>
> 7 interactions, une par cadeau. Windows uniquement (le pilotage manette repose sur un pilote
> Windows).

---

## Instructions (champ « Instructions »)

> ## Avant de commencer
>
> Il te faut : **Windows**, le jeu **Meccha Chameleon** installé, et **une manette branchée**
> si tu veux continuer à jouer pendant le live (facultatif : les cadeaux fonctionnent même
> sans manette à toi).
>
> L'installation se fait **une seule fois**. Ensuite, tu lances le pack et tu joues.
>
> ## 1. Installe le pilote de manette
>
> Va dans **Connecteurs** et clique sur **Installer le pilote** à la ligne Manette. Windows te
> demandera l'autorisation : accepte.
>
> **Ce que tu dois voir :** le bouton disparaît et la ligne Manette indique que le pilote est
> installé. S'il est toujours là après l'installation, redémarre l'application.
>
> ## 2. Ferme complètement le jeu
>
> Oui, avant. C'est l'étape qu'on oublie, et c'est celle qui fait tout rater.
>
> Hou.la Connect doit déposer un petit fichier dans le dossier du jeu, et **Windows interdit de
> modifier un fichier pendant que le jeu s'en sert**. Le jeu ne lit ce fichier qu'à son
> démarrage, donc il faudra le relancer de toute façon.
>
> ## 3. Désigne le jeu
>
> Dans le Store, clique sur l'engrenage du pack, puis sur **Choisir le jeu**. Si Meccha est
> lancé, il te sera proposé en un clic ; sinon, va chercher son fichier `.exe`.
>
> **Ce que tu dois voir :** le message **« Jeu prêt »**, et la ligne **« Jeu piloté »** qui
> affiche le nom de ton jeu.
>
> **Si tu lis « Ferme le jeu, puis relance-le » :** ton jeu était encore ouvert. Ton choix est
> quand même enregistré : ferme le jeu, rouvre-le, et continue.
>
> ## 4. Relance le jeu
>
> Indispensable. Le jeu ne prend le réglage en compte **qu'au démarrage** : s'il tournait déjà,
> il continue de fonctionner comme avant et rien ne se passera.
>
> ## 5. Démarre le pack, et joue
>
> Onglet **Capture**, choisis le pack, clique sur **Démarrer**. Va sur ton jeu.
>
> **Ce que tu dois voir :** dans le journal, une ligne par cadeau reçu. Et le caméléon qui
> bouge.
>
> ## Pour vérifier que ça marche, sans être en live
>
> Ouvre les réglages du pack (l'engrenage) et clique sur **Tester** à côté d'une interaction.
> Bascule sur ton jeu pendant le décompte.
>
> **Ce que tu dois voir :** le caméléon exécute l'action.
>
> Si **le premier test ne fait rien mais que le second marche**, c'est normal : en revenant de
> l'application, ton jeu était repassé en affichage clavier, et il consomme la première entrée
> manette pour rebasculer. Les cadeaux reçus en live n'ont pas ce problème, puisque tu as déjà
> ta manette en main.
>
> ## Si ça ne marche pas
>
> **Le pack démarre, le journal affiche les cadeaux, mais rien ne bouge en jeu.**
> Le jeu n'a pas été relancé après l'étape 3. Ferme-le complètement, rouvre-le.
>
> **« Impossible de préparer le jeu ».**
> Le jeu était ouvert au moment de la liaison. Ferme-le et refais l'étape 3.
>
> **Ta propre manette ne répond plus dans le jeu.**
> Ferme Hou.la Connect par le menu (clic droit sur l'icône près de l'horloge, puis Quitter),
> pas en fermant la fenêtre. Rouvre le jeu.
>
> **Tu ne joues pas sous Windows.**
> Le pilotage manette n'est pas disponible sur macOS et Linux : il repose sur un pilote qui
> n'existe que sous Windows.

---

## Comment poser ce texte

Dans le Lab, ouvre le pack `meccha-chameleon`, colle la description et les instructions, puis
**soumets une nouvelle version en Public**.

⚠️ Une modification du texte seule ne suffit plus à le publier : depuis le 2026-09-03, les
surfaces publiques servent le **snapshot figé de la version approuvée**, pas le brouillon
éditable (c'était une fuite : un créateur pouvait publier du texte sans passer par la
modération). Il faut donc **une nouvelle version**, et son approbation.

Vérification : `GET https://api.hou.la/api/bundles/meccha-chameleon` doit renvoyer un champ
`instructions` non nul.
