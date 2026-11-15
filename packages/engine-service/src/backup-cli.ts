/**
 * Command line of the backups (Phase 1B.10). GeoPlacer must be stopped.
 *
 *   npm run backup                          sauvegarde de data\engine dans sauvegardes\
 *   npm run backup:verify -- <dossier>      vérifie une sauvegarde (lecture seule)
 *   npm run restore -- <dossier>            restaure (l'état actuel est conservé à côté)
 *   npm run restore -- --resume             termine ou annule une restauration interrompue
 *
 * Options: --data <dossier du moteur> (default GEOPLACER_ENGINE_DIR or data\engine),
 * --out <dossier des sauvegardes> (default sauvegardes\). Messages in French.
 */

import path from 'node:path';
import { BackupError, createBackup, restoreBackup, resumeRestore, verifyBackup } from './backup.js';

const MESSAGES: Record<string, string> = {
  ENGINE_RUNNING: 'GeoPlacer est en cours d’exécution sur ce dossier : arrêtez-le (Ctrl+C) puis recommencez.',
  BACKUP_CORRUPT: 'Sauvegarde corrompue ou incomplète : rien n’a été modifié.',
  BACKUP_INCOMPATIBLE: 'Sauvegarde faite par une version plus récente ou inconnue de GeoPlacer : rien n’a été modifié.',
  BACKUP_INCONSISTENT: 'Le contenu de la sauvegarde est incohérent : rien n’a été modifié.',
  RESTORE_IN_PROGRESS: 'Une restauration a été interrompue : lancez « npm run restore -- --resume ».',
  NOTHING_TO_RESUME: 'Aucune restauration interrompue pour ce dossier.',
  NOT_FOUND: 'Dossier introuvable.',
};

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  const env = process.env.GEOPLACER_ENGINE_DIR?.trim();
  const data = path.resolve(option(args, '--data') ?? (env !== undefined && env !== '' ? env : path.join('data', 'engine')));
  const envOut = process.env.GEOPLACER_BACKUP_DIR?.trim();
  const out = path.resolve(option(args, '--out') ?? (envOut !== undefined && envOut !== '' ? envOut : 'sauvegardes'));
  switch (command) {
    case 'backup': {
      const { dir, manifest } = await createBackup(data, out);
      console.log(`Sauvegarde créée : ${dir}`);
      console.log(`${manifest.summary.files} fichiers, ${Math.round(manifest.summary.bytes / 1024)} Kio ; modèle sélectionné : ${manifest.summary.selectedTemplate ?? 'aucun'}.`);
      return 0;
    }
    case 'verify': {
      const target = args[0];
      if (target === undefined) throw new Error('indiquez le dossier de la sauvegarde');
      const manifest = await verifyBackup(target);
      console.log(`Sauvegarde intègre : ${manifest.summary.files} fichiers vérifiés (SHA-256), créée le ${manifest.createdAt}.`);
      return 0;
    }
    case 'restore': {
      if (args.includes('--resume')) {
        const done = await resumeRestore(data);
        console.log(done === 'finished' ? 'Restauration interrompue terminée.' : done === 'rolled-back' ? 'Restauration interrompue annulée : les données précédentes sont remises en place.' : 'La restauration était déjà terminée.');
        return 0;
      }
      const source = args[0];
      if (source === undefined) throw new Error('indiquez le dossier de la sauvegarde à restaurer');
      const report = await restoreBackup(source, data);
      console.log(`Restauration terminée : ${report.restoredFiles} fichiers dans ${data}.`);
      if (report.previous !== null) console.log(`Les données précédentes sont conservées dans ${report.previous}.`);
      for (const w of report.warnings) console.log(`Avertissement : ${w}`);
      console.log('Au prochain démarrage, le moteur reprend le journal et réconcilie les tentatives interrompues.');
      return 0;
    }
    default:
      console.error('usage : backup | verify <dossier> | restore <dossier> | restore --resume  [--data <dossier du moteur>] [--out <dossier des sauvegardes>]');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof BackupError) {
      console.error(`${MESSAGES[error.code] ?? error.code} (${error.code})`);
      console.error(`Détail : ${error.message}`);
      process.exit(3);
    }
    console.error(`Échec : ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
