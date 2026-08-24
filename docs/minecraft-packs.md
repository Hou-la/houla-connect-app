# Trois packs Minecraft thématisés (spec pour l'art)

> État **2026-08-24**. On **garde** le pack actuel `minecraft-survie` (il fait « un peu de tout »,
> positif ET négatif — un bon pack généraliste). On **ajoute** 3 packs spécialisés, pour matérialiser
> l'idée « la richesse d'un jeu = plusieurs packs thématisés, pas plus de slots » (voir
> `interactive-packs.md` §11.4). Le streamer choisit le pack qui colle à son live.
>
> **Prix = numéro de slot** (échelle plateforme fixe) : slot 01→05, 02→10, 03→15, 04→20, 05→30, 06→45,
> 07→60, 08→80, 09→100, 10→125, 11→155, 12→190, 13→230, 14→280, 15→340, 16→410, 17→490, 18→580, 19→680,
> 20→790, 21→900, 22→1010, 23→1120, 24→1230, 25→1340, 26→1440, 27→1530, 28→1600, 29→1660, 30→1700 coins.
> **Rareté (couleur auto du halo)** : 01-06 gris · 07-12 vert · 13-18 bleu · 19-24 violet · 25-30 or.
> Le placeholder `{player}` = le pseudo Minecraft du streamer (réglé dans le connecteur RCON).
>
> **Icônes** : PNG transparent **512×512**. **Bannière** : **1600×900** webp. 12 cadeaux/pack.
> Verbe RCON de sabotage serveur interdit par la modération (stop/op/ban/gamemode…) — les commandes
> ci-dessous (`give`/`summon`/`effect`/`time`) sont autorisées.

---

## Pack 1 — « Minecraft · Survie » (aide à survivre, positif)
- **Thème** `gaming` · **game** `minecraft` · **accent signature** vert émeraude `#46c37b`.
- **Description** : « Tes viewers t'aident à survivre : armure, nourriture, soins, ressources. Chaque
  cadeau est un coup de pouce — plus il est cher, plus il est puissant. »
- **Bannière** : un joueur en armure diamant au coucher de soleil devant un coffre de ressources, ton
  vert/or chaud, ambiance rassurante.

| # | Slot (prix) | Cadeau | Commande RCON | Idée d'icône |
|---|---|---|---|---|
| 1 | 01 (5) | Torches ×16 | `give {player} minecraft:torch 16` | torche allumée |
| 2 | 02 (10) | Pain ×8 | `give {player} minecraft:bread 8` | miche de pain |
| 3 | 04 (20) | Pioche en fer | `give {player} minecraft:iron_pickaxe 1` | pioche fer |
| 4 | 06 (45) | Épée en fer | `give {player} minecraft:iron_sword 1` | épée fer |
| 5 | 08 (80) | Bouclier | `give {player} minecraft:shield 1` | bouclier |
| 6 | 10 (125) | Lingots de fer ×16 | `give {player} minecraft:iron_ingot 16` | lingot fer |
| 7 | 13 (230) | Cuivre ×32 | `give {player} minecraft:copper_ingot 32` | lingot cuivre orangé |
| 8 | 16 (410) | Soin (Régénération 15s) | `effect give {player} minecraft:regeneration 15 2` | cœur vert + croix |
| 9 | 19 (680) | Casque + plastron diamant | `give {player} minecraft:diamond_chestplate 1` | plastron diamant |
| 10 | 23 (1120) | Lingots d'or ×32 | `give {player} minecraft:gold_ingot 32` | lingot or brillant |
| 11 | 27 (1530) | Pomme d'or enchantée | `give {player} minecraft:enchanted_golden_apple 1` | pomme d'or auréolée |
| 12 | 30 (1700) | Totem d'immortalité | `give {player} minecraft:totem_of_undying 1` | totem émeraude |

---

## Pack 2 — « Minecraft · Chaos » (malus / troll, négatif)
- **Thème** `gaming` · **game** `minecraft` · **accent signature** rouge `#ef4444`.
- **Description** : « Tes viewers te pourrissent la vie : monstres, poison, foudre, TNT. Plus le cadeau
  est cher, plus c'est violent. Survivras-tu à ton propre public ? »
