#!/usr/bin/env node

/**
 * Script de conversion des Shapefiles en TopoJSON
 * 
 * Ce script :
 * 1. Localise les fichiers Shapefile extraits depuis les archives IGN
 * 2. Applique les transformations géométriques (projection, simplification)
 * 3. Génère les fichiers GeoJSON intermédiaires
 * 4. Convertit en TopoJSON pour optimisation
 * 
 * Usage:
 *   node convert.js                    # Convertir toutes les couches actives
 *   node convert.js --layer=regions    # Convertir uniquement les régions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Résoudre le binaire Mapshaper depuis node_modules
let mapshaperBin = null;
try {
  mapshaperBin = require.resolve('mapshaper/bin/mapshaper');
} catch {
  mapshaperBin = null;
}

// Codes de couleur ANSI pour la sortie console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

/**
 * Affiche un message coloré dans la console
 * @param {string} message - Message à afficher
 * @param {string} color - Couleur du message (green, red, yellow, etc.)
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Charger la configuration depuis config.json
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Parser les arguments de ligne de commande
const args = process.argv.slice(2);
const layerArg = args.find(arg => arg.startsWith('--layer='));
const specificLayer = layerArg ? layerArg.split('=')[1] : null;

/**
 * Vérifie que Mapshaper est disponible et fonctionnel
 * @returns {Promise<boolean>} true si Mapshaper est disponible
 */
async function checkMapshaper() {
  if (!mapshaperBin) {
    log('Mapshaper n\'est pas disponible dans node_modules', 'red');
    log('Astuce: exécutez `npm install` pour installer les dépendances locales.', 'yellow');
    return false;
  }
  try {
    const { stdout } = await execFileAsync(mapshaperBin, ['--version']);
    log(`✓ Mapshaper détecté: ${stdout.trim()}`, 'green');
    return true;
  } catch (error) {
    log('Impossible d\'utiliser Mapshaper depuis les dépendances du projet', 'red');
    if (error.stderr) {
      log(`Détails: ${error.stderr}`, 'red');
    }
    return false;
  }
}

/**
 * Execute Mapshaper avec les arguments fournis
 * @param {string[]} args - Arguments de ligne de commande pour Mapshaper
 * @param {Object} options - Options supplémentaires pour execFile
 * @returns {Promise} Résultat de l'exécution
 */
async function runMapshaper(args, options = {}) {
  if (!mapshaperBin) {
    throw new Error('Mapshaper non résolu - exécutez `npm install`.');
  }
  return execFileAsync(mapshaperBin, args, {
    maxBuffer: 1024 * 1024 * 100, // Buffer de 100MB pour les fichiers volumineux
    ...options
  });
}

/**
 * Recherche récursivement un fichier Shapefile dans un dossier
 * Les archives IGN ont une structure de dossiers imbriquée variable
 * @param {string} extractDir - Dossier racine où chercher
 * @param {string} shapefileName - Nom du fichier .shp à trouver
 * @returns {string|null} Chemin complet du fichier trouvé, ou null
 */
function findShapefile(extractDir, shapefileName) {
  function searchDir(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        const result = searchDir(fullPath);
        if (result) return result;
      } else if (file === shapefileName) {
        return fullPath;
      }
    }
    
    return null;
  }
  
  return searchDir(extractDir);
}

/**
 * Formate une taille de fichier en format lisible
 * @param {string} filePath - Chemin du fichier
 * @returns {string} Taille formatée (B, KB, ou MB)
 */
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  const bytes = stats.size;
  
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Convertit une couche administrative en TopoJSON avec différents niveaux de simplification
 * Pipeline : Shapefile → GeoJSON → TopoJSON
 * 
 * @param {Object} layer - Configuration de la couche depuis config.json
 */
