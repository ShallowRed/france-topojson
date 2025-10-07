#!/usr/bin/env node

/**
 * Script de téléchargement des données sources IGN
 * 
 * Ce script :
 * 1. Télécharge les archives Admin Express depuis la Géoplateforme IGN
 * 2. Extrait les fichiers Shapefile des archives 7z
 * 3. Organise les données par couche administrative (régions, départements, etc.)
 * 
 * Gestion des erreurs :
 * - Supporte plusieurs URLs miroirs en cas d'échec
 * - Évite les re-téléchargements si les fichiers existent déjà
 * - Affiche la progression en temps réel
 * 
 * Usage:
 *   node download.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { path7za } from '7zip-bin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Codes de couleur ANSI pour la sortie console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

/**
 * Affiche un message coloré dans la console
 * @param {string} message - Message à afficher
 * @param {string} color - Couleur du message
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Charger la configuration depuis config.json
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const execFileAsync = promisify(execFile);

/**
 * Crée les dossiers de travail s'ils n'existent pas
 * (sources, geojson, topojson)
 */
function ensureDirectories() {
  const dirs = [
    config.directories.sources,
    config.directories.geojson,
    config.directories.topojson
  ];

  dirs.forEach(dir => {
    const fullPath = path.join(__dirname, '..', dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      log(`[OK] Dossier créé: ${dir}`, 'green');
    }
  });
}

/**
 * Télécharge un fichier depuis une URL avec affichage de la progression
 * Gère automatiquement les redirections HTTP
 * 
 * @param {string} url - URL du fichier à télécharger
 * @param {string} destPath - Chemin de destination local
 * @param {Object} options - Options de téléchargement
 * @param {string} options.displayName - Nom à afficher (par défaut: nom du fichier)
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath, { displayName } = {}) {
  return new Promise((resolve, reject) => {
    const name = displayName ?? path.basename(destPath);
    log(`Téléchargement: ${name}`, 'blue');

    const file = fs.createWriteStream(destPath);

    https.get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        // Suivre les redirections
        return downloadFile(response.headers.location, destPath, { displayName: name })
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => { });
        return reject(new Error(`Téléchargement impossible (${response.statusCode})`));
      }

      const totalSize = Number(response.headers['content-length']);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\r  Progression: ${percent}%`);
        } else {
          const sizeMB = (downloadedSize / (1024 * 1024)).toFixed(1);
          process.stdout.write(`\r  Téléchargé: ${sizeMB} MB`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('');
        log(`✓ Téléchargé: ${path.basename(destPath)}`, 'green');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => { });
      reject(err);
    });
  });
}

async function downloadWithFallback(urls, destPath, displayName) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('Aucune URL de téléchargement définie.');
  }

  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await downloadFile(url, destPath, { displayName });
      return;
    } catch (error) {
      lastError = error;
      log(`Échec depuis ${url}: ${error.message}`, 'red');
      if (i < urls.length - 1) {
        log('↻ Tentative avec une URL alternative...', 'yellow');
      }
    }
  }

  throw lastError ?? new Error('Téléchargement impossible - toutes les URL ont échoué.');
}

// Extraire une archive 7z
async function extractArchive(archivePath, destDir) {
  log(`Extraction: ${path.basename(archivePath)}`, 'blue');

  try {
    fs.chmodSync(path7za, 0o755);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log(`Impossible d'ajuster les permissions de 7za: ${error.message}`, 'yellow');
    }
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  try {
    await execFileAsync(path7za, ['x', archivePath, '-y'], { cwd: destDir });
    process.stdout.write('\n');
    log(`✓ Extrait: ${path.basename(archivePath)}`, 'green');
  } catch (error) {
    process.stdout.write('\n');
    log(`Erreur d'extraction: ${error.message}`, 'red');
    throw error;
  }
}

// Télécharger et préparer les données pour un layer
async function processLayer(layer) {
  if (!layer.enabled) {
    log(`⊘ Layer désactivé: ${layer.name}`, 'yellow');
    return;
  }

  log(`\n${'='.repeat(50)}`, 'bright');
  log(`Processing: ${layer.label} (${layer.name})`, 'bright');
  log('='.repeat(50), 'bright');

  const sourcesDir = path.join(__dirname, '..', config.directories.sources);

  // Nom du fichier à télécharger
  const urls = layer.source.urls ?? (layer.source.url ? [layer.source.url] : []);
  const archiveName = layer.source.fileName ?? (urls[0] ? path.basename(urls[0]) : null);

  if (!archiveName) {
    throw new Error(`Nom de fichier introuvable pour le layer ${layer.name}. Ajoutez "fileName" ou une URL valide.`);
  }
  if (!urls.length) {
    throw new Error(`Aucune URL de téléchargement configurée pour ${layer.name}.`);
  }
  const archivePath = path.join(sourcesDir, archiveName);

  // Vérifier si le fichier existe déjà
  if (fs.existsSync(archivePath)) {
    log(`✓ Archive déjà téléchargée: ${archiveName}`, 'green');
  } else {
    await downloadWithFallback(urls, archivePath, archiveName);
  }

  // Extraire si c'est une archive
  if (layer.source.archive) {
    const extractDir = path.join(sourcesDir, layer.name);

    if (fs.existsSync(extractDir)) {
      log(`✓ Archive déjà extraite dans: ${layer.name}/`, 'green');
    } else {
      fs.mkdirSync(extractDir, { recursive: true });
      await extractArchive(archivePath, extractDir);
    }
  }

  log(`✓ Layer prêt: ${layer.name}`, 'green');
}

// Main
async function main() {
  log('\nFrance TopoJSON - Téléchargement des données\n', 'bright');

  ensureDirectories();

  // Traiter chaque layer
  for (const layer of config.layers) {
    try {
      await processLayer(layer);
    } catch (error) {
      log(`Erreur lors du traitement de ${layer.name}: ${error.message}`, 'red');
    }
  }

  log('\nTéléchargement terminé!', 'green');
  log('\nProchaine étape: npm run convert', 'yellow');
}

main().catch(error => {
  log(`\nErreur fatale: ${error.message}`, 'red');
  process.exit(1);
});
