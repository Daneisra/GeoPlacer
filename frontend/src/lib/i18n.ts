/**
 * French texts of the dashboard (Phase 1B.10): ONE table for everything the
 * engine sends. The server keeps stable codes and technical (English)
 * messages: the interface translates by CODE (errors, refusals, estimate
 * and upgrade reasons, journal verdicts) or by known pattern (state
 * reasons, notices). An unknown code or text is never hidden: it is shown
 * as received, marked « (message du moteur) ».
 */

const time = (ms: string | number): string => new Date(Number(ms)).toLocaleTimeString('fr-FR');

/** Errors and refusals, by stable code. `message` is the server's (English) text, for parameters. */
const ERRORS: Record<string, (message: string) => string> = {
  // Commands and engine service
  NO_TEMPLATE_SELECTED: () => 'Sélectionnez d’abord un modèle.',
  TEMPLATE_NOT_FOUND: () => 'Modèle introuvable ou illisible.',
  TEMPLATE_OUTSIDE_CANVAS: (m) => {
    const p = /\((\d+)x(\d+) at (-?\d+), (-?\d+)\).*\((\d+)x(\d+)\)/.exec(m);
    return p ? `Le modèle (${p[1]} × ${p[2]} à ${p[3]}, ${p[4]}) ne tient pas dans la toile simulée (${p[5]} × ${p[6]}).` : 'Le modèle ne tient pas dans la toile simulée.';
  },
  ENGINE_BUSY: (m) =>
    /backup or a compaction/.test(m)
      ? 'Une sauvegarde ou un compactage est déjà en cours.'
      : /stop is in progress/.test(m)
        ? 'Un arrêt est en cours.'
        : /upgrade/.test(m)
          ? 'Mettez la simulation en pause ou arrêtez-la avant une amélioration.'
          : 'Refusé pendant la simulation : arrêtez-la d’abord.',
  NOT_RUNNING: () => 'La simulation n’est pas en cours.',
  NOT_PAUSED: () => 'Rien à reprendre : la simulation n’est pas en pause (utilisez « Démarrer »).',
  PAUSED_USE_RESUME: () => 'La simulation est en pause : utilisez « Reprendre ».',
  COMPACTION_IN_PROGRESS: () => 'Un compactage est déjà en cours.',
  COMPACTION_REFUSED: () => 'Compactage refusé par le journal (journal endommagé : réparez-le d’abord, voir le guide de diagnostic).',
  WORLD_UNAVAILABLE: () => 'La toile simulée est indisponible : une réinitialisation explicite est nécessaire (voir le guide de reprise).',
  WORLD_RESET_REQUIRED: () => 'Une nouvelle taille de toile ou de nouvelles règles exigent de réinitialiser le monde simulé.',
  WORLD_DAMAGED: () => 'La toile simulée sauvegardée est endommagée.',
  WORLD_IDENTITY_MISMATCH: () => 'La toile simulée sauvegardée correspond à une autre taille ou à d’autres règles.',
  CONFIRMATION_REQUIRED: () => 'Une confirmation explicite est nécessaire.',
  STALE_PROPOSAL: () => 'L’agent a changé depuis la proposition : les ressources ont été relues, choisissez à nouveau.',
  UPGRADE_REFUSED: () => 'Amélioration impossible dans l’état actuel de l’agent.',
  BACKUP_FAILED: () => 'La sauvegarde a échoué (voir le journal du serveur).',
  ENGINE_CLOSED: () => 'Le serveur s’arrête.',
  INVALID_SETTINGS: (m) => {
    const p = /^(\w+) must be an integer in \[(\d+), (\d+)\]$/.exec(m);
    if (p) return `${SETTING_LABELS[p[1]!] ?? p[1]} : un nombre entier entre ${p[2]} et ${p[3]} est attendu.`;
    if (/minBatchSize must not exceed maxBatchSize/.test(m)) return 'Le lot minimal ne peut pas dépasser le lot maximal.';
    return 'Réglage invalide.';
  },
  INVALID_TEMPLATE: () => 'Image refusée : PNG invalide, trop grand ou sans pixel peignable.',
  // HTTP layer
  INVALID_REQUEST: () => 'Requête invalide (format inattendu).',
  NOT_FOUND: () => 'Route inconnue.',
  INTERNAL_ERROR: () => 'Erreur interne du moteur (voir le journal du serveur).',
  FORBIDDEN_ORIGIN: () => 'Origine non autorisée à piloter le moteur.',
  JSON_REQUIRED: () => 'Requête refusée : JSON attendu.',
  LEGACY_DISABLED: (m) => m,
  NETWORK: () => 'Serveur injoignable.',
  HTTP_429: () => 'Trop de requêtes : patientez un instant.',
  // Scheduler (status.recentErrors and the error state)
  BLOCKED: () => 'Du travail reste impossible pour l’agent : couleurs verrouillées ou pixels jamais observés.',
  AGENT_UNAVAILABLE: () => 'L’agent est indisponible sans date de fin.',
  ENERGY_NEVER_SUFFICIENT: () => 'L’agent n’accumule jamais assez d’énergie pour un lot.',
  JOURNAL_UNAVAILABLE: () => 'Le journal est dans un état inconnu : redémarrez GeoPlacer.',
  JOURNAL_DAMAGED: () => 'Journal endommagé : chaque bail exige une lecture de la toile qui le couvre.',
  PLAN_REFUSED: () => 'La planification a été refusée.',
  TEMPLATE_UNAVAILABLE: () => 'Le modèle ne peut pas être chargé.',
  CYCLE_BUDGET: () => 'Garde-fou : trop de cycles.',
  CANVAS_READ_FAILED: () => 'La toile n’a pas pu être lue.',
  RESOURCES_UNAVAILABLE: () => 'Les ressources n’ont pas pu être observées.',
  LEFT_UNCERTAIN: () => 'Une tentative reste ouverte : elle sera réconciliée au prochain démarrage.',
  PIXELS_REJECTED: (m) => {
    const p = /^(\d+) pixel/.exec(m);
    return p ? `${p[1]} pixel(s) refusé(s) par la toile.` : 'Des pixels ont été refusés par la toile.';
  },
  WRITE_UNCERTAIN: () => 'Écriture sans réponse fiable : la tentative sera réconciliée par une lecture de la toile.',
};

