import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let modulePromise;
export function configurationModule() {
  return modulePromise ??= (async () => {
    const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/config/documents.ts');
    if (existsSync(local)) return import(pathToFileURL(local).href);
    const root = readFileSync(path.join(homedir(), '.flitterbot/source-root'), 'utf8').trim();
    if (!path.isAbsolute(root)) throw new Error('Invalid installed source-root');
    return import(pathToFileURL(path.join(root, 'src/config/documents.ts')).href);
  })();
}
export async function readConfiguration(name = 'runtime-config') {
  return (await configurationModule()).readConfiguration(name);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const [command = 'read', name = 'runtime-config', key] = process.argv.slice(2);
    if (!['runtime-config', 'whatsapp-config'].includes(name)) throw new Error('Unknown configuration');
    const api = await configurationModule();
    if (command === 'read') {
      const value = await api.readConfiguration(name);
      process.stdout.write(key ? String(value[key] ?? '') : JSON.stringify(value));
    } else if (command === 'export') {
      await api.withConfiguration(name, document => document.exportToFile());
    } else throw new Error('Expected read or export');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
