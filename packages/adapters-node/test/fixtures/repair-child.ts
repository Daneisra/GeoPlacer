/**
 * Child process of the corruption/repair cycle test: opens the data
 * directory, then repairs the template and KILLS ITSELF at the named
 * storage step of the repair (Phase 1B.8: no timer). With the step "none",
 * the repair runs to its end.
 * argv: <storage root> <templateId> <step|none>
 */

import { asProjectId, type TemplateId } from '@geoplacer/core';
import { openNodeTemplateManager } from '../../src/index.js';
import { stepKiller } from './step-kill.js';

const [root, templateId, step] = process.argv.slice(2);
if (root === undefined || templateId === undefined || step === undefined) throw new Error('usage: repair-child <root> <templateId> <step|none>');
const killer = step === 'none' ? null : stepKiller(step);
const { manager, close } = await openNodeTemplateManager(root, killer === null ? {} : { storage: { onStep: killer.onStep } });
process.stdout.write('ready\n');
killer?.arm();
const report = await manager.repair({ projectId: asProjectId('projet-kill'), templateId: templateId as TemplateId }, { apply: true });
process.stdout.write(`repaired ${report.action} ${report.generation}\n`);
await close();