export const SETTING_LABELS: Record<string, string> = {
  width: 'Largeur de la toile',
  height: 'Hauteur de la toile',
  costPerPixel: 'Coût par pixel',
  capacity: 'Capacité d’énergie',
  regenIntervalMs: 'Régénération',
  writeLatencyMs: 'Latence d’écriture',
  startEnergy: 'Énergie de départ',
  startCurrency: 'Monnaie de départ',
  maxBatchSize: 'Lot maximal',
  minBatchSize: 'Lot minimal',
};

/** Reasons of the scheduler state (free texts): known patterns. */
const REASONS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^the canvas matches the template$/, () => 'La toile correspond au modèle.'],
  [/^recovering the journal$/, () => 'Reprise du journal.'],
  [/^pause requested$/, () => 'Pause demandée.'],
  [/^stop requested$/, () => 'Arrêt demandé.'],
  [/^stopped \(operation aborted\)$/, () => 'Arrêté (écriture interrompue, réconciliée).'],
  [/^a write ended without a reliable answer$/, () => 'Une écriture s’est terminée sans réponse fiable : réconciliation par lecture de la toile.'],
  [/^the canvas could not be read$/, () => 'La toile n’a pas pu être lue.'],
  [/^(\d+) attempt\(s\) still open, waiting for a covering canvas read$/, (m) => `${m[1]} tentative(s) encore ouverte(s), en attente d’une lecture de la toile qui les couvre.`],
  [/^the resources could not be observed$/, () => 'Les ressources n’ont pas pu être observées.'],
  [/^agent unavailable until (\d+)$/, (m) => `Agent indisponible jusqu’à ${time(m[1]!)}.`],
  [/^waiting for a newer observation \((.*)\)$/, () => 'En attente d’une observation plus récente des ressources.'],
  [/^waiting for the energy of (\d+) pixel\(s\)$/, (m) => `En attente de l’énergie de ${m[1]} pixel(s).`],
  [/^simulated world unavailable: ([A-Z_]+)$/, (m) => `Toile simulée indisponible (${m[1]}).`],
  [/^([A-Z_]+): ([\s\S]*)$/, (m) => translateError(m[1]!, m[2]!)],
];