- **Bannière** : creeper + éclairs + TNT dans un ciel de nuit rouge/orange, ambiance danger.

| # | Slot (prix) | Cadeau | Commande RCON | Idée d'icône |
|---|---|---|---|---|
| 1 | 01 (5) | Zombie | `execute at {player} run summon minecraft:zombie` | tête de zombie |
| 2 | 02 (10) | Araignée | `execute at {player} run summon minecraft:spider` | araignée |
| 3 | 04 (20) | Nuit tombe | `time set night` | lune |
| 4 | 06 (45) | Poison 10s | `effect give {player} minecraft:poison 10 1` | fiole verte / tête de mort |
| 5 | 08 (80) | Squelette | `execute at {player} run summon minecraft:skeleton` | crâne de squelette |
| 6 | 10 (125) | Cécité 10s | `effect give {player} minecraft:blindness 10 1` | œil barré |
| 7 | 13 (230) | Creeper | `execute at {player} run summon minecraft:creeper` | tête de creeper |
| 8 | 16 (410) | Foudre | `execute at {player} run summon minecraft:lightning_bolt` | éclair |
| 9 | 19 (680) | Pluie de TNT | `execute at {player} run summon minecraft:tnt ~ ~15 ~` | bloc de TNT |
| 10 | 23 (1120) | Enderman | `execute at {player} run summon minecraft:enderman` | enderman |
| 11 | 27 (1530) | Ravageur | `execute at {player} run summon minecraft:ravager` | ravageur |
| 12 | 30 (1700) | Warden (boss ultime) | `execute at {player} run summon minecraft:warden` | warden sombre |

---

## Pack 3 — « Minecraft · Ferme » (mignon, positif/neutre)
- **Thème** `gaming` · **game** `minecraft` · **accent signature** pastel vert-ciel `#7dd3fc`.
- **Description** : « Tes viewers peuplent ta ferme : vaches, moutons, poules, chevaux… et quelques
  compagnons rares. Un pack tout mignon, zéro danger. »
- **Bannière** : prairie ensoleillée, vache/mouton/poule paissant, ton pastel vert/bleu, ambiance douce.

| # | Slot (prix) | Cadeau | Commande RCON | Idée d'icône |
|---|---|---|---|---|
| 1 | 01 (5) | Poule | `execute at {player} run summon minecraft:chicken` | poule |
| 2 | 02 (10) | Cochon | `execute at {player} run summon minecraft:pig` | cochon rose |
| 3 | 04 (20) | Mouton | `execute at {player} run summon minecraft:sheep` | mouton |
| 4 | 06 (45) | Vache | `execute at {player} run summon minecraft:cow` | vache |
| 5 | 08 (80) | Blé ×16 (nourrir) | `give {player} minecraft:wheat 16` | gerbe de blé |
| 6 | 10 (125) | Lapin | `execute at {player} run summon minecraft:rabbit` | lapin |
| 7 | 13 (230) | Chat | `execute at {player} run summon minecraft:cat` | chat assis |
| 8 | 16 (410) | Abeille | `execute at {player} run summon minecraft:bee` | abeille |
| 9 | 19 (680) | Loup (compagnon) | `execute at {player} run summon minecraft:wolf` | loup |
| 10 | 23 (1120) | Renard | `execute at {player} run summon minecraft:fox` | renard roux |
| 11 | 27 (1530) | Cheval | `execute at {player} run summon minecraft:horse` | cheval |
| 12 | 30 (1700) | Mouton arc-en-ciel (jeb_) | `execute at {player} run summon minecraft:sheep ~ ~ ~ {CustomName:'"jeb_"'}` | mouton multicolore |

---

## Après l'art
Tu génères les 36 icônes (512²) + 3 bannières (1600×900). Ensuite je seede les 3 packs (plan exécutable
+ plan visuel) dans la base dev, avec `accentColor` = l'accent signature du pack (ou auto par rareté si
tu préfères), et on teste sur ton serveur Minecraft local. Tu peux démarrer avec **moins de 12** cadeaux
par pack (les plus parlants) et compléter ensuite — le pack accepte n'importe quel sous-ensemble.
