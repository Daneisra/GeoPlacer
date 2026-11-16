# Guide utilisateur : la simulation locale (V1)

GeoPlacer V1 est un **environnement de simulation local**. La toile, l'agent,
l'énergie, la monnaie et les améliorations sont **simulés** sur votre
machine :

- aucune connexion à GeoPixels ou à Wplace ;
- aucun compte, aucune session, aucun jeton.

Le tableau de bord l'indique par le bandeau « SIMULATION LOCALE ».

## 1. Installer et lancer

Une seule fois (voir [installation-windows.md](installation-windows.md)) :

```powershell
npm run setup:windows      # ou double-clic sur setup.bat
```

Puis, à chaque utilisation :

```powershell
npm start                  # ou double-clic sur start.bat ; http://127.0.0.1:3000
```

Pour découvrir GeoPlacer sans rien préparer : `npm run demo` (ou
`start.bat --demo`), voir [demonstration.md](demonstration.md).

Le moteur garde ses données dans `data\engine`, ou dans
`GEOPLACER_ENGINE_DIR` :

- modèles ;
- journal des tentatives ;
- toile simulée ;
- réglages (`engine.json`).

Un seul GeoPlacer peut utiliser ce dossier. Un second démarrage est
**refusé** avec le message « already used by another GeoPlacer
instance » et le code de sortie 2. Rien n'est écrit dans le dossier du
moteur.

## 2. Parcours

1. **Ouvrir** `http://127.0.0.1:3000`. Le tableau de bord affiche le
   bandeau « SIMULATION LOCALE » et l'indicateur « Temps réel connecté ».
2. **Choisir les paramètres** (panneau « Simulateur ») :
   - taille de la toile, coût par pixel, capacité et régénération de
     l'énergie, latence d'écriture ;
   - énergie et monnaie de départ, taille des lots.

   Puis « Enregistrer ». Une nouvelle taille ou de nouvelles règles
   demandent de confirmer la réinitialisation du monde simulé ; l'ancien
   monde est conservé à part sur le disque.
3. **Importer un modèle** (panneau « Modèle » > « Importer un PNG ») :
   fichier, nom, position (x, y) et stratégie de dessin. Les couleurs sont
   ramenées à la palette de démonstration. Le modèle importé est
   sélectionné.
4. **Consulter les ressources** de l'agent simulé : énergie, capacité,
   régénération, monnaie, couleurs disponibles et verrouillées, et
   améliorations proposées avec leur effet sur le temps restant.
5. **Démarrer**. Le tableau de bord suit en temps réel :
   - état, progression, pixels corrects, incorrects, inconnus et restants ;
   - énergie, prochaine disponibilité, temps restant ;
   - tentatives en cours et dernière activité.

   La toile se met à jour par lots ; « Superposer le modèle » montre ce
   qui reste à faire.
6. **Pause**, puis **Reprendre**. Seuls les boutons permis par l'état sont
   actifs : pas de second démarrage pendant une simulation.
7. **Arrêter** : arrêt après l'écriture en cours. « Arrêter maintenant »
   interrompt l'écriture, après confirmation. La tentative est alors
   réconciliée par une lecture de la toile simulée, jamais abandonnée.
8. **Redémarrer le serveur** (voir § 4) puis rouvrir la page. Vous
   retrouvez le même modèle, la même toile, les mêmes ressources ; une
   écriture interrompue est réconciliée au démarrage suivant.

