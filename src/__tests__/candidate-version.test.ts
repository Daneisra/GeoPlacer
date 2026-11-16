import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
describe('consolidated GeoPlacer candidate identity', () => {
  it('keeps package and root lockfile at 6.0.0-rc.1 with the GeoPlacer name and AGPL attribution', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string; license: string; author: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { name: string; version: string; packages: Record<string, { name: string; version: string }> };
    expect([pkg.version, lock.version, lock.packages['']!.version]).toEqual(['6.0.0-rc.1', '6.0.0-rc.1', '6.0.0-rc.1']);
    expect([pkg.name, lock.name, lock.packages['']!.name]).toEqual(['geoplacer', 'geoplacer', 'geoplacer']);
    expect(pkg.license).toBe('AGPL-3.0-only');
    expect(pkg.author).toMatch(/JinxTheCatto.*luluwaffless/);
  });
  it('derives Swagger and the server banner from package.json, and presents GeoPlacer in the main UI', () => {
    const server = readFileSync(path.join(root, 'src/server.ts'), 'utf8');
    expect(server).toContain('version: APP_VERSION');
    expect(server).toContain("'package.json'");
    const sidebar = readFileSync(path.join(root, 'frontend/src/components/Sidebar.tsx'), 'utf8');
    expect(sidebar).toContain('>GeoPlacer</span>');
    expect(sidebar).toContain('Issu de wplacer');
    expect(sidebar).not.toContain('alt="wplacer"');
    expect(readFileSync(path.join(root, 'frontend/index.html'), 'utf8')).toContain('<title>GeoPlacer');
  });
});
