# WebSocket du moteur : `/api/v1/ws` (Phase 1B.9)

Un canal temps réel par onglet. Il est soumis aux mêmes contrôles `Host` et
`Origin` que l'API. Comme pour `/api/v1`, une origine d'extension de
navigateur est refusée : la connexion est fermée avec le code 1008. Le
WebSocket des journaux hérité reste disponible sur les autres chemins.

## 1. Messages du serveur

| Message | Contenu |
|---|---|
| `{"type":"hello","stream","seq","status"}` | Envoyé **dès la connexion**, avec l'état complet courant |
| `{"type":"event","stream","seq","at","event"}` | Un événement du moteur, numéroté |
| `{"type":"resync","stream","seq","status","dropped"}` | Après un retard du client (voir § 3) : état complet, et nombre d'événements abandonnés |
| `{"type":"pong"}` | Réponse à `{"type":"ping"}` |

Événements (`event.type`) :

| Type | Envoi | Contenu |
|---|---|---|
| `state` | Immédiat | Changement d'état de l'ordonnanceur (`from`, `to`, `reason`) |
| `status` | Immédiat après un changement d'état ; sinon **au plus toutes les 250 ms** | État complet (progression, énergie, ETA, commandes permises…) |
| `attempts` | Regroupé toutes les 250 ms | Tentatives closes (au plus 50 par message, plus le nombre écarté) |
| `canvas` | Regroupé toutes les 250 ms | Pixels changés `[index, couleur, index, couleur…]`, index dans la trame de la toile (ligne par ligne), dernière valeur seulement |
| `canvas-resync` | Immédiat | Relire la toile par `GET /api/v1/simulator/canvas` : plus de 20 000 pixels changés en un intervalle, monde réinitialisé, client en retard |
| `error` | Immédiat | Erreur du moteur (code, message) |
| `notice` | Immédiat | Information (amélioration appliquée, monde réinitialisé) |

**Jamais un message par pixel** : au pire, un message `canvas` par
intervalle, ou une demande de relecture.

## 2. Cohérence

- **Numéros de séquence** : croissants, sans doublon, par processus
  serveur. Un nouveau `stream` signale un redémarrage du serveur : le
  client repart de `hello`.
- **Instantané de la toile** : la réponse de `GET /simulator/canvas` porte
  le numéro de séquence qu'elle inclut. Le client ignore les événements
  `canvas` de numéro inférieur ou égal. Il applique les suivants par-dessus,
  ce qui est sans risque car les valeurs sont absolues. Les événements reçus
  pendant le chargement sont mis de côté puis rejoués.
- **Statut** : l'interface ignore un statut plus ancien que celui qu'elle
  affiche. C'est le cas d'une réponse HTTP arrivée après l'événement
  WebSocket plus récent.
- **Reconnexion** : automatique, de 1 à 10 s d'intervalle. Le `hello`
  rétablit un état cohérent, quoi qu'il ait été manqué.

## 3. Fiabilité

- **Client lent** : au-delà de 1 Mio en attente d'envoi, ses événements
  sont abandonnés. Il ne ralentit ni le moteur ni les autres clients. Son
  tampon est vérifié toutes les 500 ms. Dès qu'il est rattrapé, il reçoit
  `resync`, puis `canvas-resync`, même si le moteur n'envoie plus rien
  (simulation terminée).
- **Déconnexion** : elle désabonne seulement le client ; la simulation
  continue. C'est vérifié par un vrai serveur dans les tests.
- **Indépendance** : le journal des tentatives ne dépend jamais du
  WebSocket. Perdre un événement ne perd aucun état.
- Un abonné qui lève une exception est ignoré.

## 4. Exemple

```js
const ws = new WebSocket(`ws://${location.host}/api/v1/ws`);
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type === 'hello' || msg.type === 'resync') render(msg.status);
  else if (msg.type === 'event' && msg.event.type === 'status') render(msg.event.status);
};
```