const NOTICES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^simulated world reset$/, () => 'Monde simulé réinitialisé.'],
  [/^simulated upgrade applied: (.+)$/, (m) => `Amélioration simulée appliquée : ${UPGRADE_KINDS[m[1]!] ?? m[1]}.`],
];

export const UPGRADE_KINDS: Record<string, string> = {
  'max-energy': 'capacité d’énergie',
  'regen-speed': 'vitesse de régénération',
  'energy-pack': 'recharge d’énergie',
  'color-unlock': 'déblocage d’une couleur',
};

/** Why the remaining time cannot be estimated (EtaUnavailableCode). */
const ETA: Record<string, string> = {
  NO_AGENT: 'aucun agent capable de peindre',
  COLORS_UNAVAILABLE: 'des couleurs restantes ne sont pas débloquées',
  INSUFFICIENT_ENERGY: 'l’agent ne peut jamais réunir l’énergie d’un pixel',
  INVALID_PARAMETERS: 'paramètres ou ressources incohérents',
  INSUFFICIENT_OBSERVATION: 'trop peu de pixels observés',
  STALE_SNAPSHOT: 'lecture de la toile trop ancienne',
  STALE_RESOURCES: 'observation des ressources trop ancienne',
  OUT_OF_RANGE: 'durée hors limites',
};

/** Why an upgrade is impossible (UpgradeImpossibleCode). */
const UPGRADE_IMPOSSIBLE: Record<string, string> = {
  NOT_CONFIGURED: 'non prévue par les règles',
  MAX_LEVEL: 'niveau maximal atteint',
  NOT_UNLOCKABLE: 'couleur non débloquable',
  INSUFFICIENT_CURRENCY: 'monnaie simulée insuffisante',
  LIMIT_EXCEEDED: 'limite de dépense dépassée',
};

const VERDICTS: Record<string, string> = {
  empty: 'vide (aucune tentative enregistrée)',
  healthy: 'sain',
  'torn-tail': 'fin déchirée (dernière ligne interrompue, coupée à la reprise)',
  damaged: 'endommagé (voir le guide de diagnostic)',
  unreadable: 'illisible',
};

const fallback = (text: string): string => `${text} (message du moteur)`;

export function translateError(code: string, message: string): string {
  const t = ERRORS[code];
  return t === undefined ? fallback(`${message} [${code}]`) : t(message);
}

export function translateReason(reason: string | null): string | null {
  if (reason === null) return null;
  for (const [pattern, text] of REASONS) {
    const m = pattern.exec(reason);
    if (m) return text(m);
  }
  return fallback(reason);
}

export function translateNotice(message: string): string {
  for (const [pattern, text] of NOTICES) {
    const m = pattern.exec(message);
    if (m) return text(m);
  }
  return fallback(message);
}

export function translateEta(code: string, message: string): string {
  return ETA[code] ?? fallback(`${message} [${code}]`);
}

export function translateUpgradeImpossible(code: string, message: string): string {
  return UPGRADE_IMPOSSIBLE[code] ?? fallback(`${message} [${code}]`);
}

export function translateVerdict(verdict: string): string {
  return VERDICTS[verdict] ?? fallback(verdict);
}

export function translateProposalsUnavailable(text: string | null): string | null {
  if (text === null) return null;
  return /select a template/.test(text) ? 'Sélectionnez un modèle pour estimer l’effet d’une amélioration.' : fallback(text);
}

/** Codes translated by this table (tests: every code the engine can send must be here). */
export const TRANSLATED_ERROR_CODES: readonly string[] = Object.keys(ERRORS);
export const TRANSLATED_ETA_CODES: readonly string[] = Object.keys(ETA);
export const TRANSLATED_UPGRADE_CODES: readonly string[] = Object.keys(UPGRADE_IMPOSSIBLE);
