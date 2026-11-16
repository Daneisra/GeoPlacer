# Guide de démonstration (Phase 1B.10)

La démonstration montre GeoPlacer en deux minutes environ, sans rien
préparer : un modèle d'exemple, une petite toile simulée et un agent
simulé qui se recharge vite. Tout est **local et simulé** : aucun compte,
aucun service extérieur, aucun téléchargement.

## 1. Lancer

Après l'installation (voir [installation-windows.md](installation-windows.md)) :

```powershell
npm run demo          # ou : start.bat --demo
```

Ouvrir ensuite `http://127.0.0.1:3000`.

`npm run demo` utilise un **dossier séparé**, `data\demo`. Vos données
habituelles (`data\engine`) ne sont ni lues ni modifiées. La console
l'indique : « Demonstration mode: engine directory demo (your project is not used). ».

On peut aussi lancer la démonstration depuis un `npm start` ordinaire, à
condition que le projet soit **vide** : aucun modèle, aucune tentative en
cours, toile simulée vierge. Sinon, la carte « Démonstration » explique de
passer par `npm run demo`. GeoPlacer ne modifie **jamais** un projet
existant pour la démonstration : le serveur refuse lui-même (code
`DEMO_NEEDS_EMPTY_PROJECT`), pas seulement l'interface.

## 2. Parcours

1. **Préparer** : la carte verte « Découvrir GeoPlacer : démonstration »
   propose « Préparer la démonstration ». Un clic :
   - règle la toile simulée (128 × 96) et l'agent simulé : énergie
     maximale 400, régénération d'une unité toutes les 25 ms (40 pixels
     par seconde), monnaie de départ 1 500, lots de 10 à 40 pixels ;
   - importe le modèle d'exemple « Démonstration — paysage » (96 × 64, en
     (16, 16), stratégie « Du centre vers l’extérieur ») et le
     sélectionne ;
   - affiche « Démonstration prête : cliquez sur « Démarrer » ».
2. **Démarrer** : l'agent est initialisé (état « Initialisation »), puis
   les pixels se placent par lots. La progression, l'énergie, le temps
   restant et la toile se mettent à jour en direct.
3. **Pause**, puis **Reprendre** : la simulation s'arrête après l'écriture
   en cours, puis repart là où elle en était.
4. **Fin** : l'état passe à « Terminé » et la progression à 100 %.

À essayer en chemin :
- « Simuler un acteur extérieur » efface quelques pixels : le moteur les
  détecte et les repeint ;
- « Déplacer » le modèle pendant la simulation ;
- les améliorations simulées (panneau « Ressources ») : la monnaie de
  départ permet d'en essayer quelques-unes, toujours avec confirmation ;
- **Ctrl+C** dans la console, puis `npm run demo` : la progression est
  retrouvée (voir [guide-utilisateur.md](guide-utilisateur.md), § 4) ;
- « Sauvegarder » quand la simulation est arrêtée (voir
  [sauvegarde-restauration.md](sauvegarde-restauration.md)).

## 3. Les données de démonstration

- **Le modèle est original** : un paysage au coucher du soleil (ciel en
  bandes, soleil, deux montagnes enneigées, lac, maison, arbre, herbe),
  dessiné par le code (`packages/engine-service/src/demo.ts`). Aucun
  fichier image n'est livré ni téléchargé. Il est redistribué avec
  GeoPlacer sous la même licence (AGPL-3.0-only).
- Il n'utilise que des couleurs débloquées par l'agent de démonstration :
  la simulation peut aller jusqu'au bout.
- Les réglages sont **synthétiques** : ils sont faits pour voir avancer la
  simulation, pas pour imiter un service réel.
- Tout reste dans `data\demo`. Pour recommencer à zéro : GeoPlacer arrêté,
  supprimer le dossier `data\demo`, puis relancer `npm run demo`.

## 4. Durée observée

Recette automatisée du 16/11/2026 (Edge, Windows 10) : démonstration
préparée, démarrée, mise en pause, reprise, puis terminée environ
**143 secondes** après la reprise.