La toile affiche le **modèle entier**, quelle que soit sa taille
(jusqu'à 4096 × 4096) :

- « Ajuster » montre tout le modèle ; « Zoom + » et « Zoom − » zooment ; la molette
  zoome autour du pointeur ; un glisser déplace la vue ;
- le texte sous la toile indique ce qui est affiché : « Modèle entier
  affiché », ou la zone visible (« Zone visible : x … à …, y … à … »), et
  « 1 pixel sur N affiché » quand l'image est réduite pour tenir dans le
  cadre ;
- les proportions sont conservées ; l'axe Y va vers le bas, comme dans
  l'image importée ;
- seule la zone visible est lue sur le serveur, à l'échelle de
  l'affichage : un grand modèle ne ralentit pas la page.

Autres actions :

- **Déplacer** le modèle, même pendant la simulation : une nouvelle
  révision est créée et le moteur la suit sans repeindre deux fois.
- **Simuler un acteur extérieur** : jusqu'à 25 pixels du modèle sont
  effacés. Le moteur les détecte à sa prochaine lecture complète et les
  repeint.
- **Améliorations** : « Appliquer… » demande une confirmation. Seul l'état
  local de la simulation change : aucun achat, aucune dépense
  automatique. Possible à l'arrêt ou en pause.
- **Diagnostic du journal** et **Compacter** (voir
  [diagnostic.md](diagnostic.md)).
- **Sauvegarder** (panneau « Simulateur »), simulation arrêtée : une
  sauvegarde complète et vérifiée du dossier du moteur est écrite dans
  `sauvegardes\`. La restauration se fait GeoPlacer arrêté, avec
  `npm run restore` (voir
  [sauvegarde-restauration.md](sauvegarde-restauration.md)).

## 3. Notifications et textes

Les refus du serveur et les erreurs du moteur apparaissent en bas à
droite, **en français**. Le serveur envoie des codes stables et des
messages en anglais ; l'interface les traduit avec une table unique
(`frontend/src/lib/i18n.ts`). Un message que la table ne connaît pas est
affiché tel quel, suivi de « (message du moteur) ».

Les notifications peuvent recouvrir le bas de la toile : les fermer avec
leur croix.

## 4. Arrêter le serveur (Ctrl+C)

Dans la console où tourne `npm start` (ou
`node --env-file-if-exists=.env dist/server.js`), appuyer **une fois** sur
**Ctrl+C**. Comportement attendu :

1. `Received SIGINT. Starting graceful shutdown...` ;
2. la simulation s'arrête après l'écriture en cours. Au-delà de
   `GRACEFUL_SHUTDOWN_TIMEOUT_MS` (10 s par défaut), l'écriture est
   interrompue puis réconciliée au démarrage suivant ;
3. `Engine stopped and data directory released` ;
4. `Graceful shutdown completed`, code de sortie 0.

Un **second** Ctrl+C force la sortie (code 1). C'est alors comme un arrêt
brutal : rien n'est perdu, l'écriture en cours est réconciliée au démarrage
suivant (voir [reprise-apres-crash.md](reprise-apres-crash.md)).

Lancé par `start.bat`, Windows demande « Terminer le programme de
commandes (O/N) ? » après l'arrêt : le serveur est déjà arrêté, répondre O.

Vérifié en Phase 1B.10 en envoyant l'événement Ctrl+C de Windows à la
console de `start.bat --demo` (voir
[recette-navigateur.md](recette-navigateur.md)) : arrêt propre, port
libéré, progression retrouvée au démarrage suivant. Une frappe au clavier
réelle n'a pas été automatisée.

## 5. Limites

- Un seul agent simulé et un seul modèle actif.
- Les journaux de la console du serveur restent en anglais.
- Les anciennes pages de comptes et de modèles (Users, Templates) sont
  **désactivées** depuis la Phase 1B.10 : elles ne sont plus dans le menu
  et leur adresse affiche « Désactivé dans GeoPlacer V1 ». Le serveur
  refuse aussi les routes correspondantes (voir [securite.md](securite.md)).
  Les « Paramètres hérités » et les « Journaux » restent consultables ; ces
  paramètres n'ont aucun effet sur la simulation.
- Chaque onglet ouvert interroge le serveur environ 52 fois par minute.
  Le limiteur de débit par défaut (300 par minute, partagé) tient donc
  cinq onglets ; au-delà, des commandes peuvent recevoir un refus 429.
- Autres limites : voir [problemes-connus.md](problemes-connus.md).