async function convertLayer(layer) {
  if (!layer.enabled) {
    log(`⊘ Layer désactivé: ${layer.name}`, 'yellow');
    return;
  }
  
  log(`\n${'='.repeat(60)}`, 'bright');
  log(`Conversion: ${layer.label} (${layer.name})`, 'bright');
  log('='.repeat(60), 'bright');
  
  const sourcesDir = path.join(__dirname, '..', config.directories.sources);
  const geojsonDir = path.join(__dirname, '..', config.directories.geojson);
  const topojsonDir = path.join(__dirname, '..', config.directories.topojson);

  [sourcesDir, geojsonDir, topojsonDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  
  // Trouver le fichier shapefile
  const extractDir = path.join(sourcesDir, layer.name);
  const shapefilePath = findShapefile(extractDir, layer.source.shapefile);
  
  if (!shapefilePath) {
    log(`[ERREUR] Shapefile non trouvé: ${layer.source.shapefile}`, 'red');
    log(`   Vérifiez le dossier: ${extractDir}`, 'yellow');
    return;
  }
  
  log(`[OK] Shapefile trouvé: ${shapefilePath}`, 'green');
  log(`  Taille: ${getFileSize(shapefilePath)}`, 'cyan');
  
  // Traiter chaque niveau de simplification
  for (const simplification of layer.simplifications) {
    const outputName = `${layer.name}${simplification.suffix}`;
    const geojsonPath = path.join(geojsonDir, `${outputName}.json`);
    const topojsonPath = path.join(topojsonDir, `${outputName}.json`);
    
  log(`\n  -> ${simplification.description} (${simplification.level}%)`, 'blue');
    
    // Construire la commande mapshaper pour GeoJSON
    const geojsonArgs = ['-i', shapefilePath];
    if (config.options.snap) {
      geojsonArgs.push('snap');
    }
    geojsonArgs.push('-proj', layer.projection);

    const properties = (simplification.properties ?? layer.properties) || [];
    if (properties.length > 0) {
      geojsonArgs.push('-filter-fields', properties.join(','));
    }

    if (simplification.level < 100) {
      const simplifyArgs = ['-simplify', `${simplification.level}%`];
      if (config.options.method) {
        simplifyArgs.push(config.options.method);
      }
      if (config.options.keepShapes) {
        simplifyArgs.push('keep-shapes');
      }
      geojsonArgs.push(...simplifyArgs);
    }
    const precision = simplification.precision ?? layer.precision;
    geojsonArgs.push('-o', 'format=geojson', `precision=${precision}`, geojsonPath);
    
    try {
      log(`    Génération GeoJSON...`, 'cyan');
      await runMapshaper(geojsonArgs);
  log(`    [OK] GeoJSON créé: ${getFileSize(geojsonPath)}`, 'green');
      
      // Convertir GeoJSON en TopoJSON
      log(`    Conversion TopoJSON...`, 'cyan');
      const topojsonArgs = ['-i', geojsonPath, '-o', 'format=topojson', topojsonPath];
      await runMapshaper(topojsonArgs);
  log(`    [OK] TopoJSON créé: ${getFileSize(topojsonPath)}`, 'green');
      
      // Calculer le taux de compression
      const originalSize = fs.statSync(geojsonPath).size;
      const compressedSize = fs.statSync(topojsonPath).size;
      const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
  log(`    Compression: ${ratio}% (${getFileSize(topojsonPath)} vs ${getFileSize(geojsonPath)})`, 'cyan');
      
    } catch (error) {
  log(`    [ERREUR] ${error.message}`, 'red');
      if (error.stderr) {
        log(`    Détails: ${error.stderr}`, 'red');
      }
    }
  }
  
  log(`\n[OK] Layer terminé: ${layer.name}`, 'green');
}

// Main
async function main() {
  log('\nFrance TopoJSON - Conversion des données\n', 'bright');
  
  // Vérifier mapshaper
  const hasMapshaper = await checkMapshaper();
  if (!hasMapshaper) {
    process.exit(1);
  }
  
  // Filtrer les layers à traiter
  let layersToProcess = config.layers;
  if (specificLayer) {
    layersToProcess = config.layers.filter(l => l.name === specificLayer);
    if (layersToProcess.length === 0) {
      log(`Layer non trouvé: ${specificLayer}`, 'red');
      log(`Layers disponibles: ${config.layers.map(l => l.name).join(', ')}`, 'yellow');
      process.exit(1);
    }
  } else {
    layersToProcess = layersToProcess.filter(l => l.enabled);
  }
  
  // Traiter chaque layer
  for (const layer of layersToProcess) {
    try {
      await convertLayer(layer);
    } catch (error) {
      log(`Erreur lors du traitement de ${layer.name}: ${error.message}`, 'red');
    }
  }
  
  log('\nConversion terminée!', 'green');
  log(`\nFichiers générés dans: ${config.directories.topojson}/`, 'yellow');
}

main().catch(error => {
  log(`\nErreur fatale: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
