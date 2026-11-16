# Problèmes connus et limites (Phase 1B.10)

## Périmètre de la V1

- **Simulation seulement** : GeoPlacer V1 ne se connecte à aucun service de
  dessin réel (ni GeoPixels, ni Wplace). La toile, l'agent, l'énergie, la
  monnaie et les améliorations sont simulés sur la machine.
- **Un seul agent** simulé et un seul modèle actif à la fois.
- **Windows vérifié** (Windows 10 Pro x64, Node.js 22.23.2, npm 10.9.8).
  Linux et macOS **ne sont pas vérifiés** ; `start.sh` est l'ancien script
  du projet d'origine (mode développement), non maintenu.
- Pas d'authentification sur l'API locale : la protection repose sur
  l'écoute locale et les contrôles Host et Origin (voir
  [securite.md](securite.md)).

## Interface

- **Les notifications** (en bas à droite) peuvent recouvrir une partie de
  la toile. Les fermer avec leur croix, ou attendre qu'elles disparaissent.
- **Messages du moteur en anglais** : le serveur envoie des codes stables et
  des messages en anglais ; l'interface les traduit avec une table
  centralisée (`frontend/src/lib/i18n.ts`). Un code ou un message qui n'y
  figure pas est affiché tel quel, suivi de « (message du moteur) ».
- **Les journaux de la console** du serveur restent en anglais.
- **Un modèle qui déborde de la toile simulée est refusé**
  (`TEMPLATE_OUTSIDE_CANVAS`), à l'import comme au déplacement : il n'est
  jamais placé à moitié. Agrandir la toile (réglages du simulateur) ou
  choisir une autre position.
- **Grands modèles** : quand le modèle entier ne tient pas à l'échelle 1
  dans le cadre d'affichage (512 points), l'interface lit et montre une
  image réduite (« 1 pixel sur N affiché ») ; en zoomant, seule la zone
  visible est lue, jusqu'à la pleine résolution. Un modèle de 4096 × 4096
  s'importe en environ 4,4 s, le premier lot arrive après 1,5 à 1,8 s, et le
  serveur occupe alors environ 550 Mio de mémoire (voir
  [qualite.md](qualite.md)).
- **Page « Paramètres hérités »** : ces réglages concernent l'ancien code et
  n'ont aucun effet sur la simulation ; la page l'indique.
- **Débit sur les très grands modèles** : le planificateur reclasse tout
  le modèle à chaque cycle ; environ 2 000 pixels par seconde à 4096²
  (machine calme). Le serveur reste réactif (calcul découpé), mais le dessin
  est plus lent ; sur une machine très chargée, le débit baisse encore de
  7 à 10 %.
- Le limiteur de débit (300 requêtes par minute par défaut) est partagé par
  tous les onglets : au-delà de quelques onglets ouverts, des commandes
  peuvent recevoir un refus 429.

## Arrêt et console

- Après **Ctrl+C** dans une fenêtre lancée par `start.bat` ou `npm`,
  Windows peut demander « Terminer le programme de commandes (O/N) ? ». Le
  serveur est déjà arrêté : répondre O.
- Un **second** Ctrl+C force la sortie (code 1). Rien n'est perdu :
  l'écriture en cours est réconciliée au démarrage suivant.
- Fermer la fenêtre avec la croix équivaut à un arrêt brutal : même
  garantie de reprise (voir [reprise-apres-crash.md](reprise-apres-crash.md)).

## Installation

- `update.bat` (hérité) : `git pull` puis l'installation de GeoPlacer,
  vérifié avec Git présent. S'il ne trouve pas Git, il propose de
  l'installer avec winget, ce qui modifie Windows (branche non testée).
  Équivalent sans risque : `git pull` puis `npm run setup:windows`.
- `npm` peut afficher « New major version of npm available ». Ne pas mettre
  npm à jour pour GeoPlacer : l'installation n'exige rien de global.
- L'installation télécharge les dépendances et le binaire officiel de
  `canvas` (module hérité) : il faut un accès à `registry.npmjs.org` et à
  `github.com`.
- **Anciennes branches** : `.env` est encore suivi sur `main`,
  `feat/phase1a-fondation` et `backup/*` ; changer de branche peut écraser
  ou supprimer le `.env` local (voir
  [installation-windows.md](installation-windows.md), § 6).

## Données

- **Durabilité** : les écritures sont synchronisées sur le disque (`fsync`)
  avant d'être confirmées, et la reprise après un arrêt brutal du
  **processus** est vérifiée. La tenue après une **coupure de courant** ou un
  plantage du système n'a pas été testée.
- Pas de sauvegarde automatique ; la restauration se fait GeoPlacer arrêté,
  en ligne de commande (voir
  [sauvegarde-restauration.md](sauvegarde-restauration.md)).
- Les dossiers `*.avant-restauration-*` et `world-reset-*` ne sont jamais
  supprimés automatiquement.

## Qualité du code

- 47 avertissements `no-explicit-any` restent dans le serveur (65 avant la
  Phase 1C.0), aucune règle désactivée : 26 dans l’ancien moteur et ses
  clients, neutralisés (`template-manager`, `bridge`, `http-client`,
  `tile-manager`, keep-alive jamais appelé) ; 18 dans les routes héritées
  de comptes et de modèles, dont seules les parties locales restent
  actives (liste, suppression) ; 3 dans des tests. Les retirer demanderait
  de réécrire du code hérité destiné à disparaître (voir
  [qualite.md](qualite.md)).

## Tests

- **Navigateurs** : Edge (Chromium) est testé de bout en bout. Firefox n'est
  testé qu'avec la version de Firefox fournie par Playwright (132), installée
  à part, et non avec une version officielle installée sur la machine.
- **Délais intermittents** de certains tests longs, sous charge : voir
  [qualite.md](qualite.md), qui sépare les causes démontrées des causes
  supposées.
