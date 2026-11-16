# ADR 0004 — Fournisseur navigateur GeoPixels (Phase 2A)

Date : 16 novembre 2026. Statut : implémenté expérimentalement, validation locale.

## Décision

Conserver `createScheduler`, WorkPlanner, AttemptManager, ResourceManager et les calculs existants.
`EngineService` choisit le fournisseur au démarrage d'une exécution. Il n'existe qu'une boucle
d'ordonnancement active. Le navigateur ne choisit ni les tâches, ni les lots, ni les stratégies.

Deux domaines de journal sont nécessaires : `journal/` pour la simulation,
`providers/geopixels/journal/` pour le connecteur. Une observation simulée ne constitue jamais
une preuve pour une tentative du navigateur. Le changement de source exige un moteur arrêté
et aucune tentative ouverte dans le domaine sortant.

Le modèle local est conservé dans TemplateManager, avec son repère image Y descendant.
Une liaison explicite associe ce modèle au fantôme natif Y montant :
`GridX = ghost.gridX + ix`, `GridY = ghost.gridY - iy`.
Le serveur ne réimporte pas silencieusement les pixels du navigateur et ne requantifie pas
un modèle existant. L'égalité des dimensions seule ne garantit pas l'égalité des images.

## Capacités

- `geopixels-observed` : observation passive du cache du client public examiné. Aucun écrivain réel activé.
- `geopixels-fixture` : observations et écritures d'un service factice exécuté dans une page locale.
- `simulated` : simulateur historique, inchangé dans ses règles et son stockage.
- `imported-snapshot` : contrat préexistant conservé.

Le port écrivain demeure séparé du lecteur. Sa capacité est contrôlée côté serveur par le
mode de couplage, pas par une déclaration de la page. Un couplage `local-fake` est impossible
depuis l'origine GeoPixels. Aucune opération `fetch`, URL arbitraire, achat ou placement réel
n'existe dans le protocole livré.

## Canal

Le dashboard local demande une capacité aléatoire de 256 bits, à usage unique, valable 60 s.
Elle est liée à une origine exacte. Le WebSocket `/api/v1/connector/channel` exige un Host
et une adresse distante loopback, une origine autorisée par le couplage en attente, puis
un premier message `pair` valide dans les 5 s. Comparaison du secret en temps constant.
Le code n'est placé ni dans une URL, ni dans IndexedDB, ni sur disque.

Les opérations reçues sont `observation`, `result` et `heartbeat`, avec schémas stricts.
Les seules commandes émises sont `execute-fake`. Limites : 1 Mo par message, 65 536 pixels
par observation, 4 millions de pixels en cache, 256 pixels par commande et une seule
commande en attente. La cadence du navigateur factice est bornée. La révocation ferme le
canal ; une nouvelle connexion ne peut pas être détruite par le callback de fermeture de
l'ancienne (génération du transport).

Un arrêt du serveur perd les capacités en mémoire. Une nouvelle association est requise.
La liaison modèle/projet et les intentions durables restent sur disque ; les cookies,
jetons de service, identifiants de compte et images du cache ne sont pas sauvegardés par le canal.

## Observations et incertitude

Une tuile absente, en fusion, fermée ou illisible fournit `UNKNOWN`, jamais une couleur
incorrecte par défaut. Alpha 0 est distinct d'une région inconnue ; un alpha partiel du
cache est inconnu. Les pixels transparents du modèle sont exclus par le moteur existant.

Les instantanés lus sont des copies. Les séquences rejouées ou arrivées dans le désordre
sont refusées, et une observation plus ancienne ne remplace pas un pixel plus récent.
Le changement de session opaque, de modèle, de filtres ou de position invalide la liaison.
Les données datées trop anciennes deviennent inconnues après 30 s. Une capture de cache
sans date établie conserve `observedAt = 0` et une fraîcheur non vérifiée ; elle expire aussi
après 30 s à partir de la capture. Un curseur `ServerTimestamp` n'est pas converti arbitrairement en date.

Une déconnexion, un délai dépassé ou un arrêt en cours d'opération lève `WRITE_UNCERTAIN`.
L'ordonnanceur laisse alors l'intention ouverte. Il ne doit pas recevoir un résultat normal
contenant seulement `unknown`, car son contrat historique termine cette tentative.
La reprise utilise les contrôles existants : lecture complète, strictement postérieure au
début de la tentative et à sa mise en réconciliation. Une réponse tardive ne réactive pas
une tentative. La liaison enregistrée doit être identique pour reprendre une tentative ouverte.

## Ressources et améliorations

Le lecteur réel ne transmet que des champs numériques sélectionnés. Les valeurs absentes
restent `null` ; l'énergie initiale affichée par défaut dans le frontend n'est pas utilisée.
La date `checkedTick` et l'énergie stockée sont conservées sans inventer une observation actuelle.
Le catalogue de prix, les niveaux et les règles du service ne sont pas réputés vérifiés
au point d'autoriser un écrivain réel. Le scheduler n'accepte ici que les ressources factices
complètes, récentes et compatibles avec les règles synthétiques explicites.

`evaluateUpgradePolicy` filtre et ordonne les propositions de l'UpgradePlanner existant :
activation par type, priorité, capacité cible, couleurs requises, budget, réserve et budget
déjà consommé. Aucun deuxième calcul d'énergie ou de prix. Les propositions restent
non exécutables et exigent une confirmation pour toute future dépense réelle.

## Limites et suites

Le canal local ne prouve pas que la page décrit fidèlement le service. Une page compromise
peut falsifier ses observations ; aucune dépense réelle n'est permise pour cette raison.
Un programme local malveillant ayant accès au dashboard sort du modèle de protection contre
les sites web tiers. Les restrictions de contenu mixte, CSP et accès au réseau local du
navigateur restent à vérifier lors d'une recette interactive sur le vrai site.

L'écrivain futur doit avoir un protocole de résultat autorisé, un traitement des erreurs du
service et une preuve de fin d'exécution avant réconciliation. Une lecture de cache seule
ne prouve pas qu'une requête encore en cours ne s'appliquera pas plus tard. Les événements,
la surveillance continue, les files de projets et les achats réels sont des étapes séparées.
