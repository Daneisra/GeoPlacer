# Phase 2A — Fondation d'intégration GeoPixels

Cette branche de développement conserve la version `6.0.0-rc.1`, la simulation et l'export
PNG existants. Elle ajoute un fournisseur navigateur expérimental et un parcours complet
d'écriture **factice locale**. Elle ne permet ni placement ni achat sur le site réel.

L'archive candidate du commit `fe39226` demeure une RC distincte : elle ne contient pas
cette Phase 2A. Aucun tag, push ou nouvelle release n'est nécessaire pour la recette ci-dessous.

## Parcours local de référence

1. Installer et construire avec `npm run setup:windows`, puis lancer `start.bat`.
2. En source « Simulation locale », importer et sélectionner un PNG de 64 × 64 au maximum
   pour une première recette rapide. La simulation conserve son fonctionnement habituel.
3. Arrêter le moteur, puis choisir « GeoPixels — connecteur expérimental ».
4. Cliquer « Coupler un navigateur factice », copier le code temporaire et ouvrir la page factice.
5. Dans cette page, charger le modèle local sélectionné, coller le code, puis coupler.
6. Vérifier les dimensions et la position native affichées, puis « Lier ce modèle » dans le dashboard.
7. Démarrer le fournisseur factice. Le scheduler existant prépare les lots ; le navigateur
   les applique dans sa toile synthétique ; les résultats alimentent le journal et la progression.
8. Utiliser Pause, Reprendre et Arrêter. Modifier un pixel externe dans la page factice,
   observer, puis redémarrer pour vérifier sa réévaluation.
9. Révoquer le canal. Revenir à la simulation une fois le moteur arrêté et les tentatives réconciliées.

Le navigateur factice fournit volontairement des ressources synthétiques abondantes :
elles ne décrivent aucun compte. Il conserve sa toile et ses résultats dans une transaction
IndexedDB avant accusé de réception. Ne pas vider ce stockage pendant une recette de reprise.
Il ne s'agit pas d'une garantie transactionnelle équivalente au journal disque du moteur.

## Réponse perdue et reprise

« Perdre la prochaine réponse » applique le lot sans résultat direct. Une observation plus
récente permet au journal de réconcilier l'intention, sans renvoi de cette opération.
« Déconnecter après la prochaine exécution » conserve la toile locale mais coupe le canal.

Après un redémarrage du serveur ou de la page : demander un nouveau code, recoupler,
observer le même projet, relier le même modèle à la même position, puis démarrer.
Une autre liaison est refusée tant qu'une tentative de l'ancienne reste ouverte.
La date de l'observation doit être postérieure à la mise en réconciliation ; si nécessaire,
cliquer de nouveau « Observer ». Ne pas forcer un changement de source pour contourner ce contrôle.

## Lecteur passif pour une future recette interactive

Le lien « Télécharger le lecteur Tampermonkey » fournit `geopixels-connector.user.js`,
généré à partir de `browser/` par `npm run build:connector`. Le code est fourni pour examen
et essai interactif ultérieur ; aucun essai sur le vrai site n'a été effectué par l'agent.

Après vérification des autorisations du service et des restrictions du navigateur, l'utilisateur
pourra installer le lecteur, ouvrir la couche de base de `https://www.geopixels.net`, charger
et positionner un fantôme, demander un couplage **lecteur** dans GeoPlacer puis saisir
l'adresse locale et le code dans le petit panneau du userscript. « Observer le modèle »
lit uniquement les bitmaps déjà présents dans le cache. Aucune requête au service n'est émise.

Un cache incomplet produit des pixels inconnus. Le lecteur n'assure aucun chargement global
de la carte, ni fraîcheur temps réel. Une capture sans date fiable est explicitement non datée.
Les couches événementielles sont refusées. Limite de cette phase : 2000 × 2000.

Le lecteur n'exécute aucune commande de placement. Le mode factice est refusé côté serveur
si l'origine est celle de GeoPixels. Fermer le serveur, révoquer le canal ou désactiver le
userscript interrompt l'association. Aucun code de couplage n'est mémorisé par le lecteur.

## Politiques d'améliorations

Le panneau présente les propositions du moteur existant avec coûts, bénéfices estimés et
motifs de refus. L'API `POST /api/v1/connector/policy` accepte une activation par type,
un ordre de priorité, une capacité cible, des couleurs requises, un budget maximal et une
réserve minimale. Une liste vide de couleurs utilise celles du modèle lié.

Les politiques sont enregistrées dans `connector-policy.json` pour traçabilité. Le formulaire
de cette première interface propose des valeurs initiales à chaque montage ; il ne recharge
pas encore automatiquement la dernière politique. Les propositions sont synthétiques,
sans bouton d'achat ni exécution de dépense.

## Données et sauvegarde

- `provider.json` : source choisie ; le démarrage ne rétablit aucune connexion navigateur.
- `connector-binding.json` : identité et position du projet liées au modèle et à sa révision.
- `providers/geopixels/journal/` : intentions, checkpoints et historique du connecteur.
- `journal/` et `world/` : domaine de simulation conservé.

Les sauvegardes existantes incluent les nouveaux fichiers et leurs empreintes. Les codes
de couplage, canaux et caches d'observation en mémoire ne sont pas sauvegardés. L'état du
navigateur factice appartient au stockage de ce navigateur et n'est pas inclus dans le backup serveur.

## Vérifications reproductibles

```powershell
npm run check:logged
npm run build
node --import tsx scripts/test-connector-channel.mjs
# Playwright installé séparément ; Edge installé sur Windows :
$env:GEOPLACER_PLAYWRIGHT_CORE = '<chemin vers playwright-core>'
node scripts/recette-connecteur.mjs test-logs/phase2a/edge
```

Pour Firefox : définir `GEOPLACER_BROWSER_ENGINE=firefox` et, si nécessaire,
`PLAYWRIGHT_BROWSERS_PATH` vers le navigateur correspondant à la version Playwright.
La recette bloque les requêtes externes et utilise un répertoire de données temporaire.
Elle ne contacte jamais GeoPixels. Voir le [rapport de phase](RAPPORT-PHASE2A.md) pour les résultats.

Sous PowerShell, utiliser `npm.cmd` si la résolution de `npm.ps1` est bloquée ;
aucune modification de la politique d’exécution Windows n’est nécessaire.
