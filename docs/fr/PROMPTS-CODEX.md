# Convention de prompt Codex

Utiliser quatre rubriques : **objectif**, **périmètre**, **critères de réussite**, **autorisations**.
Viser 150 à 300 mots, sans recopier AGENTS.md, les anciennes phases ou les listes complètes de tests.
Préciser seulement la base utile, les exceptions aux règles permanentes et le résultat observable.
Les contrôles sont choisis selon les fichiers touchés ; les scripts existants restent la référence.

## Exemple prêt à copier

**Objectif**
Rendre l'expiration d'une région plus facile à comprendre dans le dashboard GeoPixels. L'utilisateur doit distinguer la dernière capture de cette région de la couverture actuelle issue des régions voisines. Il ne doit pas croire qu'une nouvelle lecture prouve une actualisation de GeoPixels.

**Périmètre**
Partir de la branche locale de développement, après vérification de son état. Modifier uniquement les libellés et l'affichage du panneau régional, avec un test ciblé si un calcul de présentation change. Réutiliser les données déjà exposées par le fournisseur. Conserver le simulateur, le transport, les calculs de progression et les règles d'expiration existants. Ne pas reprendre les audits précédents ni créer de clone neuf.

**Critères de réussite**
Les états « capture propre expirée », « couverture connue » et « données inconnues » sont compréhensibles, y compris lorsqu'une autre région recouvre le rectangle. Les contrôles pertinents passent, sans débordement évident. Fournir un bref résumé des changements, des vérifications réellement effectuées et des limites éventuelles.

**Autorisations**
J'autorise les modifications locales nécessaires et un commit sur la branche de développement. Aucun push, changement de main, tag, release ou nettoyage. Aucun placement ni achat réel. Arrêter après le correctif vérifié et le compte rendu.
