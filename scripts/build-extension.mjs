import { build } from 'esbuild';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import yazl from 'yazl';

const distDir = 'dist';
const outdir = join(distDir, 'extension');
await mkdir(outdir, { recursive: true });

await Promise.all([
  build({
    entryPoints: ['extension/src/background.ts', 'extension/src/content.ts', 'extension/src/popup.ts', 'extension/src/review.ts', 'extension/src/connection.ts'],
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    outdir,
  }),
  cp('extension/manifest.json', `${outdir}/manifest.json`),
  cp('extension/popup.html', `${outdir}/popup.html`),
  cp('extension/popup.css', `${outdir}/popup.css`),
  cp('extension/review.html', `${outdir}/review.html`),
  cp('extension/connection.html', `${outdir}/connection.html`),
  cp('extension/icon.svg', `${outdir}/icon.svg`),
  cp('extension/icon.png', `${outdir}/icon.png`),
  cp('extension/warning-icon.png', `${outdir}/warning-icon.png`),
]);

const { version } = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const zipPath = join(distDir, `tradovate-browser-bridge-extension-${version}.zip`);

async function addDirectoryToZip(zipFile, directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zipFile, fullPath, root);
      return;
    }
    zipFile.addFile(fullPath, join('extension', relative(root, fullPath)).replaceAll('\\', '/'));
  }));
}

await rm(zipPath, { force: true });
const zipFile = new yazl.ZipFile();
await addDirectoryToZip(zipFile, outdir, outdir);

await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  output.on('close', resolve);
  output.on('error', reject);
  zipFile.outputStream.on('error', reject).pipe(output);
  zipFile.end();
});
