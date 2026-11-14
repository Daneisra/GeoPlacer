/**
 * Child process of the corruption/repair cycle test: opens the data
 * directory, says "ready", then repairs the template (the parent may kill
 * it at any moment, also in the middle of the repair).
 * argv: <storage root> <templateId>
 */

import { asProjectId, type TemplateId } from '@geoplacer/core';
import { openNodeTemplateManager } from '../../src/index.js';

const [root, templateId] = process.argv.slice(2);
if (root === undefined || templateId === undefined) throw new Error('usage: repair-child <root> <templateId>');
const { manager, close } = await openNodeTemplateManager(root);
process.stdout.write('ready\n');
const report = await manager.repair({ projectId: asProjectId('projet-kill'), templateId: templateId as TemplateId }, { apply: true });
process.stdout.write(`repaired ${report.action} ${report.generation}\n`);
await close();
